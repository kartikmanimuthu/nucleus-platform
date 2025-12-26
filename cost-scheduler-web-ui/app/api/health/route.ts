import { NextResponse } from 'next/server';
import { getDynamoDBDocumentClient, DYNAMODB_TABLE_NAME } from '@/lib/aws-config';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';

interface HealthCheck {
    status: string;
    timestamp: string;
    service: string;
    environment: string;
    aws: {
        region: string | undefined;
        tableName: string;
        isLambda: boolean;
        dynamodb?: string | { status: string; error: string };
    };
}

export async function GET() {
    const healthCheck: HealthCheck = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        service: 'cost-scheduler-web-ui',
        environment: process.env.NODE_ENV || 'development',
        aws: {
            region: process.env.AWS_REGION || process.env.NEXT_PUBLIC_AWS_REGION,
            tableName: DYNAMODB_TABLE_NAME,
            isLambda: !!process.env.AWS_LAMBDA_FUNCTION_NAME,
        }
    };

    try {
        // Test DynamoDB connectivity
        try {
            const client = await getDynamoDBDocumentClient();
            const command = new ScanCommand({
                TableName: DYNAMODB_TABLE_NAME,
                Limit: 1
            });

            await client.send(command);
            healthCheck.aws.dynamodb = 'connected';
        } catch (dynamoError) {
            console.error('DynamoDB health check failed:', dynamoError);
            healthCheck.aws.dynamodb = {
                status: 'error',
                error: dynamoError instanceof Error ? dynamoError.message : 'Unknown error'
            };
            healthCheck.status = 'degraded';
        }

        return NextResponse.json(healthCheck, {
            status: healthCheck.status === 'healthy' ? 200 : 207
        });
    } catch (error) {
        console.error('Health check failed:', error);
        return NextResponse.json(
            {
                status: 'unhealthy',
                timestamp: new Date().toISOString(),
                error: error instanceof Error ? error.message : 'Unknown error',
                aws: healthCheck.aws
            },
            { status: 500 }
        );
    }
}

export async function HEAD() {
    return new NextResponse(null, { status: 200 });
}
