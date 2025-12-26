import fs from 'fs';
import path from 'path';
import { MemorySaver } from "@langchain/langgraph";
import { RunnableConfig } from "@langchain/core/runnables";
import { Checkpoint, CheckpointMetadata, CheckpointTuple } from "@langchain/langgraph-checkpoint";

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

export class FileSaver extends MemorySaver {
    constructor() {
        super();
    }

    private getFilePath(threadId: string): string {
        const safeId = threadId.replace(/[^a-z0-9-]/gi, '_');
        return path.join(DATA_DIR, `checkpoint_${safeId}.json`);
    }

    private async saveToDisk(threadId: string, checkpoint: Checkpoint, metadata: CheckpointMetadata) {
        const fp = this.getFilePath(threadId);
        let data: Record<string, any> = {};

        if (fs.existsSync(fp)) {
            try {
                data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
            } catch (e) {
                // Ignore corrupt file
            }
        }

        data[checkpoint.id] = { checkpoint, metadata };
        fs.writeFileSync(fp, JSON.stringify(data, null, 2));
    }

    async put(
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        newVersions?: any
    ): Promise<RunnableConfig> {
        // Call super to handle in-memory logic
        // We use typical call pattern. If types mismatch in strict mode, we cast or ignore.
        let result;
        try {
            // @ts-ignore
            result = await super.put(config, checkpoint, metadata, newVersions);
        } catch (e) {
            // Fallback if 4 args not supported
            // @ts-ignore
            result = await super.put(config, checkpoint, metadata);
        }

        const threadId = config.configurable?.thread_id;
        if (threadId) {
            await this.saveToDisk(threadId, checkpoint, metadata);
        }

        return result;
    }

    async get(config: RunnableConfig): Promise<Checkpoint | undefined> {
        const fromSuper = await super.get(config);
        if (fromSuper) return fromSuper;

        const threadId = config.configurable?.thread_id;
        if (threadId) {
            const fp = this.getFilePath(threadId);
            if (!fs.existsSync(fp)) return undefined;

            try {
                const fileContent = fs.readFileSync(fp, 'utf-8');
                const data = JSON.parse(fileContent);

                const checkpointId = config.configurable?.checkpoint_id;
                if (checkpointId) {
                    const entry = data[checkpointId];
                    if (entry) return entry.checkpoint;
                } else {
                    const keys = Object.keys(data);
                    if (keys.length === 0) return undefined;
                    const lastKey = keys[keys.length - 1];
                    return data[lastKey]?.checkpoint;
                }
            } catch (e) {
                return undefined;
            }
        }
        return undefined;
    }

    // @ts-ignore
    async *list(
        config: RunnableConfig,
        options?: any,
        before?: any
    ): AsyncGenerator<CheckpointTuple> {
        const threadId = config.configurable?.thread_id;
        if (threadId) {
            const fp = this.getFilePath(threadId);
            if (fs.existsSync(fp)) {
                try {
                    const data = JSON.parse(fs.readFileSync(fp, 'utf-8'));
                    for (const key in data) {
                        const entry = data[key];
                        yield {
                            config: { configurable: { thread_id: threadId, checkpoint_id: key } },
                            checkpoint: entry.checkpoint,
                            metadata: entry.metadata,
                            parentConfig: entry.parentConfig
                        } as CheckpointTuple;
                    }
                } catch (e) { }
            }
        }

        // Fallback to super
        // @ts-ignore
        yield* super.list(config, options, before);
    }
}
