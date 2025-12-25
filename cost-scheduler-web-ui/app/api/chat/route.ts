import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { createUIMessageStreamResponse, UIMessageChunk } from 'ai';
import { createReflectionGraph } from '@/lib/agent/graph-factory';

export const maxDuration = 300; // 5 minutes for complex multi-iteration tasks

// Phase types for UI segregation
type AgentPhase = 'planning' | 'execution' | 'reflection' | 'revision' | 'final' | 'text';

export async function POST(req: Request) {
    try {
        let { messages, threadId, autoApprove = true, model } = await req.json();

        if (!threadId) {
            threadId = Date.now().toString();
        }

        console.log(`[API] Thread ID: ${threadId}, Auto-Approve: ${autoApprove}, Model: ${model?.substring(0, 30)}...`);

        // Create graph with configuration
        const graph = createReflectionGraph({
            model: model || 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
            autoApprove: autoApprove
        });

        const lastMessage = messages[messages.length - 1];
        let input: any = null;
        const config = { configurable: { thread_id: threadId } };

        if (lastMessage.role === 'tool') {
            // Tool result (Human-in-the-Loop approval)
            console.log(`[API] Processing tool result: ${lastMessage.toolCallId}`);

            // "Approved" means "Execute the real tool"
            // So we DO NOT add this message to the state, we just resume
            if (lastMessage.content === 'Approved') {
                console.log(`[API] [Thread: ${threadId}] User Approved Execution - Resuming graph from interrupt.`);
                // We don't update state, just resume from interrupt
            }
            // Any other content (e.g. "Cancelled by user") is treated as a mock result
            // So we ADD it to state, effectively skipping the real tool execution
            else {
                console.log(`[API] [Thread: ${threadId}] User Provided Result - Skipping real tool. Content: "${lastMessage.content.substring(0, 20)}..."`);
                const toolMessage = new ToolMessage({
                    tool_call_id: lastMessage.toolCallId,
                    content: lastMessage.content
                });
                await graph.updateState(config, { messages: [toolMessage] });
            }

            input = null; // Resume from interrupt
        } else {
            // Get current state
            const currentState = await graph.getState(config);
            const stateMessages = currentState.values.messages || [];

            let messagesToProcess = messages;

            if (stateMessages.length > 0) {
                const lastClientMessage = messages[messages.length - 1];
                if (lastClientMessage.role === 'user') {
                    messagesToProcess = [lastClientMessage];
                } else {
                    console.warn("[API] Unexpected: Last message is not user on a running thread.");
                    messagesToProcess = messages;
                }
            }

            // Convert Vercel AI SDK messages to LangChain messages
            const validMessages = messagesToProcess.map((m: any) => {
                let content = m.content;
                if (!content && m.parts) {
                    content = m.parts
                        .filter((p: any) => p.type === 'text')
                        .map((p: any) => p.text)
                        .join('');
                }
                content = content || "";

                if (m.role === 'user') {
                    return new HumanMessage({ content });
                } else if (m.role === 'assistant') {
                    const toolCalls = m.toolInvocations?.map((ti: any) => ({
                        name: ti.toolName,
                        args: ti.args,
                        id: ti.toolCallId,
                        type: "tool_call"
                    })) || [];

                    return new AIMessage({
                        content: content,
                        tool_calls: toolCalls
                    });
                } else if (m.role === 'tool') {
                    return new ToolMessage({
                        tool_call_id: m.toolCallId,
                        content: content
                    });
                }
                return new HumanMessage({ content });
            });
            input = { messages: validMessages };
        }

        const stream = await graph.streamEvents(
            input,
            {
                version: "v2",
                configurable: { thread_id: threadId },
                recursionLimit: 100, // Higher limit for complex tasks with many tool calls
            }
        );

        return createUIMessageStreamResponse({
            stream: processStream(stream, autoApprove)
        });

    } catch (error) {
        console.error('[API Error]:', error);
        return new Response(
            JSON.stringify({
                error: error instanceof Error ? error.message : 'Internal server error'
            }),
            {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}

function getPhaseFromNode(node: string): AgentPhase {
    switch (node) {
        case 'planner':
            return 'planning';
        case 'generate':
            return 'execution';
        case 'reflect':
            return 'reflection';
        case 'revise':
            return 'revision';
        case 'final':
            return 'final';
        default:
            return 'text';
    }
}

function getPhaseMarker(phase: AgentPhase): string {
    switch (phase) {
        case 'planning':
            return 'PLANNING_PHASE_START\n';
        case 'execution':
            return 'EXECUTION_PHASE_START\n';
        case 'reflection':
            return 'REFLECTION_PHASE_START\n';
        case 'revision':
            return 'REVISION_PHASE_START\n';
        case 'final':
            return 'FINAL_PHASE_START\n';
        default:
            return '';
    }
}

function processStream(stream: any, autoApprove: boolean): ReadableStream<UIMessageChunk> {
    return new ReadableStream({
        async start(controller) {
            let partCounter = 0;
            let currentPartId = "";
            let streamStarted = false;
            let currentPhase: AgentPhase = 'text';
            let activeNode: string = "";

            const safeEnqueue = (chunk: any) => {
                try {
                    controller.enqueue(chunk);
                } catch (e) {
                    return false;
                }
                return true;
            };

            try {
                if (!safeEnqueue({ type: 'start' })) return;

                for await (const event of stream) {
                    try {
                        if (event.event === "on_chat_model_start") {
                            const node = event.metadata?.langgraph_node;
                            activeNode = node || "";
                            currentPhase = getPhaseFromNode(node);

                            partCounter++;
                            currentPartId = partCounter.toString();
                            streamStarted = false;

                            // Use 'reasoning' type for all phases except final text
                            const chunkType = currentPhase !== 'text' ? 'reasoning' : 'text';

                            if (!safeEnqueue({ type: `${chunkType}-start` as any, id: currentPartId })) break;
                            streamStarted = true;

                            // Inject phase marker
                            const phaseMarker = getPhaseMarker(currentPhase);
                            if (phaseMarker && streamStarted) {
                                safeEnqueue({
                                    type: `${chunkType}-delta` as any,
                                    id: currentPartId,
                                    delta: phaseMarker,
                                });
                            }
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
                                const chunkType = currentPhase !== 'text' ? 'reasoning' : 'text';
                                if (!safeEnqueue({
                                    type: `${chunkType}-delta` as any,
                                    id: currentPartId,
                                    delta: text,
                                })) break;
                            }
                        }
                        else if (event.event === "on_chat_model_end") {
                            if (streamStarted) {
                                const chunkType = currentPhase !== 'text' ? 'reasoning' : 'text';
                                if (!safeEnqueue({ type: `${chunkType}-end` as any, id: currentPartId })) break;
                                streamStarted = false;
                            }

                            // When autoApprove is OFF, emit tool approval requests
                            // (Graph will be interrupted before tools node)
                            if (!autoApprove) {
                                const output = event.data?.output;
                                if (output && output.tool_calls && output.tool_calls.length > 0) {
                                    console.log(`[Stream] Found ${output.tool_calls.length} pending tool calls - awaiting approval`);

                                    for (const toolCall of output.tool_calls) {
                                        const toolId = toolCall.id || `tool-${Date.now()}`;
                                        const toolName = toolCall.name;
                                        const toolArgs = toolCall.args;

                                        // Emit tool-input-start
                                        if (!safeEnqueue({
                                            type: "tool-input-start",
                                            toolCallId: toolId,
                                            toolName: toolName,
                                        })) break;

                                        // Emit tool-input-available (this shows the approval UI)
                                        if (!safeEnqueue({
                                            type: "tool-input-available",
                                            toolCallId: toolId,
                                            toolName: toolName,
                                            input: toolArgs,
                                        })) break;
                                    }
                                }
                            }
                        }
                        else if (event.event === "on_tool_start") {
                            const { name, id } = event.data;
                            console.log(`[Stream] Tool starting: ${name}`);

                            // When auto-approve is ON, emit tool events for display
                            if (autoApprove && id) {
                                const args = event.data.input || event.data.args;

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
                            console.log(`[Stream] Tool completed: ${id}`);

                            if (id) {
                                if (!safeEnqueue({
                                    type: "tool-output-available",
                                    toolCallId: id,
                                    output: output?.content || output || "",
                                })) break;
                            }
                        }
                    } catch (innerError) {
                        console.error("Stream event error:", innerError);
                        break;
                    }
                }

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
