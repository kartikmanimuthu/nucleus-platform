// DynamoDB service for audit log operations
import { ScanCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamoDBDocumentClient, AUDIT_TABLE_NAME, handleDynamoDBError } from './aws-config';
import { AuditLog } from './types';

export interface AuditLogFilters {
    startDate?: string;
    endDate?: string;
    eventType?: string;
    status?: string;
    severity?: string;
    userType?: string;
    resourceType?: string;
    user?: string;
    correlationId?: string;
    searchTerm?: string;
    limit?: number;
}

export interface AuditLogStats {
    totalLogs: number;
    successCount: number;
    errorCount: number;
    warningCount: number;
    systemEvents: number;
    userEvents: number;
    criticalEvents: number;
    byEventType: Record<string, number>;
    byStatus: Record<string, number>;
    bySeverity: Record<string, number>;
    byResourceType: Record<string, number>;
}

export class AuditService {
    /**
     * Create a new audit log entry
     */
    static async createAuditLog(auditData: Omit<AuditLog, 'id' | 'type' | 'timestamp'>): Promise<void> {
        try {
            if (process.env.NODE_ENV === 'development' && process.env.SKIP_AUDIT_LOGGING === 'true') {
                return;
            }

            // Check if auditData is a string
            if (typeof auditData === 'string') {
                try {
                    auditData = JSON.parse(auditData);
                } catch (parseError) {
                    console.error('AuditService - Failed to parse audit data string:', parseError);
                    return;
                }
            }

            if (!auditData || typeof auditData !== 'object' || Object.keys(auditData).length === 0) {
                return;
            }

            const cleanedAuditData = this.validateAndCleanAuditData(auditData);
            const auditId = this.generateAuditId();
            const timestamp = new Date().toISOString();

            // TTL: 90 days from now
            const expireAt = Math.floor(Date.now() / 1000) + (90 * 24 * 60 * 60);

            const auditLogItem = {
                pk: `LOG#${auditId}`,
                sk: timestamp,
                gsi1pk: 'TYPE#LOG',
                gsi1sk: timestamp,
                expire_at: expireAt,

                // Attributes
                id: auditId,
                timestamp: timestamp,
                ...cleanedAuditData
            };

            const command = new PutCommand({
                TableName: AUDIT_TABLE_NAME,
                Item: auditLogItem
            });

            await getDynamoDBDocumentClient().send(command);
            console.log('AuditService - Successfully created audit log:', auditId);

        } catch (error: unknown) {
            console.error('AuditService - Error creating audit log:', error);
        }
    }

    /**
     * Fetch audit logs with optional filters
     */
    static async getAuditLogs(filters?: AuditLogFilters): Promise<AuditLog[]> {
        try {
            console.log('AuditService - Fetching audit logs with filters:', filters);

            let command;
            const limit = filters?.limit || 1000;

            // Use GSI1 for time-based queries if possible, otherwise Scan
            if (filters?.startDate && !filters?.endDate) {
                // Query GSI1: pk=TYPE#LOG and sk >= startDate
                command = new QueryCommand({
                    TableName: AUDIT_TABLE_NAME,
                    IndexName: 'GSI1',
                    KeyConditionExpression: 'gsi1pk = :pkVal AND gsi1sk >= :startDate',
                    ExpressionAttributeValues: {
                        ':pkVal': 'TYPE#LOG',
                        ':startDate': filters.startDate
                    },
                    ScanIndexForward: false, // Descending by timestamp
                    Limit: limit
                });
            } else if (filters?.startDate && filters?.endDate) {
                command = new QueryCommand({
                    TableName: AUDIT_TABLE_NAME,
                    IndexName: 'GSI1',
                    KeyConditionExpression: 'gsi1pk = :pkVal AND gsi1sk BETWEEN :startDate AND :endDate',
                    ExpressionAttributeValues: {
                        ':pkVal': 'TYPE#LOG',
                        ':startDate': filters.startDate,
                        ':endDate': filters.endDate
                    },
                    ScanIndexForward: false,
                    Limit: limit
                });
            } else {
                // If no date filters, or complex filters, we might fall back to Querying latest logs or Scan.
                // Let's query latest by default (using GSI1)
                command = new QueryCommand({
                    TableName: AUDIT_TABLE_NAME,
                    IndexName: 'GSI1',
                    KeyConditionExpression: 'gsi1pk = :pkVal',
                    ExpressionAttributeValues: {
                        ':pkVal': 'TYPE#LOG',
                    },
                    ScanIndexForward: false, // Newest first
                    Limit: limit
                });
            }

            const response = await getDynamoDBDocumentClient().send(command);
            let auditLogs = (response.Items || []).map(this.transformToAuditLog);

            // In-memory filtering for other fields
            if (filters) {
                if (filters.status) auditLogs = auditLogs.filter(l => l.status === filters.status);
                if (filters.eventType) auditLogs = auditLogs.filter(l => l.eventType === filters.eventType);
                if (filters.user) auditLogs = auditLogs.filter(l => l.user === filters.user);
                if (filters.resourceType) auditLogs = auditLogs.filter(l => l.resourceType === filters.resourceType);
                if (filters.searchTerm) {
                    const term = filters.searchTerm.toLowerCase();
                    auditLogs = auditLogs.filter(l =>
                        (l.action?.toLowerCase() || '').includes(term) ||
                        (l.details?.toLowerCase() || '').includes(term) ||
                        (l.user?.toLowerCase() || '').includes(term)
                    );
                }
            }

            return auditLogs;
        } catch (error: unknown) {
            console.error('AuditService - Error fetching audit logs:', error);
            return [];
        }
    }

