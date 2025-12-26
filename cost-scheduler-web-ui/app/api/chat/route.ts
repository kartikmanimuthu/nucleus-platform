import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { createUIMessageStreamResponse, UIMessageChunk } from 'ai';
import { createReflectionGraph, createFastGraph } from '@/lib/agent/graph-factory';

export const maxDuration = 300; // 5 minutes for complex multi-iteration tasks

// Phase types for UI segregation
type AgentPhase = 'planning' | 'execution' | 'reflection' | 'revision' | 'final' | 'text';

interface Message {
    role: string;
    content: string;
    toolCallId?: string;
    toolInvocations?: Array<{
        toolName: string;
        args: Record<string, unknown>;
        toolCallId: string;
    }>;
    parts?: Array<{
        type: string;
        text: string;
    }>;
}

export async function POST(req: Request) {
    try {
        const { messages, threadId: requestThreadId, autoApprove = true, model, mode = 'plan' } = await req.json();
        const threadId = requestThreadId || Date.now().toString();

        // Ensure thread exists in store
        // We do this asynchronously to not block the chat start, or we can await it.
        // Importing dynamically to avoid circular deps if any, but regular import is fine.
        const { threadStore } = await import('@/lib/store/thread-store');
        const existing = await threadStore.getThread(threadId);
        if (!existing) {
            const firstUserMsg = messages.find((m: Message) => m.role === 'user');
            const title = firstUserMsg?.content
                ? (typeof firstUserMsg.content === 'string' ? firstUserMsg.content.slice(0, 30) : "New Conversation")
                : "New Chat";
            await threadStore.createThread(threadId, title, model);
        } else if (model) {
            // Update model if changed?
            // await threadStore.updateThread(threadId, { model });
        }

        console.log(`\n🚀 [API] New Request Started`);
        console.log(`   Thread ID:    ${threadId}`);
        console.log(`   Auto-Approve: ${autoApprove}`);
        console.log(`   Model:        ${model || 'Default'}`);
        console.log(`   Mode:         ${mode}`);
        console.log(`   Timestamp:    ${new Date().toISOString()}`);

        // Create graph with configuration
        const graphConfig = {
            model: model || 'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
            autoApprove: autoApprove
        };

        const graph = mode === 'fast'
            ? createFastGraph(graphConfig)
            : createReflectionGraph(graphConfig);

        const lastMessage = messages[messages.length - 1];
        let input: { messages: (HumanMessage | AIMessage | ToolMessage)[] } | null = null;
        const config = { configurable: { thread_id: threadId } };

        if (lastMessage.role === 'tool') {
            // Tool result (Human-in-the-Loop approval)
            console.log(`[API] Processing tool result: ${lastMessage.toolCallId}`);

            // "Approved" means "Execute the real tool"
            // So we DO NOT add this message to the state, we just resume
            if (lastMessage.content === 'Approved') {
                console.log(`✅ [API] User Approved Execution logic. Resuming...`);
            }
            // Any other content (e.g. "Cancelled by user") is treated as a mock result
            // So we ADD it to state, effectively skipping the real tool execution
            else {
                console.log(`⚠️ [API] User Rejected/Cancelled. Providing Feedback: "${lastMessage.content.substring(0, 50)}..."`);
                const toolMessage = new ToolMessage({
                    tool_call_id: lastMessage.toolCallId || '',
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
            const validMessages = messagesToProcess.map((m: Message) => {
                let content = m.content;
                if (!content && m.parts) {
                    content = m.parts
                        .filter((p) => p.type === 'text')
                        .map((p) => p.text)
                        .join('');
                }
                content = content || "";

                if (m.role === 'user') {
                    return new HumanMessage({ content });
                } else if (m.role === 'assistant') {
                    const toolCalls = m.toolInvocations?.map((ti) => ({
                        name: ti.toolName,
                        args: ti.args,
                        id: ti.toolCallId,
                        type: "tool_call" as const
                    })) || [];

                    return new AIMessage({
                        content: content,
                        tool_calls: toolCalls
                    });
                } else if (m.role === 'tool') {
                    return new ToolMessage({
                        tool_call_id: m.toolCallId || '',
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
        case 'agent':
            return 'execution';
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

interface StreamEvent {
    event: string;
    metadata?: {
        langgraph_node?: string;
    };
    data?: {
        chunk?: {
            content: string | Array<{ type: string; text: string }>;
        };
        output?: {
            tool_calls?: Array<{
                id?: string;
                name: string;
                args: Record<string, unknown>;
            }>;
        };
        name?: string;
        id?: string;
        input?: Record<string, unknown>;
        args?: Record<string, unknown>;
    };
}

function processStream(stream: AsyncIterable<StreamEvent>, autoApprove: boolean): ReadableStream<UIMessageChunk> {
    return new ReadableStream({
        async start(controller) {
            let partCounter = 0;
            let currentPartId = "";
            let streamStarted = false;
            let currentPhase: AgentPhase = 'text';
            let activeNode: string = "";

            const safeEnqueue = (chunk: UIMessageChunk) => {
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
                            currentPhase = getPhaseFromNode(node || "");

                            partCounter++;
                            currentPartId = partCounter.toString();
                            streamStarted = false;

                            // Use 'reasoning' type for all phases except final text
                            const chunkType = currentPhase !== 'text' ? 'reasoning' : 'text';

                            if (!safeEnqueue({ type: `${chunkType}-start` as 'reasoning-start' | 'text-start', id: currentPartId })) break;
                            streamStarted = true;

                            // Inject phase marker
                            const phaseMarker = getPhaseMarker(currentPhase);
                            if (phaseMarker && streamStarted) {
                                safeEnqueue({
                                    type: `${chunkType}-delta` as 'reasoning-delta' | 'text-delta',
                                    id: currentPartId,
                                    delta: phaseMarker,
                                });
                            }
                        }
                        else if (event.event === "on_chat_model_stream") {
                            const content = event.data?.chunk?.content;
                            let text = "";
                            if (typeof content === "string") {
                                text = content;
                            } else if (Array.isArray(content)) {
                                text = content
                                    .filter((c) => c.type === 'text')
                                    .map((c) => c.text)
                                    .join('');
                            }

                            if (text && streamStarted) {
                                const chunkType = currentPhase !== 'text' ? 'reasoning' : 'text';
                                if (!safeEnqueue({
                                    type: `${chunkType}-delta` as 'reasoning-delta' | 'text-delta',
                                    id: currentPartId,
                                    delta: text,
                                })) break;
                            }
                        }
                        else if (event.event === "on_chat_model_end") {
                            if (streamStarted) {
                                const chunkType = currentPhase !== 'text' ? 'reasoning' : 'text';
                                if (!safeEnqueue({ type: `${chunkType}-end` as 'reasoning-end' | 'text-end', id: currentPartId })) break;
                                streamStarted = false;
                            }

                            // When autoApprove is OFF, emit tool approval requests
                            // (Graph will be interrupted before tools node)
                            if (!autoApprove) {
                                const output = event.data?.output;
                                if (output && output.tool_calls && output.tool_calls.length > 0) {
                                    console.log(`🛑 [Stream] Pausing for Human Approval: ${output.tool_calls.length} tools pending.`);

                                    for (const toolCall of output.tool_calls) {
                                        const toolId = toolCall.id || `tool-${Date.now()}`;
                                        const toolName = toolCall.name;
                                        const toolArgs = toolCall.args;

                                        console.log(`   ❓ Requesting approval for: ${toolName}`);
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
                            const { name, id } = event.data || {};
                            console.log(`▶️  [Stream] Tool Start: ${name} (ID: ${id})`);

                            // When auto-approve is ON, emit tool events for display
                            if (autoApprove && id) {
                                const args = event.data?.input || event.data?.args;

                                if (!safeEnqueue({
                                    type: "tool-input-start",
                                    toolCallId: id,
                                    toolName: name || '',
                                })) break;

                                if (!safeEnqueue({
                                    type: "tool-input-available",
                                    toolCallId: id,
                                    toolName: name || '',
                                    input: args || {},
                                })) break;
                            }
                        }
                        else if (event.event === "on_tool_end") {
                            const { output, id } = event.data || {};
                            console.log(`◀️  [Stream] Tool End: ${id}`);

                            if (id) {
                                const outputContent = typeof output === 'object' && output !== null && 'content' in output
                                    ? (output as { content: string }).content
                                    : output || "";

                                if (!safeEnqueue({
                                    type: "tool-output-available",
                                    toolCallId: id,
                                    output: outputContent,
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
                } catch (e) {
                    // Controller already closed
                }
            } catch (error) {
                console.error("Stream processing loop error:", error);
                try {
                    controller.error(error);
                } catch (e) {
                    // Controller already errored
                }
            }
        }
    });
}
