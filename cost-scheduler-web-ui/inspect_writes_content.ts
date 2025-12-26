
import { MemorySaver } from "@langchain/langgraph";

async function main() {
    const saver = new MemorySaver();
    const config = { configurable: { thread_id: "t1", checkpoint_id: "c1" } };
    const writes = [["foo", "bar"]] as any;

    await saver.putWrites(config, writes, "task1");
    // @ts-ignore
    console.log("Writes:", JSON.stringify(saver.writes, null, 2));
}

main();
