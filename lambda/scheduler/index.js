const AWS = require('aws-sdk');
const moment = require('moment-timezone')
const { v4: uuidv4 } = require('uuid');
const pino = require('pino');

// Environment Variables
const APP_TABLE_NAME = process.env.APP_TABLE_NAME;
const AUDIT_TABLE_NAME = process.env.AUDIT_TABLE_NAME;
const SCHEDULER_NAME = process.env.SCHEDULAR_NAME; // Typos in original env var name preserved if needed, but safer maybe to use both? Original was SCHEDULAR_NAME
const SCHEDULE_TAG = process.env.SCHEDULER_TAG;
const AWS_REGION = process.env.AWS_DEFAULT_REGION
const SNS_TOPIC_ARN = process.env.SNS_TOPIC_ARN

const logger = pino({
    level: 'debug', // | info | debug
    transport: {
        target: 'pino-pretty',
        options: {
            translateTime: 'SYS:standard',
            ignore: 'hostname',
            messageFormat: '{msg}',
        },
    },
});

let runId = null;

exports.handler = async (event) => {
    runId = uuidv4();
    logger.info(`EXEC_ID: ${runId} - Process Environments Variable: ${JSON.stringify(process.env)}`);
    try {
        await startScheduler();
    } catch (error) {
        logger.error(`EXEC_ID: ${runId} - Error in scheduler: ${error}`);
        await sendErrorNotification(error.toString());
    }
};

async function fetchSchedulesMetaDataFromDynamoDb() {
    const dynamoDB = new AWS.DynamoDB.DocumentClient({ region: AWS_REGION });

    // Use GSI1 to fetch all schedules
    const params = {
        TableName: APP_TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'gsi1pk = :typeVal',
        FilterExpression: 'active = :activeVal',
        ExpressionAttributeValues: {
            ':typeVal': 'TYPE#SCHEDULE',
            ':activeVal': true,
        },
    };

    try {
        const data = await dynamoDB.query(params).promise();
        return data.Items;
    } catch (error) {
        logger.error('Error fetching schedules from DynamoDB:', error);
        return [];
    }
}

async function fetchAccountsMetaDataFromDynamoDb() {
    const dynamoDB = new AWS.DynamoDB.DocumentClient({ region: AWS_REGION });

    // Use GSI1 to fetch all accounts
    const params = {
        TableName: APP_TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'gsi1pk = :typeVal',
        FilterExpression: 'active = :activeVal',
        ExpressionAttributeValues: {
            ':typeVal': 'TYPE#ACCOUNT',
            ':activeVal': true,
        },
    };

    try {
        const data = await dynamoDB.query(params).promise();
        return data.Items;
    } catch (error) {
        logger.error('Error fetching account metadata from DynamoDB:', error);
        return [];
    }
}

async function createAuditLog(entry) {
    if (!AUDIT_TABLE_NAME) return;

    const dynamoDB = new AWS.DynamoDB.DocumentClient({ region: AWS_REGION });
    const id = uuidv4();
    const timestamp = new Date().toISOString();
    const expireAt = Math.floor(Date.now() / 1000) + (90 * 24 * 60 * 60);

    const item = {
        pk: `LOG#${id}`,
        sk: timestamp,
        gsi1pk: 'TYPE#LOG',
        gsi1sk: timestamp,
        expire_at: expireAt,
        id: id,
        timestamp: timestamp,
        ...entry
    };

    try {
        await dynamoDB.put({
            TableName: AUDIT_TABLE_NAME,
            Item: item
        }).promise();
    } catch (error) {
        logger.error(`Failed to separate audit log: ${error.message}`);
    }
}