    /**
     * Get audit logs by correlation ID
     */
    static async getAuditLogsByCorrelation(correlationId: string): Promise<AuditLog[]> {
        try {
            const command = new ScanCommand({
                TableName: AUDIT_TABLE_NAME,
                FilterExpression: 'correlationId = :correlationId',
                ExpressionAttributeValues: {
                    ':correlationId': correlationId,
                },
            });

            const response = await getDynamoDBDocumentClient().send(command);
            const auditLogs = (response.Items || []).map(this.transformToAuditLog);
            auditLogs.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

            return auditLogs;
        } catch (error: unknown) {
            console.error('AuditService - Error fetching correlated audit logs:', error);
            return [];
        }
    }

    /**
     * Get audit log statistics
     */
    static async getAuditLogStats(filters?: AuditLogFilters): Promise<AuditLogStats> {
        try {
            // Fetch logs (reusing getAuditLogs logic)
            // Note: This fetches limited logs, so stats are based on "recent" logs. 
            const logs = await this.getAuditLogs({ limit: 500, ...filters });

            const stats = {
                totalLogs: logs.length,
                successCount: logs.filter(log => log.status === 'success').length,
                errorCount: logs.filter(log => log.status === 'error').length,
                warningCount: logs.filter(log => log.status === 'warning').length,
                systemEvents: logs.filter(log => log.userType === 'system').length,
                userEvents: logs.filter(log => log.userType === 'user' || log.userType === 'admin').length,
                criticalEvents: logs.filter(log => log.severity === 'critical').length,
                byEventType: this.groupBy(logs, 'eventType'),
                byStatus: this.groupBy(logs, 'status'),
                bySeverity: this.groupBy(logs, 'severity'),
                byResourceType: this.groupBy(logs, 'resourceType'),
            };

            return stats;
        } catch (error: unknown) {
            console.error('AuditService - Error fetching audit log stats:', error);
            return {
                totalLogs: 0,
                successCount: 0,
                errorCount: 0,
                warningCount: 0,
                systemEvents: 0,
                userEvents: 0,
                criticalEvents: 0,
                byEventType: {},
                byStatus: {},
                bySeverity: {},
                byResourceType: {},
            };
        }
    }

    private static transformToAuditLog(item: any): AuditLog {
        return {
            id: item.id || item.pk.replace('LOG#', ''),
            name: item.pk.replace('LOG#', ''), // Map 'name' to ID roughly
            type: 'audit_log',
            timestamp: item.timestamp,
            eventType: item.eventType,
            action: item.action,
            user: item.user,
            userType: item.userType,
            resource: item.resource,
            resourceType: item.resourceType,
            resourceId: item.resourceId,
            status: item.status,
            severity: item.severity,
            details: item.details,
            metadata: item.metadata,
            ipAddress: item.ipAddress,
            userAgent: item.userAgent,
            sessionId: item.sessionId,
            correlationId: item.correlationId,
            source: item.source,
            region: item.region,
            accountId: item.accountId,
            duration: item.duration,
            errorCode: item.errorCode
        };
    }

    // Helper methods
    private static generateAuditId(): string {
        return `audit-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private static groupBy(array: any[], key: string): Record<string, number> {
        return array.reduce((result, item) => {
            const value = item[key] || 'unknown';
            result[value] = (result[value] || 0) + 1;
            return result;
        }, {});
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private static validateAndCleanAuditData(data: any): Record<string, any> {
        // Reuse existing validation logic but simplified
        if (!data || typeof data !== 'object') throw new Error('Invalid audit data');

        return {
            ...data,
            // Ensure defaults
            action: data.action || 'Unknown Action',
            status: data.status || 'info',
            user: data.user || 'system',
            timestamp: data.timestamp || new Date().toISOString()
        };
    }

    /**
     * Make audit logging silently fail rather than disrupt the app
     */
    static async logUserAction(data: {
        action: string;
        resourceType: string;
        resourceId: string;
        resourceName: string;
        user: string;
        userType: 'user' | 'admin';
        status: 'success' | 'error' | 'warning';
        details: string;
        metadata?: Record<string, any>;
        ipAddress?: string;
        userAgent?: string;
        sessionId?: string;
    }): Promise<void> {
        try {
            await this.createAuditLog({
                eventType: `${data.resourceType}.${data.action.toLowerCase().replace(/\s+/g, '_')}`,
                ...data,
                source: 'web-ui'
            });
        } catch (error) {
            console.error('Failed to create user action audit log:', error);
        }
    }

    static async logResourceAction(data: {
        action: string;
        resourceType: string;
        resourceId: string;
        resourceName: string;
        status: 'success' | 'error' | 'warning';
        details: string;
        user?: string;
        userType?: 'system' | 'user' | 'admin';
        metadata?: Record<string, any>;
        correlationId?: string;
        accountId?: string;
        region?: string;
        source?: 'web-ui' | 'lambda' | 'system' | 'api';
    }): Promise<void> {
        try {
            await this.createAuditLog({
                eventType: `${data.resourceType}.${data.action.toLowerCase().replace(/\s+/g, '_')}`,
                ...data, // Spread rest
                user: data.user || 'system',
                userType: data.userType || 'system',
            });
        } catch (error) {
            console.error('Failed to create resource action audit log:', error);
        }
    }
}
