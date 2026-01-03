#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CdkStack } from '../lib/cdkStack';
import { WebUIStack } from '../lib/webUIStack';

const app = new cdk.App();

// Read configuration from context
const awsAccountId = app.node.tryGetContext('awsAccountId');
const awsRegion = app.node.tryGetContext('awsRegion');

if (!awsAccountId || !awsRegion) {
  throw new Error('AWS Account ID and Region must be specified in cdk.context.json');
}

console.log(`Deploying to Account: ${awsAccountId}, Region: ${awsRegion}`);

// Create both stacks in the same app
const costEfficientSchedulerStack = new CdkStack(app, 'CostEfficientSchedulerStack', {
  env: { account: awsAccountId, region: awsRegion },
});

new WebUIStack(app, 'WebUIStack', {
  env: { account: awsAccountId, region: awsRegion },
  schedulerLambdaArn: costEfficientSchedulerStack.schedulerLambdaFunctionArn,
});