async function startScheduler() {
    logger.info(`EXEC_ID: ${runId}`);

    // Log start of execution
    await createAuditLog({
        type: 'audit_log',
        eventType: 'scheduler.start',
        action: 'start',
        user: 'system',
        userType: 'system',
        resourceType: 'scheduler',
        resourceId: runId,
        status: 'info',
        details: `Scheduler execution started: ${runId}`,
        severity: 'info'
    });

    const schedules = await fetchSchedulesMetaDataFromDynamoDb();
    const awsAccounts = await fetchAccountsMetaDataFromDynamoDb();

    logger.info(`EXEC_ID: ${runId} - Found ${schedules.length} schedules and ${awsAccounts.length} AWS accounts`);
    logger.debug(`EXEC_ID: ${runId} - schedules ${JSON.stringify(schedules)}`);

    // Process each account and its regions concurrently
    const accountPromises = awsAccounts.map(async (account) => {
        // Handle case where regions might be a comma-separated string or array
        let regions = account.regions;
        if (typeof regions === 'string') {
            regions = regions.split(',').map(r => r.trim());
        } else if (!Array.isArray(regions)) {
            regions = [];
        }

        const regionPromises = regions.map(async (region) => {
            try {
                const stsTempCredentials = await assumeRoleAndSetConfig(account.accountId, region, account.roleArn);
                const metadata = {
                    account: {
                        name: account.name,
                        accountId: account.accountId,
                    },
                    region: region,
                };

                // Call the scheduler functions
                await Promise.all([
                    ec2Schedular(schedules, stsTempCredentials, metadata),
                    rdsSchedular(schedules, stsTempCredentials, metadata),
                    ecsSchedular(schedules, stsTempCredentials, metadata),
                ]);
            } catch (err) {
                logger.error(`Error processing account ${account.name} in ${region}: ${err}`);
                await createAuditLog({
                    type: 'audit_log',
                    eventType: 'scheduler.error',
                    action: 'process_account',
                    user: 'system',
                    userType: 'system',
                    resourceType: 'account',
                    resourceId: account.accountId,
                    status: 'error',
                    details: `Error processing account ${account.name} in ${region}: ${err.message}`,
                    severity: 'high',
                    accountId: account.accountId,
                    region: region
                });
            }
        });

        await Promise.all(regionPromises);
    });

    await Promise.all(accountPromises);

    // Log completion
    await createAuditLog({
        type: 'audit_log',
        eventType: 'scheduler.complete',
        action: 'complete',
        user: 'system',
        userType: 'system',
        resourceType: 'scheduler',
        resourceId: runId,
        status: 'success',
        details: `Scheduler execution completed: ${runId}`,
        severity: 'info'
    });
}

async function assumeRoleAndSetConfig(accountId, region, roleArn) {
    const STS = new AWS.STS();
    const roleSessionName = `session-${accountId}-${region}`;

    logger.debug(`EXEC_ID: ${runId} - Assuming role ${roleArn} for account ${accountId}`);

    const assumedRole = await STS.assumeRole({
        RoleArn: roleArn,
        RoleSessionName: roleSessionName,
    }).promise();

    return {
        credentials: {
            accessKeyId: assumedRole.Credentials.AccessKeyId,
            secretAccessKey: assumedRole.Credentials.SecretAccessKey,
            sessionToken: assumedRole.Credentials.SessionToken
        },
        region: region
    };
}

async function sendErrorNotification(errorMessage) {
    const sns = new AWS.SNS();
    const params = {
        Message: `Error in scheduler: ${errorMessage}`,
        Subject: 'Scheduler Error Notification',
        TopicArn: SNS_TOPIC_ARN,
    };
    try {
        await sns.publish(params).promise();
        logger.info(`Sent error notification via SNS`);
    } catch (err) {
        logger.error(`Failed to send error notification via SNS: ${err}`);
    }
}

async function elasticCacheSchedular() {
    // to be implemented 
}

