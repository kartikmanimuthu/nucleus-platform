const AWS = require('aws-sdk');

/**
 * Lambda Audit Logger for tracking scheduler operations
 */
class LambdaAuditLogger {
    constructor(tableName, region) {
        this.tableName = tableName;
        this.region = region;
        this.dynamoDB = new AWS.DynamoDB.DocumentClient({ region });
    }

    /**
     * Create an audit log entry in DynamoDB
     */
    async createAuditLog(auditData) {
        const timestamp = new Date().toISOString();
        // TTL: 90 days from now
        const expireAt = Math.floor(Date.now() / 1000) + (90 * 24 * 60 * 60);

        const user = auditData.user || 'system';
        const eventType = auditData.eventType || 'unknown';

        const auditLog = {
            pk: `LOG#${`audit-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`}`,
            sk: timestamp,
            gsi1pk: 'TYPE#LOG',
            gsi1sk: timestamp,
            gsi2pk: `USER#${user}`,
            gsi2sk: timestamp,
            gsi3pk: `EVENT#${eventType}`,
            gsi3sk: timestamp,
            expire_at: expireAt,
            id: `audit-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type: 'audit_log',
            timestamp: timestamp,
            ...auditData,
        };

        try {
            await this.dynamoDB.put({
                TableName: this.tableName,
                Item: auditLog,
            }).promise();
        } catch (error) {
            console.error('Failed to create audit log:', error);
            // Don't throw error to prevent audit logging from breaking the main process
        }
    }

    /**
     * Log execution events (start, end, phases)
     */
    async logExecution({ phase, status = 'info', details, correlationId, executionId, metadata = {} }) {
        await this.createAuditLog({
            eventType: 'execution',
            action: `Scheduler ${phase}`,
            user: 'lambda-scheduler',
            userType: 'system',
            resource: 'Cost Scheduler',
            resourceType: 'system',
            resourceId: 'scheduler',
            status,
            details,
            correlationId,
            executionId,
            metadata: {
                phase,
                ...metadata,
            },
        });
    }

    /**
     * Log role assumption events
     */
    async logRoleAssumption({
        status,
        details,
        accountId,
        region,
        roleArn,
        sessionName,
        duration,
        correlationId,
        executionId,
        metadata = {}
    }) {
        await this.createAuditLog({
            eventType: 'authentication',
            action: 'Assume Role',
            user: 'lambda-scheduler',
            userType: 'system',
            resource: roleArn,
            resourceType: 'iam_role',
            resourceId: roleArn.split('/').pop(),
            status,
            details,
            correlationId,
            executionId,
            accountId,
            region,
            metadata: {
                roleArn,
                sessionName,
                duration,
                ...metadata,
            },
        });
    }

    /**
     * Log batch processing results
     */
    async logBatchProcessing({
        resourceType,
        status,
        details,
        totalResources,
        successCount,
        failureCount,
        skippedCount,
        processingTimeMs,
        errors = [],
        correlationId,
        executionId,
        accountId,
        region
    }) {
        await this.createAuditLog({
            eventType: 'batch_processing',
            action: `Process ${resourceType} Resources`,
            user: 'lambda-scheduler',
            userType: 'system',
            resource: `${resourceType} Batch`,
            resourceType: resourceType.toLowerCase(),
            resourceId: `batch-${correlationId}`,
            status,
            details,
            correlationId,
            executionId,
            accountId,
            region,
            metadata: {
                totalResources,
                successCount,
                failureCount,
                skippedCount,
                processingTimeMs,
                errors,
            },
        });
    }

    /**
     * Log resource state changes (start/stop instances, services, etc.)
     */
    async logResourceStateChange({
        action,
        resourceType,
        resourceId,
        resourceName,
        status,
        details,
        previousState,
        newState,
        scheduleTag,
        scheduleName,
        correlationId,
        executionId,
        accountId,
        region,
        metadata = {}
    }) {
        await this.createAuditLog({
            eventType: 'resource_state_change',
            action,
            user: 'lambda-scheduler',
            userType: 'system',
            resource: resourceName || resourceId,
            resourceType: resourceType.toLowerCase(),
            resourceId,
            status,
            details,
            correlationId,
            executionId,
            accountId,
            region,
            metadata: {
                previousState,
                newState,
                scheduleTag,
                scheduleName,
                ...metadata,
            },
        });
    }

    /**
     * Log error events
     */
    async logError({
        errorMessage,
        errorType,
        component,
        functionName,
        correlationId,
        executionId,
        context = {}
    }) {
        await this.createAuditLog({
            eventType: 'error',
            action: 'Error Occurred',
            user: 'lambda-scheduler',
            userType: 'system',
            resource: component,
            resourceType: 'system',
            resourceId: functionName,
            status: 'error',
            details: errorMessage,
            correlationId,
            executionId,
            metadata: {
                errorType,
                component,
                functionName,
                context,
            },
        });
    }
}

module.exports = { LambdaAuditLogger };