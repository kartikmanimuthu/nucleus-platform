import { graph } from '@/lib/agent/graph';
import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { toUIMessageStream } from '@ai-sdk/langchain';
import { createUIMessageStreamResponse, UIMessageChunk } from 'ai';

export const maxDuration = 60;

export async function POST(req: Request) {
    try {
        const { messages } = await req.json();
        console.log('Incoming messages:', JSON.stringify(messages, null, 2));

        // Convert Vercel AI SDK messages to LangChain messages
        const validMessages = messages.map((m: any) => {
            let content = m.content;
            if (!content && m.parts) {
                // Extract text from parts if content is missing
                content = m.parts
                    .filter((p: any) => p.type === 'text')
                    .map((p: any) => p.text)
                    .join('');
            }
            // Ensure content is a string
            content = content || "";

            if (m.role === 'user') {
                return new HumanMessage({ content });
            } else if (m.role === 'assistant') {
                // If it has tool_calls, we need to reconstruct them
                // For simplicity in this adapter context, we mostly care about text content
                // unless we are re-hydratiing a complex state.
                // Vercel SDK sends toolInvocations, but LangChain expects tool_calls in AIMessage
                const toolCalls = m.toolInvocations?.map((ti: any) => ({
                    name: ti.toolName,
                    args: ti.args,
                    id: ti.toolCallId,
                    type: "tool_call" // Ensure type is set if needed by newer langchain
                })) || [];

                return new AIMessage({
                    content: content,
                    tool_calls: toolCalls
                });
            } else if (m.role === 'tool') {
                return new ToolMessage({
                    tool_call_id: m.toolCallId, // Vercel SDK uses toolCallId
                    content: content
                });
            }
            // Fallback
            return new HumanMessage({ content });
        });

        const stream = await graph.streamEvents(
            { messages: validMessages },
            {
                version: "v2",
            }
        );

        return createUIMessageStreamResponse({
            stream: processStream(stream)
        });

    } catch (error) {
        console.error('[API Error]:', error);
        return new Response(
            JSON.stringify({
                error: unknownError(error)
            }),
            {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}

function unknownError(error: unknown): string {
    return error instanceof Error ? error.message : 'Internal server error';
}

function processStream(stream: any): ReadableStream<UIMessageChunk> {
    return new ReadableStream({
        async start(controller) {
            let partCounter = 0;
            let currentPartId = "";
            let streamStarted = false;
            let currentType: 'reasoning' | 'text' = 'reasoning';
            let hasCalledTool = false;

            const safeEnqueue = (chunk: any) => {
                try {
                    controller.enqueue(chunk);
                } catch (e) {
                    // Ignore closed controller
                    return false;
                }
                return true;
            };

            try {
                // Initialize message
                if (!safeEnqueue({ type: 'start' })) return;

                for await (const event of stream) {
                    try {
                        if (event.event === "on_chat_model_start") {
                            partCounter++;
                            currentPartId = partCounter.toString();
                            streamStarted = false;

                            // First call is reasoning, subsequent after tools are text
                            currentType = hasCalledTool ? 'text' : 'reasoning';

                            if (!safeEnqueue({ type: `${currentType}-start` as any, id: currentPartId })) break;
                            streamStarted = true;
                        }
                        else if (event.event === "on_chat_model_stream") {
                            const content = event.data.chunk.content;
                            let text = "";
                            if (typeof content === "string") {
                                text = content;
                            } else if (Array.isArray(content)) {
                                text = content
                                    .filter((c: any) => c.type === 'text')
                                    .map((c: any) => c.text)
                                    .join('');
                            }

                            if (text && streamStarted) {
                                if (!safeEnqueue({
                                    type: `${currentType}-delta` as any,
                                    id: currentPartId,
                                    delta: text,
                                })) break;
                            }
                        }
                        else if (event.event === "on_chat_model_end") {
                            if (streamStarted) {
                                if (!safeEnqueue({ type: `${currentType}-end` as any, id: currentPartId })) break;
                                streamStarted = false;
                            }
                        }
                        else if (event.event === "on_tool_start") {
                            hasCalledTool = true;
                            const { name, args, id } = event.data;
                            if (id) {
                                if (!safeEnqueue({
                                    type: "tool-input-start",
                                    toolCallId: id,
                                    toolName: name,
                                })) break;

                                if (!safeEnqueue({
                                    type: "tool-input-available",
                                    toolCallId: id,
                                    toolName: name,
                                    input: args,
                                })) break;
                            }
                        }
                        else if (event.event === "on_tool_end") {
                            const { output, id } = event.data;
                            if (id) {
                                if (!safeEnqueue({
                                    type: "tool-output-available",
                                    toolCallId: id,
                                    output: output?.content || output || "",
                                })) break;
                            }
                        }
                    } catch (innerError) {
                        break;
                    }
                }

                // Finalize message
                safeEnqueue({ type: 'finish' });

                try {
                    controller.close();
                } catch (e) { }
            } catch (error) {
                console.error("Stream processing loop error:", error);
                try {
                    controller.error(error);
                } catch (e) { }
            }
        }
    });
}