async function ec2Schedular(schedules, stsTempCredentials, metadata) {
    const ec2AwsSdk = new AWS.EC2({
        credentials: stsTempCredentials.credentials,
        region: stsTempCredentials.region,
    });
    logger.info(`EXEC_ID: ${runId} - EC2 Scheduler started for ${metadata.account.name} (${metadata.account.accountId}) in ${metadata.region}`);

    try {
        // Retrieve all EC2 instances
        const instancesData = await ec2AwsSdk.describeInstances().promise();
        const instances = instancesData.Reservations.flatMap(reservation => reservation.Instances);

        // Filter instances with 'schedule' tag and exclude 'AmazonECSManaged' instances
        const scheduledInstances = instances.filter(instance =>
            instance.Tags.some(tag => tag.Key === SCHEDULE_TAG) &&
            !instance.Tags.some(tag => tag.Key === 'AmazonECSManaged' && tag.Value === 'true')
        );

        // Process instances concurrently
        const instanceProcessPromises = scheduledInstances.map(instance => processEc2Instance(instance, schedules));
        await Promise.all(instanceProcessPromises);

        logger.info(`EXEC_ID: ${runId} - EC2 Schedular - Completed - ${metadata.account.name} (${metadata.account.accountId}) in ${metadata.region} `);
    } catch (error) {
        logger.error(`EXEC_ID: ${runId} - EC2 Schedular - Error - ${metadata.account.name} (${metadata.account.accountId}) in ${metadata.region} :`, error);
        // Log to audit
        await createAuditLog({
            eventType: 'scheduler.ec2.error',
            action: 'scan',
            user: 'system', userType: 'system',
            resourceType: 'ec2',
            resourceId: metadata.account.accountId,
            status: 'error',
            details: `Error in EC2 Scheduler for ${metadata.account.name}: ${error.message}`,
            severity: 'high',
            accountId: metadata.account.accountId,
            region: metadata.region
        });
    }


    async function processEc2Instance(instance, schedules) {
        const scheduleTag = instance.Tags.find(tag => tag.Key === SCHEDULE_TAG);
        const schedule = schedules.find(s => s.name === scheduleTag.Value);

        if (!schedule) {
            logger.debug(`EXEC_ID: ${runId} - Schedule "${scheduleTag.Value}" not found for instance ${instance.InstanceId}`);
            return;
        }

        logger.debug(`EXEC_ID: ${runId} - EC2 Schedular - Processing instance "${instance.InstanceId}" with schedule "${scheduleTag.Value}"`);

        const inRange = isCurrentTimeInRange(schedule.starttime, schedule.endtime, schedule.timezone, schedule.days);

        if (inRange) {
            if (instance.State.Name !== 'running') {
                try {
                    await ec2AwsSdk.startInstances({ InstanceIds: [instance.InstanceId] }).promise();
                    logger.info(`EXEC_ID: ${runId}- EC2 Schedular - Started instance: ${instance.InstanceId}`);
                    // Audit
                    await createAuditLog({
                        eventType: 'scheduler.ec2.start',
                        action: 'start',
                        user: 'system', userType: 'system',
                        resourceType: 'ec2',
                        resourceId: instance.InstanceId,
                        status: 'success',
                        details: `Started EC2 instance ${instance.InstanceId}`,
                        severity: 'medium',
                        accountId: metadata.account.accountId,
                        region: metadata.region
                    });
                } catch (error) {
                    logger.error(`EXEC_ID: ${runId} - EC2 Schedular - Error starting instance ${instance.InstanceId}: ${error}`);
                }
            } else {
                logger.debug(`EXEC_ID: ${runId} - EC2 Schedular - Instance "${instance.InstanceId}" is already at desired state running`);
            }
        } else {
            if (instance.State.Name === 'running') {
                try {
                    await ec2AwsSdk.stopInstances({ InstanceIds: [instance.InstanceId] }).promise();
                    logger.info(`EXEC_ID: ${runId} - EC2 Schedular - Stopped instance: ${instance.InstanceId}`);
                    // Audit
                    await createAuditLog({
                        eventType: 'scheduler.ec2.stop',
                        action: 'stop',
                        user: 'system', userType: 'system',
                        resourceType: 'ec2',
                        resourceId: instance.InstanceId,
                        status: 'success',
                        details: `Stopped EC2 instance ${instance.InstanceId}`,
                        severity: 'medium',
                        accountId: metadata.account.accountId,
                        region: metadata.region
                    });
                } catch (error) {
                    logger.error(`EXEC_ID: ${runId} - EC2 Schedular - Error stopping instance ${instance.InstanceId}: ${error}`);
                }
            } else {
                logger.debug(`EXEC_ID: ${runId} - EC2 Schedular - Instance "${instance.InstanceId}" is already at desired state stopped`);
            }
        }
    }
}

