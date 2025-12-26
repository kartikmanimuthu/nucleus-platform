
import { MemorySaver } from "@langchain/langgraph";

async function main() {
    const saver = new MemorySaver();
    const config = { configurable: { thread_id: "t1" } };
    const checkpoint = { id: "c1", ts: "2023..." } as any;
    const metadata = { source: "test" } as any;

    await saver.put(config, checkpoint, metadata, {});

    // @ts-ignore
    console.log("Storage:", JSON.stringify(saver.storage, null, 2));
}

main();
