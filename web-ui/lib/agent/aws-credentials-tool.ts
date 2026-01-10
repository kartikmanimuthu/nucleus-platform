import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamoDBDocumentClient, APP_TABLE_NAME, DEFAULT_TENANT_ID } from '../aws-config';

/**
 * AWS Credentials Tool
 * 
 * This tool fetches temporary AWS credentials for a specific account
 * by assuming the IAM role stored in DynamoDB for that account.
 * 
 * The credentials are returned to the model so it can execute AWS CLI
 * commands or SDK calls against the target account.
 */

// Helper to build PK/SK for accounts
const buildAccountPK = (tenantId: string) => `TENANT#${tenantId}`;
const buildAccountSK = (accountId: string) => `ACCOUNT#${accountId}`;

interface AWSCredentials {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    region: string;
    accountId: string;
    accountName: string;
    expiresAt: string;
}

/**
 * Fetch account details from DynamoDB
 */
async function getAccountFromDynamoDB(accountId: string, tenantId: string = DEFAULT_TENANT_ID) {
    const command = new GetCommand({
        TableName: APP_TABLE_NAME,
        Key: {
            pk: buildAccountPK(tenantId),
            sk: buildAccountSK(accountId)
        }
    });

    const response = await getDynamoDBDocumentClient().send(command);
    return response.Item;
}

/**
 * Assume role and get temporary credentials
 */
async function assumeRoleForAccount(
    roleArn: string,
    externalId?: string,
    sessionName: string = 'NucleusDevOpsAgentSession'
): Promise<{ credentials: any; expiration: Date }> {
    const stsClient = new STSClient({
        region: process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'us-east-1'
    });

    const assumeRoleCommand = new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: sessionName,
        ExternalId: externalId,
        DurationSeconds: 3600, // 1 hour
    });

    const response = await stsClient.send(assumeRoleCommand);

    if (!response.Credentials) {
        throw new Error('Failed to obtain temporary credentials from STS');
    }

    return {
        credentials: response.Credentials,
        expiration: response.Credentials.Expiration || new Date(Date.now() + 3600000)
    };
}

/**
 * Get AWS Credentials Tool
 * 
 * Fetches temporary AWS credentials for the specified account.
 * Returns credentials that can be used with AWS CLI or SDK.
 */
export const getAwsCredentialsTool = tool(
    async ({ accountId }: { accountId: string }): Promise<string> => {
        console.log(`[Tool] Getting AWS credentials for account: ${accountId}`);

        if (!accountId || accountId.trim() === '') {
            return JSON.stringify({
                error: 'No account ID provided. Please select an AWS account before performing AWS operations.',
                success: false
            });
        }

        try {
            // 1. Fetch account details from DynamoDB
            const account = await getAccountFromDynamoDB(accountId);

            if (!account) {
                return JSON.stringify({
                    error: `Account ${accountId} not found in the system. Please ensure the account is registered.`,
                    success: false
                });
            }

            if (!account.roleArn) {
                return JSON.stringify({
                    error: `Account ${accountId} does not have an IAM Role ARN configured. Please update the account configuration.`,
                    success: false
                });
            }

            if (!account.active) {
                return JSON.stringify({
                    error: `Account ${accountId} is currently inactive. Please activate the account before use.`,
                    success: false
                });
            }

            // 2. Assume the role to get temporary credentials
            const { credentials, expiration } = await assumeRoleForAccount(
                account.roleArn,
                account.externalId
            );

            // 3. Determine region (use first region from account, or default)
            const region = account.regions?.[0] || process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION || 'us-east-1';

            // 4. Return credentials as JSON string
            const result: AWSCredentials = {
                accessKeyId: credentials.AccessKeyId!,
                secretAccessKey: credentials.SecretAccessKey!,
                sessionToken: credentials.SessionToken!,
                region: region,
                accountId: accountId,
                accountName: account.accountName || account.name || accountId,
                expiresAt: expiration.toISOString()
            };

            console.log(`[Tool] Successfully obtained credentials for account: ${accountId}`);
            console.log(`[Tool] Credentials expire at: ${result.expiresAt}`);

            return JSON.stringify({
                success: true,
                credentials: result,
                message: `Successfully obtained temporary AWS credentials for account "${result.accountName}" (${accountId}). These credentials are valid until ${result.expiresAt}.`,
                usage: `To use these credentials with AWS CLI, set the following environment variables before running commands:
export AWS_ACCESS_KEY_ID="${result.accessKeyId}"
export AWS_SECRET_ACCESS_KEY="${result.secretAccessKey}"
export AWS_SESSION_TOKEN="${result.sessionToken}"
export AWS_REGION="${result.region}"`
            });

        } catch (error: any) {
            console.error(`[Tool] Error getting credentials for account ${accountId}:`, error);

            let errorMessage = error.message || 'Unknown error occurred';

            // Provide more helpful error messages
            if (error.name === 'AccessDenied' || errorMessage.includes('AccessDenied')) {
                errorMessage = `Access denied when assuming role for account ${accountId}. Verify that the trust policy allows this role to be assumed.`;
            } else if (error.name === 'MalformedPolicyDocument') {
                errorMessage = `Invalid role configuration for account ${accountId}. Check the IAM role ARN format.`;
            }

            return JSON.stringify({
                error: errorMessage,
                success: false
            });
        }
    },
    {
        name: 'get_aws_credentials',
        description: `Fetch temporary AWS credentials for a specific AWS account. 
This tool retrieves the IAM role from the account configuration in DynamoDB and uses STS AssumeRole to obtain temporary credentials.
Returns access key, secret key, session token, and region that can be used with AWS CLI or SDK.
IMPORTANT: You MUST call this tool before executing any AWS CLI commands if an account is selected.
The returned credentials should be exported as environment variables before running AWS commands.`,
        schema: z.object({
            accountId: z.string().describe('The AWS account ID (12-digit number) to get credentials for'),
        }),
    }
);

/**
 * Utility function to generate AWS CLI prefix with credentials
 * This can be used by other tools to prepend credential exports to commands
 */
export function generateAwsCredentialPrefix(credentials: AWSCredentials): string {
    return `AWS_ACCESS_KEY_ID="${credentials.accessKeyId}" AWS_SECRET_ACCESS_KEY="${credentials.secretAccessKey}" AWS_SESSION_TOKEN="${credentials.sessionToken}" AWS_REGION="${credentials.region}"`;
}