async function rdsSchedular(schedules, stsTempCredentials, metadata) {
    const rdsAwsSdk = new AWS.RDS({
        credentials: stsTempCredentials.credentials,
        region: stsTempCredentials.region,
    });
    logger.info(`EXEC_ID: ${runId} - RDS Scheduler started for ${metadata.account.name} (${metadata.account.accountId}) in ${metadata.region}`);

    try {
        const dbInstancesData = await rdsAwsSdk.describeDBInstances().promise();
        const dbInstances = dbInstancesData.DBInstances;

        logger.debug(`EXEC_ID: ${runId} - RDS Schedular - Found ${dbInstances.length} RDS instances for ${metadata.account.name} (${metadata.account.accountId}) in ${metadata.region}`);

        const dbInstanceProcessPromises = dbInstances.map(instance => processRDSInstance(instance, schedules));
        await Promise.all(dbInstanceProcessPromises);

        logger.info(`EXEC_ID: ${runId} - RDS Schedular - Completed - ${metadata.account.name} (${metadata.account.accountId}) in ${metadata.region}`);
    } catch (error) {
        logger.error(`EXEC_ID: ${runId} - RDS Schedular - Error - ${metadata.account.name} (${metadata.account.accountId}) in ${metadata.region} :`, error);
    }


    async function processRDSInstance(instance, schedules) {
        try {
            const tagsData = await rdsAwsSdk.listTagsForResource({ ResourceName: instance.DBInstanceArn }).promise();
            const scheduleTag = tagsData.TagList.find(tag => tag.Key === SCHEDULE_TAG);
            if (!scheduleTag) return;

            logger.debug(`EXEC_ID: ${runId} - RDS Schedular - Processing instance "${instance.DBInstanceIdentifier}" with schedule "${scheduleTag.Value}"`);

            const schedule = schedules.find(s => s.name === scheduleTag.Value);
            if (!schedule) {
                logger.debug(`EXEC_ID: ${runId} - RDS Schedular - Schedule "${scheduleTag.Value}" not found for instance ${instance.DBInstanceIdentifier}`);
                return;
            }

            const inRange = isCurrentTimeInRange(schedule.starttime, schedule.endtime, schedule.timezone, schedule.days);

            if (inRange) {
                if (instance.DBInstanceStatus !== 'available') {
                    await rdsAwsSdk.startDBInstance({ DBInstanceIdentifier: instance.DBInstanceIdentifier }).promise();
                    logger.info(`EXEC_ID: ${runId} - RDS Schedular - RDS instance "${instance.DBInstanceIdentifier}" started`);
                    await createAuditLog({
                        eventType: 'scheduler.rds.start',
                        action: 'start',
                        user: 'system', userType: 'system',
                        resourceType: 'rds',
                        resourceId: instance.DBInstanceIdentifier,
                        status: 'success',
                        details: `Started RDS instance ${instance.DBInstanceIdentifier}`,
                        severity: 'medium',
                        accountId: metadata.account.accountId,
                        region: metadata.region
                    });
                } else {
                    logger.info(`EXEC_ID: ${runId} - RDS Schedular - RDS instance "${instance.DBInstanceIdentifier}" is already at desired state running`);
                }
            } else {
                if (instance.DBInstanceStatus === 'available') {
                    await rdsAwsSdk.stopDBInstance({ DBInstanceIdentifier: instance.DBInstanceIdentifier }).promise();
                    logger.info(`EXEC_ID: ${runId} - RDS Schedular - RDS instance Stopped: ${instance.DBInstanceIdentifier}`);
                    await createAuditLog({
                        eventType: 'scheduler.rds.stop',
                        action: 'stop',
                        user: 'system', userType: 'system',
                        resourceType: 'rds',
                        resourceId: instance.DBInstanceIdentifier,
                        status: 'success',
                        details: `Stopped RDS instance ${instance.DBInstanceIdentifier}`,
                        severity: 'medium',
                        accountId: metadata.account.accountId,
                        region: metadata.region
                    });
                } else {
                    logger.info(`EXEC_ID: ${runId} - RDS Schedular - RDS instance "${instance.DBInstanceIdentifier}" is already at desired state stopped`);
                }
            }
        } catch (error) {
            logger.error(`EXEC_ID: ${runId} - RDS Schedular - Error processing RDS instance ${instance.DBInstanceIdentifier}: ${error}`);
        }
    }
}

