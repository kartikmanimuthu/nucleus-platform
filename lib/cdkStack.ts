import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { RemovalPolicy } from 'aws-cdk-lib';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';

export class CdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // *******************************************************************
    // Environment variables
    // *******************************************************************

    const SCHEDULER_NAME = this.node.tryGetContext('scheduler').name;
    const SCHEDULE_INTERVAL = this.node.tryGetContext('scheduler').scheduleInterval;
    const CROSS_ACCOUNT_ROLE_NAME = this.node.tryGetContext('scheduler').crossAccountRoleName;
    const SCHEDULER_TAG = this.node.tryGetContext('scheduler').schedulerTag;
    const subscriptionEmails = this.node.tryGetContext('subscriptionEmails');

    // Generate schedule expression based on the interval
    const SCHEDULE_EXPRESSION = this.generateScheduleExpression(SCHEDULE_INTERVAL);

    // *******************************************************************
    // DynamoDB Table and Scheduler Lambda
    // *******************************************************************

    const stackName = `${SCHEDULER_NAME}`;

    // 1. Nucleus App Table (Single Table Design)
    const appTable = new dynamodb.Table(this, 'NucleusAppTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      tableName: `${stackName}-app-table`,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Add GSI1
    appTable.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
    });

    // 2. Nucleus Audit Table
    const auditTable = new dynamodb.Table(this, 'NucleusAuditTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      tableName: `${stackName}-audit-table`,
      timeToLiveAttribute: 'expire_at',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Add GSI1 for Global/Recent logs
    auditTable.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
    });

    // IAM Policy for Lambda
    const lambdaPolicy = new iam.Policy(this, 'LambdaPolicy', {
      policyName: `${stackName}-lambda-policy`,
      statements: [
        new iam.PolicyStatement({
          actions: [
            "dynamodb:GetItem",
            "dynamodb:Scan",
            "dynamodb:Query",
            "dynamodb:PutItem",
            "dynamodb:UpdateItem",
            "dynamodb:DeleteItem",
            "dynamodb:BatchWriteItem"
          ],
          resources: [
            appTable.tableArn,
            `${appTable.tableArn}/index/*`,
            auditTable.tableArn,
            `${auditTable.tableArn}/index/*`
          ],
        }),
      ],
    });

    // IAM Role for Lambda
    const timestamp = new Date().getTime();
    const randomSuffix = crypto.randomBytes(4).toString('hex');
    const lambdaRoleName = `${stackName}-lambda-role-${timestamp}-${randomSuffix}`;

    const lambdaRole = new iam.Role(this, 'LambdaRole', {
      roleName: lambdaRoleName,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Attach policy to the role
    lambdaRole.attachInlinePolicy(lambdaPolicy);

    // New Policy Statement to allow assuming any role
    const assumeRolePolicy = new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [`arn:aws:iam::*:role/${CROSS_ACCOUNT_ROLE_NAME}`],
      effect: iam.Effect.ALLOW,
    });

    // Attach the assume role policy to the Lambda role
    lambdaRole.addToPolicy(assumeRolePolicy);

    // Create an SNS Topic
    const snsTopic = new sns.Topic(this, 'SchedulerSNSTopic', {
      topicName: `${stackName}-sns-topic`,
    });

    // Add email subscriptions to the SNS topic
    subscriptionEmails.forEach((email: string) => {
      snsTopic.addSubscription(new sns_subscriptions.EmailSubscription(email));
    });

    // Lambda Function
    const lambdaFunction = new lambda.Function(this, 'Lambda', {
      functionName: `${stackName}-function`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/scheduler'),
      environment: {
        APP_TABLE_NAME: appTable.tableName,
        AUDIT_TABLE_NAME: auditTable.tableName,
        CROSS_ACCOUNT_ROLE_ARN: lambdaRole.roleArn,
        SCHEDULER_TAG: SCHEDULER_TAG,
        SNS_TOPIC_ARN: snsTopic.topicArn,
      },
      role: lambdaRole,
      timeout: cdk.Duration.minutes(15), // Set timeout to 15 minutes (maximum allowed)
    });

    // Apply removal policies to the underlying CfnResources
    (lambdaRole.node.defaultChild as cdk.CfnResource).applyRemovalPolicy(RemovalPolicy.DESTROY);
    (lambdaFunction.node.defaultChild as cdk.CfnResource).applyRemovalPolicy(RemovalPolicy.DESTROY);

    // CloudWatch Event Rule
    const rule = new events.Rule(this, 'LambdaTriggerRule', {
      ruleName: `${stackName}-rule`,
      schedule: events.Schedule.expression(this.generateScheduleExpressionIST(SCHEDULE_INTERVAL)),
    });

    // Add Lambda function as the target of the rule
    rule.addTarget(new targets.LambdaFunction(lambdaFunction));

    // Add SNS publish permissions to Lambda IAM policy
    lambdaPolicy.addStatements(new iam.PolicyStatement({
      actions: ['sns:Publish'],
      resources: [snsTopic.topicArn],
    }));

    // Grant Lambda permission to publish to SNS topic
    snsTopic.grantPublish(lambdaFunction);


    // *******************************************************************
    // Seeder Logic - COMMENTED OUT FOR REFACTOR
    // *******************************************************************

    /*
    // Load scheduler metadata from JSON files
    const schedulerMetadataPath = path.join(__dirname, "/../", 'scheduler_metadata.json');
    const accountMetadataPath = path.join(__dirname, "/../", 'account_metadata.json');

    const schedulerMetadataContent = fs.readFileSync(schedulerMetadataPath, 'utf8');
    const accountMetadataContent = fs.readFileSync(accountMetadataPath, 'utf8');

    const schedulerMetadata = JSON.parse(schedulerMetadataContent);
    const accountMetadata = JSON.parse(accountMetadataContent);

    // Merge the two metadata arrays
    const mergedMetadata = [...schedulerMetadata, ...accountMetadata];

    // Calculate hash of merged metadata
    const metadataHash = crypto.createHash('md5').update(JSON.stringify(mergedMetadata)).digest('hex');

    // Rest of the code remains the same
    const tableSeederFunction = new lambda.Function(this, 'TableSeederFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/metadata-seeder'),
      environment: {
        DYNAMODB_TABLE_NAME: table.tableName,
      },
      timeout: cdk.Duration.minutes(15), // Set timeout to 15 minutes (maximum allowed)
    });

    // Grant the Lambda function permission to read and write to the DynamoDB table
    table.grantReadWriteData(tableSeederFunction);

    // Create a custom resource that will trigger the Lambda function
    const customResourceRandomSuffix = crypto.randomBytes(4).toString('hex');
    const customResourceRoleName = `${stackName}-custom-resource-role-${customResourceRandomSuffix}`;

    const customResourceRole = new iam.Role(this, 'CustomResourceRole', {
      roleName: customResourceRoleName,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    tableSeederFunction.grantInvoke(customResourceRole);

    new cr.AwsCustomResource(this, 'TableSeederCustomResource', {
      onUpdate: {
        service: 'Lambda',
        action: 'invoke',
        parameters: {
          FunctionName: tableSeederFunction.functionName,
          Payload: JSON.stringify({
            metadata: mergedMetadata,
            metadataHash: metadataHash,
          }),
        },
        physicalResourceId: cr.PhysicalResourceId.of(metadataHash),
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [tableSeederFunction.functionArn],
        }),
      ]),
      role: customResourceRole,
    });


    // Apply removal policy to the Table Seeder Lambda function
    (tableSeederFunction.node.defaultChild as cdk.CfnResource).applyRemovalPolicy(RemovalPolicy.DESTROY);

    // Ensure the Custom Resource Role is deleted when the stack is destroyed
    customResourceRole.applyRemovalPolicy(RemovalPolicy.DESTROY);

    tableSeederFunction.grantInvoke(customResourceRole);
    */

    // *******************************************************************
    // Outputs
    // *******************************************************************


    new cdk.CfnOutput(this, 'LambdaFunctionName', {
      value: lambdaFunction.functionName,
      description: 'The name of the Lambda function'
    });

    new cdk.CfnOutput(this, 'LambdaFunctionArn', {
      value: lambdaFunction.functionArn,
      description: 'The ARN of the Lambda function'
    });

    new cdk.CfnOutput(this, 'AppTableName', {
      value: appTable.tableName,
      description: 'The name of the App DynamoDB table'
    });

    new cdk.CfnOutput(this, 'AuditTableName', {
      value: auditTable.tableName,
      description: 'The name of the Audit DynamoDB table'
    });

    new cdk.CfnOutput(this, 'LambdaLogGroupName', {
      value: lambdaFunction.logGroup.logGroupName,
      description: 'The name of the Lambda log group'
    });

    new cdk.CfnOutput(this, 'CloudWatchRuleName', {
      value: rule.ruleName,
      description: 'The name of the CloudWatch rule'
    });

    // Output the AWS Account ID
    new cdk.CfnOutput(this, 'AwsAccountId', {
      value: cdk.Aws.ACCOUNT_ID,
      description: 'The AWS Account ID'
    });

    // Output the AWS Region
    new cdk.CfnOutput(this, 'AwsRegion', {
      value: cdk.Aws.REGION,
      description: 'The AWS Region'
    });

    new cdk.CfnOutput(this, 'StackName', {
      value: stackName,
      description: 'The unique stack name'
    });

    // Output for Cross Account Role Name
    new cdk.CfnOutput(this, 'CrossAccountRoleName', {
      value: CROSS_ACCOUNT_ROLE_NAME,
      description: 'The name of the Cross Account Role'
    });

    new cdk.CfnOutput(this, 'SNSTopicArn', {
      value: snsTopic.topicArn,
      description: 'The ARN of the SNS topic',
    });

  }

  private generateScheduleExpression(interval: number): string {
    switch (interval) {
      case 5:
        // Run every 5 minutes (0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55)
        return 'cron(0/5 * * * ? *)';
      case 15:
        // Run every 15 minutes (0, 15, 30, 45)
        return 'cron(0,15,30,45 * * * ? *)';
      case 30:
        // Run every 30 minutes (0, 30)
        return 'cron(0,30 * * * ? *)';
      case 60:
        // Run at the top of every hour
        return 'cron(0 * * * ? *)';
      default:
        throw new Error(`Invalid schedule interval: ${interval}. Supported values are 5, 15, 30, and 60 minutes.`);
    }
  }

  // New method for IST cron expressions
  private generateScheduleExpressionIST(interval: number): string {
    // IST is UTC+5:30, so we need to adjust the hour accordingly
    switch (interval) {
      case 5:
        // Run every 5 minutes (0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55)
        return 'cron(0/5 * * * ? *)';
      case 15:
        // Run every 15 minutes (0, 15, 30, 45)
        return 'cron(0,15,30,45 * * * ? *)';
      case 30:
        // Run every 30 minutes (0, 30)
        return 'cron(0,30 * * * ? *)';
      case 60:
        // Run at the top of every hour in IST
        // Since CloudWatch Events use UTC, we need to adjust for IST (UTC+5:30)
        // For hourly jobs, we can simply run at 30 minutes past each hour in UTC
        // which will be on the hour in IST
        return 'cron(30 * * * ? *)';
      default:
        throw new Error(`Invalid schedule interval: ${interval}. Supported values are 5, 15, 30, and 60 minutes.`);
    }
  }
}
