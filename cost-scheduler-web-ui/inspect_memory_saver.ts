
import { MemorySaver } from "@langchain/langgraph";

const saver = new MemorySaver();
// @ts-ignore
console.log("Keys:", Object.keys(saver));
console.log(saver);