async function ecsSchedular(schedules, stsTempCredentials, metadata) {
    const ecsAwsSdk = new AWS.ECS({
        credentials: stsTempCredentials.credentials,
        region: stsTempCredentials.region,
    });
    const asgAwsSdk = new AWS.AutoScaling({
        credentials: stsTempCredentials.credentials,
        region: stsTempCredentials.region,
    });
    logger.info(`EXEC_ID: ${runId} - ECS Scheduler started for ${metadata.account.name} (${metadata.account.accountId}) in ${metadata.region}`);

    try {
        const ecsClusters = await ecsAwsSdk.listClusters().promise();
        logger.debug(`EXEC_ID: ${runId} - ECS Schedular - Found ${ecsClusters.clusterArns.length} ECS Clusters`);

        const clusterUpdatePromises = ecsClusters.clusterArns.map(async clusterArn => {
            const clusterDetails = await getEcsClusterDetails(clusterArn);
            if (!hasTag(clusterDetails.tags, SCHEDULE_TAG)) {
                return;
            }

            const ecsServicesList = await ecsAwsSdk.listServices({ cluster: clusterArn }).promise();
            await ecsServiceScheduler(clusterArn, ecsServicesList.serviceArns, schedules);
            await ecsClusterScheduler(clusterArn, schedules);
        });

        await Promise.all(clusterUpdatePromises);
        logger.info(`EXEC_ID: ${runId} - ECS Schedular - Completed - ${metadata.account.name} (${metadata.account.accountId}) in ${metadata.region}`);
    } catch (error) {
        logger.error(`EXEC_ID: ${runId} - ECS Schedular - Error - ${metadata.account.name} (${metadata.account.accountId}) in ${metadata.region} :`, error);
    }

    async function ecsClusterScheduler(clusterArn, schedules) {
        const asgNames = await getAllAsgNamesForEcsCluster(clusterArn);
        if (!asgNames.length) return;

        const clusterDetails = await getEcsClusterDetails(clusterArn);
        const scheduleTagValue = getTagValue(clusterDetails.tags, SCHEDULE_TAG);
        const schedule = getScheduleDetails(schedules, scheduleTagValue);

        if (!schedule) return;

        const desiredCapacity = isCurrentTimeInRange(schedule.starttime, schedule.endtime, schedule.timezone, schedule.days) ? 1 : 0;

        const asgUpdatePromises = asgNames.map(asgName => updateAutoScalingGroupCount(asgName, desiredCapacity));
        await Promise.all(asgUpdatePromises);
    }

    async function ecsServiceScheduler(clusterArn, serviceArns, schedules) {
        const serviceUpdatePromises = serviceArns.map(async serviceArn => {
            const serviceDetails = await getEcsServiceDetails(serviceArn);
            if (!hasTag(serviceDetails.tags, SCHEDULE_TAG)) return;

            const scheduleTagValue = getTagValue(serviceDetails.tags, SCHEDULE_TAG);
            const schedule = getScheduleDetails(schedules, scheduleTagValue);
            if (!schedule) return;

            const desiredCount = isCurrentTimeInRange(schedule.starttime, schedule.endtime, schedule.timezone, schedule.days) ? 1 : 0;
            await updateEcsServiceCount(clusterArn, serviceArn, desiredCount, serviceDetails);
        });
        await Promise.all(serviceUpdatePromises);
    }

    // ========================== Helper Functions ==========================

    function getTagValue(tags, lookupKey) {
        const tag = tags.find(tag => tag.key === lookupKey);
        return tag ? tag.value : null;
    }

    function hasTag(tags, lookupKey) {
        return tags.some(tag => tag.key === lookupKey);
    }

    function getScheduleDetails(schedules, scheduleName) {
        return schedules.find(s => s.name === scheduleName);
    }

    async function getEcsClusterDetails(clusterArn) {
        try {
            const clusterDetails = await ecsAwsSdk.describeClusters({ clusters: [clusterArn] }).promise();
            const tagsResponse = await ecsAwsSdk.listTagsForResource({ resourceArn: clusterArn }).promise();
            return {
                ...clusterDetails.clusters[0],
                tags: tagsResponse.tags
            };
        } catch (error) {
            logger.error(`Error getting ECS cluster details: ${error}`);
            return null;
        }
    }

    async function getEcsServiceDetails(serviceArn) {
        try {
            const parts = serviceArn.split('/');
            const clusterName = parts[parts.length - 2];
            const serviceName = parts[parts.length - 1];

            const serviceDetails = await ecsAwsSdk.describeServices({
                cluster: clusterName,
                services: [serviceName]
            }).promise();

            const tagsResponse = await ecsAwsSdk.listTagsForResource({ resourceArn: serviceArn }).promise();
            return {
                ...serviceDetails.services[0],
                events: [],
                tags: tagsResponse.tags
            };
        } catch (error) {
            logger.error(`EXEC_ID: ${runId} - Error getting ECS service details: ${error}`);
            return null;
        }
    }

    async function updateEcsServiceCount(clusterArn, serviceArn, desiredCount, currentServiceDetails) {
        try {
            if (!currentServiceDetails) {
                currentServiceDetails = await getEcsServiceDetails(serviceArn);
            }
            const currentDesiredCount = currentServiceDetails.desiredCount;
            if (currentDesiredCount === desiredCount) return;

            const serviceName = currentServiceDetails.serviceName;
            const params = {
                cluster: clusterArn,
                service: serviceName,
                desiredCount: desiredCount
            };
            await ecsAwsSdk.updateService(params).promise();
            logger.info(`EXEC_ID: ${runId} - ECS Schedular - Updated service "${serviceName}" to desired count: ${desiredCount}`);
            await createAuditLog({
                eventType: 'scheduler.ecs.service.update',
                action: 'update',
                user: 'system', userType: 'system',
                resourceType: 'ecs-service',
                resourceId: serviceArn,
                status: 'success',
                details: `Updated ECS service ${serviceName} to count ${desiredCount}`,
                severity: 'medium',
                accountId: metadata.account.accountId,
                region: metadata.region
            });
        } catch (error) {
            logger.error(`EXEC_ID: ${runId} - ECS Schedular - Error updating service count for "${serviceArn}": ${error}`);
        }
    }

    async function getAllAsgNamesForEcsCluster(clusterArn) {
        try {
            const clusterResponse = await ecsAwsSdk.describeClusters({ clusters: [clusterArn] }).promise();
            const capacityProviders = clusterResponse.clusters[0].capacityProviders;
            if (!capacityProviders || capacityProviders.length === 0) return [];

            const capacityProvidersResponse = await ecsAwsSdk.describeCapacityProviders({ capacityProviders }).promise();
            const asgNames = capacityProvidersResponse.capacityProviders.map(provider => {
                const asgArn = provider?.autoScalingGroupProvider?.autoScalingGroupArn;
                return asgArn?.split('/')?.pop();
            }).filter(Boolean);
            return asgNames;
        } catch (error) {
            logger.error(`EXEC_ID: ${runId} - Error retrieving ASG names for ECS cluster: ${error}`);
            return [];
        }
    }

    async function updateAutoScalingGroupCount(asgName, desiredCount) {
        try {
            const asgResponse = await asgAwsSdk.describeAutoScalingGroups({
                AutoScalingGroupNames: [asgName]
            }).promise();

            if (asgResponse.AutoScalingGroups.length === 0) return;
            const asg = asgResponse.AutoScalingGroups[0];
            if (asg.DesiredCapacity === desiredCount) return;

            const params = {
                AutoScalingGroupName: asgName,
                DesiredCapacity: desiredCount,
                MinSize: desiredCount,
            };
            await asgAwsSdk.updateAutoScalingGroup(params).promise();
            logger.info(`EXEC_ID: ${runId} - Updated ASG "${asgName}" to desired capacity: ${desiredCount}`);
            await createAuditLog({
                eventType: 'scheduler.asg.update',
                action: 'update',
                user: 'system', userType: 'system',
                resourceType: 'asg',
                resourceId: asgName,
                status: 'success',
                details: `Updated ASG ${asgName} to count ${desiredCount}`,
                severity: 'medium',
                accountId: metadata.account.accountId,
                region: metadata.region
            });
        } catch (error) {
            logger.error(`EXEC_ID: ${runId} - Error updating ASG "${asgName}": ${error}`);
        }
    }
}

function isCurrentTimeInRange(starttime, endtime, timezone, days) {
    const now = moment().tz(timezone);
    const currentDay = now.format('ddd');
    const isActiveDay = Array.from(days).includes(currentDay);

    if (!isActiveDay) {
        return false;
    }

    // Create start and end times using the current date
    const currentDate = now.format('YYYY-MM-DD');
    const startTimeToday = moment.tz(`${currentDate} ${starttime}`, "YYYY-MM-DD HH:mm:ss", timezone);
    const endTimeToday = moment.tz(`${currentDate} ${endtime}`, "YYYY-MM-DD HH:mm:ss", timezone);

    // Adjust for schedules that span over midnight
    if (endTimeToday.isBefore(startTimeToday)) {
        endTimeToday.add(1, 'day');
    }

    return now.isBetween(startTimeToday, endTimeToday);
}
