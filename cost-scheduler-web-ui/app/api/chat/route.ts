import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { streamText, convertToCoreMessages, tool } from 'ai';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Allow streaming responses up to 60 seconds
export const maxDuration = 60;

const bedrock = createAmazonBedrock({
    region: 'us-east-1',
});

export async function POST(req: Request) {
    const body = await req.json();
    const { messages } = body;

    if (!messages || !Array.isArray(messages)) {
        return new Response('Missing or invalid messages', { status: 400 });
    }

    try {
        const result = await streamText({
            model: bedrock('global.anthropic.claude-sonnet-4-5-20250929-v1:0'),
            messages: convertToCoreMessages(messages),
            maxSteps: 50,
            system: `You are an expert DevOps Agent for the Nucleus Platform with EXECUTIVE PERMISSIONS...`,
            tools: {
                execute_command: tool({
                    description: 'Execute a shell command on the host system.',
                    inputSchema: z.object({
                        command: z.string().describe('The complete shell command to execute'),
                    }),
                    execute: async ({ command }) => {
                        try {
                            console.log(`[Agent] Executing command: ${command}`);
                            const { stdout, stderr } = await execAsync(command, { timeout: 20000 });
                            const output = stdout || stderr || 'Command executed successfully with no output.';
                            console.log(`[Agent] Command Output Length: ${output.length}`);
                            if (output.length < 500) console.log(`[Agent] Output Preview: ${output}`);
                            return output;
                        } catch (error: any) {
                            console.error(`[Agent] Command execution failed: ${error.message}`);
                            return `Error: ${error.message}`;
                        }
                    },
                }),
            },

            // Let the provider surface reasoning parts
            providerOptions: {
                bedrock: {
                    reasoningConfig: {
                        type: 'enabled',
                        budgetTokens: 4096, // reasonable default; adjust as needed
                    },
                },
            },

            onChunk(event: any) {
                // For debugging: see what chunk types you actually get
                console.log('[Chunk type]', event.type, 'chunk:', event);
            },

            onStepFinish(step: any) {
                console.log(
                    '[Step Debug]',
                    JSON.stringify(
                        {
                            finishReason: step.finishReason,
                            toolCalls: step.toolCalls.map((tc: any) => tc.toolName),
                            text: step.text,
                            reasoning: step.reasoning, // may be present on newer SDK versions
                        },
                        null,
                        2,
                    ),
                );
            },

            onFinish({ text, reasoning, usage, finishReason }: any) {
                console.log('[Reasoning]:', reasoning);
                console.log('[Text Response]:', text);
                console.log('[Token Usage]:', usage);
                console.log('[Final Finish Reason]:', finishReason);
            },
        } as any);


        // Robust fallback for stream response generation across AI SDK versions
        const streamResult = result as any;

        if (typeof streamResult.toDataStreamResponse === 'function') {
            return streamResult.toDataStreamResponse();
        }

        if (typeof streamResult.toUIMessageStreamResponse === 'function') {
            return streamResult.toUIMessageStreamResponse();
        }

        if (typeof streamResult.toTextStreamResponse === 'function') {
            console.warn('toDataStreamResponse/toUIMessageStreamResponse missing, using toTextStreamResponse (tools may not stream correctly)');
            return streamResult.toTextStreamResponse();
        }

        console.error("StreamText Result missing standard stream methods. Keys:", Object.keys(streamResult));
        throw new Error('AI SDK Compatibility: No valid stream response method found.');

    } catch (error) {
        console.error("Chat API Error:", error);
        console.error("Note: This often indicates MISSING AWS CREDENTIALS or Invalid Region.");
        if (JSON.stringify(error).includes("CredentialsProviderError")) {
            return new Response(JSON.stringify({
                error: 'Configuration Error',
                details: 'AWS Credentials Missing',
                hint: "Please set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in .env.local"
            }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({
            error: 'Internal Server Error',
            details: String(error)
        }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
}
