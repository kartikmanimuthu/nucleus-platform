// DynamoDB service for schedule operations
import { ScanCommand, PutCommand, DeleteCommand, UpdateCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { getDynamoDBDocumentClient, APP_TABLE_NAME, handleDynamoDBError, DEFAULT_TENANT_ID } from './aws-config';
import { Schedule, UISchedule } from './types';
import { AuditService } from './audit-service';

// Helper to build PK/SK for schedules
const buildSchedulePK = (tenantId: string, accountId: string) => `TENANT#${tenantId}#ACCOUNT#${accountId}`;
const buildScheduleSK = (scheduleId: string) => `SCHEDULE#${scheduleId}`;

export class ScheduleService {
    /**
     * Fetch all schedules from DynamoDB with optional filters
     * Uses GSI1: gsi1pk = TYPE#SCHEDULE
     */
    static async getSchedules(filters?: {
        statusFilter?: string;
        resourceFilter?: string;
        searchTerm?: string;
        tenantId?: string;
        accountId?: string;
        page?: number;
        limit?: number;
    }): Promise<{ schedules: UISchedule[], total: number }> {
        try {
            console.log('ScheduleService - Attempting to fetch schedules from DynamoDB with filters:', filters);

            const dynamoDBDocumentClient = await getDynamoDBDocumentClient();

            // Use Query on GSI1 for efficient access
            const params = {
                TableName: APP_TABLE_NAME,
                IndexName: 'GSI1',
                KeyConditionExpression: 'gsi1pk = :typeVal',
                ExpressionAttributeValues: {
                    ':typeVal': 'TYPE#SCHEDULE'
                }
            };

            console.log('ScheduleService - Sending DynamoDB Query command to GSI1...');
            const response = await dynamoDBDocumentClient.send(new QueryCommand(params));
            console.log('ScheduleService - Successfully fetched raw schedules:', response.Items?.length || 0);

            let schedules = (response.Items || []).map(item => this.transformToUISchedule(item as any));

            // In-memory filtering (since GSI Query handles the bulk of retrieval)
            if (filters?.statusFilter) {
                if (filters.statusFilter === 'active') {
                    schedules = schedules.filter(s => s.active === true);
                } else if (filters.statusFilter === 'inactive') {
                    schedules = schedules.filter(s => s.active === false);
                }
            }

            if (filters?.searchTerm) {
                const searchLower = filters.searchTerm.toLowerCase();
                schedules = schedules.filter(schedule =>
                    schedule.name.toLowerCase().includes(searchLower) ||
                    (schedule.description && schedule.description.toLowerCase().includes(searchLower)) ||
                    (schedule.createdBy && schedule.createdBy.toLowerCase().includes(searchLower))
                );
            }

            if (filters?.resourceFilter && filters.resourceFilter !== 'all') {
                schedules = schedules.filter(schedule =>
                    schedule.resourceTypes && schedule.resourceTypes.includes(filters.resourceFilter!)
                );
            }

            // Filter by accountId if provided
            if (filters?.accountId) {
                schedules = schedules.filter(schedule =>
                    schedule.accounts && schedule.accounts.includes(filters.accountId!)
                );
            }

            // Calculate total before slicing
            const total = schedules.length;

            // Apply pagination if provided
            if (filters?.page && filters.limit) {
                const startIndex = (filters.page - 1) * filters.limit;
                const endIndex = startIndex + filters.limit;
                schedules = schedules.slice(startIndex, endIndex);
            }

            return { schedules, total };
        } catch (error: any) {
            console.error('ScheduleService - Error fetching schedules:', error);
            handleDynamoDBError(error, 'getSchedules');
            return { schedules: [], total: 0 };
        }
    }

    /**
     * Fetch schedules with filtering support (Legacy helper)
     */
    static async getSchedulesWithFilters(active?: boolean, searchTerm?: string): Promise<UISchedule[]> {
        // Reuse general getSchedules logic for consistency
        const statusFilter = active === undefined ? undefined : (active ? 'active' : 'inactive');
        const result = await this.getSchedules({ statusFilter, searchTerm });
        return result.schedules;
    }

    /**
     * Get a specific schedule by name (and accountId)
     * PK: TENANT#<tenantId>#ACCOUNT#<accountId>, SK: SCHEDULE#<name>
     */
    /**
     * Get a specific schedule by ID or name
     * If ID provided (UUID format), looks up via GSI3 (Status + ID) or direct GetItem if account known.
     * If Name provided, looks up via GSI1 query.
     */
    static async getSchedule(idOrName: string, accountId?: string, tenantId: string = DEFAULT_TENANT_ID): Promise<UISchedule | null> {
        try {
            const dynamoDBDocumentClient = await getDynamoDBDocumentClient();
            const isUUID = idOrName.startsWith('sched-');

            // Strategy 1: If accountId is provided, we can try direct GetItem
            // BUT we must be sure if idOrName is the SK or just Name.
            // If it's UUID, SK is SCHEDULE#<uuid>. If Name, SK might be SCHEDULE#<name> (legacy) or we can't find it.
            // We'll assume if accountId is provided and it's a UUID, we use direct GetItem.
            if (accountId && isUUID) {
                const command = new GetCommand({
                    TableName: APP_TABLE_NAME,
                    Key: {
                        pk: buildSchedulePK(tenantId, accountId),
                        sk: buildScheduleSK(idOrName),
                    },
                });

                const response = await dynamoDBDocumentClient.send(command);
                if (response.Item) return this.transformToUISchedule(response.Item as any);
            }

            // Strategy 2: If UUID but no accountId (or direct get failed/not tried), try GSI3 lookup.
            // GSI3 PK: STATUS#active or STATUS#inactive
            // GSI3 SK: TENANT#<tenant>#SCHEDULE#<uuid>
            if (isUUID) {
                // We need to check both Active and Inactive states since we don't know the status
                // This is parallelized for performance
                const checkStatus = async (status: string) => {
                    const command = new QueryCommand({
                        TableName: APP_TABLE_NAME,
                        IndexName: 'GSI3',
                        KeyConditionExpression: 'gsi3pk = :gsi3pk AND gsi3sk = :gsi3sk',
                        ExpressionAttributeValues: {
                            ':gsi3pk': `STATUS#${status}`,
                            ':gsi3sk': `TENANT#${tenantId}#SCHEDULE#${idOrName}`
                        }
                    });
                    const response = await dynamoDBDocumentClient.send(command);
                    return response.Items?.[0];
                };

                const [activeItem, inactiveItem] = await Promise.all([
                    checkStatus('active'),
                    checkStatus('inactive')
                ]);

                const item = activeItem || inactiveItem;
                if (item) return this.transformToUISchedule(item as any);

                // If UUID lookup fails, maybe it IS a name that looks like a UUID? unlikely but proceed to GSI1 fallback or return null.
                if (accountId) return null; // If accountId was provided and direct get failed, we stop.
            }

            // Strategy 3: Lookup by Name via GSI1 (Legacy or Name-based lookup)
            const command = new QueryCommand({
                TableName: APP_TABLE_NAME,
                IndexName: 'GSI1',
                KeyConditionExpression: 'gsi1pk = :pkVal AND gsi1sk = :skVal',
                ExpressionAttributeValues: {
                    ':pkVal': 'TYPE#SCHEDULE',
                    ':skVal': idOrName
                }
            });

            const response = await dynamoDBDocumentClient.send(command);
            if (response.Items && response.Items.length > 0) {
                return this.transformToUISchedule(response.Items[0] as any);
            }

            return null;
        } catch (error: any) {
            handleDynamoDBError(error, 'getSchedule');
            return null;
        }
    }

    /**
     * Create a new schedule
     * PK: TENANT#<tenantId>#ACCOUNT#<accountId>, SK: SCHEDULE#<scheduleId>
     * Note: scheduleId is now a UUID, name is just a display attribute
     */
    static async createSchedule(schedule: Omit<Schedule, 'id'>, tenantId: string = DEFAULT_TENANT_ID): Promise<Schedule> {
        try {
            const dynamoDBDocumentClient = await getDynamoDBDocumentClient();
            const now = new Date().toISOString();
            const statusText = schedule.active ? 'active' : 'inactive';

            // Ensure accountId is provided
            if (!schedule.accountId) {
                throw new Error('accountId is required to create a schedule in multi-tenant design');
            }

            // Generate a unique scheduleId (UUID-like)
            const scheduleId = `sched-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

            const dbSchedule = {
                // Primary Keys (new hierarchical design)
                pk: buildSchedulePK(tenantId, schedule.accountId),
                sk: buildScheduleSK(scheduleId), // Use scheduleId, not name

                // GSI1: TYPE#SCHEDULE -> scheduleName (list all schedules)
                gsi1pk: 'TYPE#SCHEDULE',
                gsi1sk: schedule.name,

                // GSI2: ACCOUNT#<id> -> SCHEDULE#<id> (schedules per account)
                gsi2pk: `ACCOUNT#${schedule.accountId}`,
                gsi2sk: `SCHEDULE#${scheduleId}`,

                // GSI3: STATUS#active/inactive -> TENANT#...#SCHEDULE#...
                gsi3pk: `STATUS#${statusText}`,
                gsi3sk: `TENANT#${tenantId}#SCHEDULE#${scheduleId}`,

                // Entity type
                type: 'schedule',

                // IDs
                tenantId: tenantId,
                accountId: schedule.accountId,
                scheduleId: scheduleId, // Use generated ID

                // Attributes from schedule
                name: schedule.name,
                days: schedule.days,
                starttime: schedule.starttime,
                endtime: schedule.endtime,
                timezone: schedule.timezone,
                active: schedule.active,
                resources: schedule.resources,
                description: schedule.description,
                createdAt: now,
                updatedAt: now,
                createdBy: schedule.createdBy || 'system',
                updatedBy: schedule.updatedBy || 'system',
            };

            const command = new PutCommand({
                TableName: APP_TABLE_NAME,
                Item: dbSchedule,
                ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
            });

            await dynamoDBDocumentClient.send(command);

            // Log audit event
            await AuditService.logUserAction({
                action: 'Create Schedule',
                resourceType: 'schedule',
                resourceId: scheduleId,
                resourceName: schedule.name,
                user: schedule.createdBy || 'system',
                userType: 'user',
                status: 'success',
                details: `Created schedule "${schedule.name}" with ${schedule.days.join(', ')} from ${schedule.starttime} to ${schedule.endtime}`,
                metadata: {
                    tenantId,
                    accountId: schedule.accountId,
                    scheduleName: schedule.name,
                    active: schedule.active,
                },
            });

            return dbSchedule as any;
        } catch (error) {
            console.error('Error creating schedule:', error);
            await AuditService.logUserAction({
                action: 'Create Schedule',
                resourceType: 'schedule',
                resourceId: schedule.name,
                resourceName: schedule.name,
                user: 'system',
                userType: 'user',
                status: 'error',
                details: `Failed to create schedule "${schedule.name}": ${(error as any).message}`,
            });

            handleDynamoDBError(error, 'create schedule');
            throw error;
        }
    }

    /**
     * Update an existing schedule
     */
    static async updateSchedule(scheduleId: string, updates: Partial<Omit<Schedule, 'name'>>, accountId?: string, tenantId: string = DEFAULT_TENANT_ID): Promise<UISchedule> {
        try {
            const currentSchedule = await this.getSchedule(scheduleId, accountId, tenantId);
            if (!currentSchedule) {
                throw new Error('Schedule not found');
            }

            // Use the accountId from the existing schedule if not provided
            const effectiveAccountId = accountId || currentSchedule.accounts?.[0];
            if (!effectiveAccountId) {
                throw new Error('accountId is required to update a schedule');
            }

            // IMPORTANT: If currentSchedule has a UUID ID, we must use that for SK.
            // currentSchedule.id comes from transformToUISchedule, which we fixed to prefer UUID.
            const skValue = currentSchedule.id.startsWith('sched-') ? currentSchedule.id : currentSchedule.name;

            const updateExpressions: string[] = [];
            const expressionAttributeNames: Record<string, string> = {};
            const expressionAttributeValues: Record<string, any> = {};

            const excludedFields = ['name', 'type', 'pk', 'sk', 'gsi1pk', 'gsi1sk', 'gsi2pk', 'gsi2sk', 'gsi3pk', 'gsi3sk', 'tenantId', 'accountId', 'scheduleId'];

            Object.entries(updates).forEach(([key, value]) => {
                if (value !== undefined && !excludedFields.includes(key)) {
                    updateExpressions.push(`#${key} = :${key}`);
                    expressionAttributeNames[`#${key}`] = key;
                    expressionAttributeValues[`:${key}`] = value;
                }
            });

            // Update GSI3 if active status changes
            if (updates.active !== undefined) {
                const statusText = updates.active ? 'active' : 'inactive';
                updateExpressions.push('#gsi3pk = :gsi3pk');
                expressionAttributeNames['#gsi3pk'] = 'gsi3pk';
                expressionAttributeValues[':gsi3pk'] = `STATUS#${statusText}`;
            }

            // Always update updatedAt
            updateExpressions.push('#updatedAt = :updatedAt');
            expressionAttributeNames['#updatedAt'] = 'updatedAt';
            expressionAttributeValues[':updatedAt'] = new Date().toISOString();

            const command = new UpdateCommand({
                TableName: APP_TABLE_NAME,
                Key: {
                    pk: buildSchedulePK(tenantId, effectiveAccountId),
                    sk: buildScheduleSK(skValue),
                },
                UpdateExpression: `SET ${updateExpressions.join(', ')}`,
                ExpressionAttributeNames: expressionAttributeNames,
                ExpressionAttributeValues: expressionAttributeValues,
                ReturnValues: 'ALL_NEW',
            });

            const dynamoDBDocumentClient = await getDynamoDBDocumentClient();
            const response = await dynamoDBDocumentClient.send(command);
            const updatedSchedule = this.transformToUISchedule(response.Attributes as any);

            await AuditService.logUserAction({
                action: 'Update Schedule',
                resourceType: 'schedule',
                resourceId: scheduleId,
                resourceName: currentSchedule.name,
                user: updates.updatedBy || 'system',
                userType: 'user',
                status: 'success',
                details: `Updated schedule "${currentSchedule.name}"`,
            });

            return updatedSchedule;
        } catch (error) {
            console.error('Error updating schedule:', error);
            handleDynamoDBError(error, 'update schedule');
            throw error;
        }
    }

    /**
     * Delete a schedule
     */
    static async deleteSchedule(idOrName: string, accountId?: string, deletedBy: string = 'system', tenantId: string = DEFAULT_TENANT_ID): Promise<void> {
        try {
            const dynamoDBDocumentClient = await getDynamoDBDocumentClient();

            // Get schedule first to get accountId if not provided AND to resolve correct SK (UUID vs Name)
            const schedule = await this.getSchedule(idOrName, accountId, tenantId);
            if (!schedule) {
                // If not found, nothing to delete.
                return;
            }

            const effectiveAccountId = accountId || schedule.accounts?.[0];
            if (!effectiveAccountId) {
                throw new Error('Could not determine accountId for schedule deletion');
            }

            // Resolve proper SK value
            const skValue = schedule.id.startsWith('sched-') ? schedule.id : schedule.name;

            const command = new DeleteCommand({
                TableName: APP_TABLE_NAME,
                Key: {
                    pk: buildSchedulePK(tenantId, effectiveAccountId),
                    sk: buildScheduleSK(skValue),
                },
            });

            await dynamoDBDocumentClient.send(command);

            await AuditService.logUserAction({
                action: 'Delete Schedule',
                resourceType: 'schedule',
                resourceId: idOrName,
                resourceName: schedule.name,
                user: deletedBy,
                userType: 'user',
                status: 'success',
                details: `Deleted schedule "${schedule.name}"`,
            });
        } catch (error: any) {
            handleDynamoDBError(error, 'deleteSchedule');
        }
    }

    /**
     * Toggle schedule active status
     */
    static async toggleScheduleStatus(idOrName: string, accountId?: string, updatedBy: string = 'system', tenantId: string = DEFAULT_TENANT_ID): Promise<UISchedule> {
        try {
            const currentSchedule = await this.getSchedule(idOrName, accountId, tenantId);
            if (!currentSchedule) {
                throw new Error('Schedule not found');
            }

            const effectiveAccountId = accountId || currentSchedule.accounts?.[0];
            return await this.updateSchedule(currentSchedule.id, { active: !currentSchedule.active, updatedBy }, effectiveAccountId, tenantId);
        } catch (error: any) {
            throw error;
        }
    }

    /**
     * Transform DynamoDB item to UI schedule format
     */
    private static transformToUISchedule(item: any): UISchedule {
        // Fix: Prioritize scheduleId (UUID) -> SK (without prefix) -> Name 
        const id = item.scheduleId || (item.sk ? item.sk.replace('SCHEDULE#', '') : undefined) || item.name;

        return {
            id: id,
            name: item.name,
            starttime: item.starttime,
            endtime: item.endtime,
            timezone: item.timezone,
            active: item.active,
            days: item.days,
            accounts: item.accountId ? [item.accountId] : (item.accounts || []),
            resourceTypes: item.resourceTypes || ['EC2', 'RDS', 'ECS'],
            description: item.description || '',
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            createdBy: item.createdBy,
            updatedBy: item.updatedBy,
            resources: item.resources, // Pass through selected resources
            lastExecution: item.lastExecution,
            nextExecution: item.nextExecution,
            executionCount: item.executionCount || 0,
            successRate: item.successRate || 100,
            estimatedSavings: item.estimatedSavings || 0,
        };
    }
}
