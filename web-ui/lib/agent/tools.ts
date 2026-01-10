import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';

// Re-export AWS credentials tool
export { getAwsCredentialsTool } from './aws-credentials-tool';

const execAsync = promisify(exec);

// --- Execute Command Tool ---
export const executeCommandTool = tool(
    async ({ command }: { command: string }) => {
        console.log(`[Tool] Executing command: ${command}`);

        try {
            const { stdout, stderr } = await execAsync(command, {
                timeout: 30000, // 30 second timeout
                maxBuffer: 1024 * 1024 * 10, // 10MB buffer
            });

            const output = stdout || stderr || 'Command executed successfully (no output)';
            console.log(`[Tool] Command Output Length: ${output.length}`);

            return output;
        } catch (error: any) {
            const errorMsg = `Command failed: ${error.message}\n${error.stderr || ''}`;
            console.error(`[Tool] Command Error:`, errorMsg);
            return errorMsg;
        }
    },
    {
        name: 'execute_command',
        description: 'Execute a shell command on the system. Use this to check system status, list files, inspect processes, or run AWS CLI commands. Always sanitize and validate commands for security.',
        schema: z.object({
            command: z.string().describe('The shell command to execute'),
        }),
    }
);

// --- Read File Tool ---
export const readFileTool = tool(
    async ({ file_path }: { file_path: string }) => {
        console.log(`[Tool] Reading file: ${file_path}`);

        try {
            const content = await fs.readFile(file_path, 'utf-8');
            console.log(`[Tool] File read successfully, length: ${content.length}`);
            return content;
        } catch (error: any) {
            const errorMsg = `Error reading file: ${error.message}`;
            console.error(`[Tool] Read Error:`, errorMsg);
            return errorMsg;
        }
    },
    {
        name: 'read_file',
        description: 'Read the contents of a file at the given path.',
        schema: z.object({
            file_path: z.string().describe('The absolute path to the file to read'),
        }),
    }
);

// --- Write File Tool ---
export const writeFileTool = tool(
    async ({ file_path, content }: { file_path: string; content: string }) => {
        console.log(`[Tool] Writing file: ${file_path}`);

        try {
            // Ensure directory exists
            const dir = path.dirname(file_path);
            if (dir && dir !== '.') {
                await fs.mkdir(dir, { recursive: true });
            }

            await fs.writeFile(file_path, content, 'utf-8');
            console.log(`[Tool] File written successfully`);
            return `Successfully written to '${file_path}'.`;
        } catch (error: any) {
            const errorMsg = `Error writing file: ${error.message}`;
            console.error(`[Tool] Write Error:`, errorMsg);
            return errorMsg;
        }
    },
    {
        name: 'write_file',
        description: 'Write content to a file at the given path. Creates the file and parent directories if they do not exist. Overwrites existing content.',
        schema: z.object({
            file_path: z.string().describe('The absolute path to the file to write'),
            content: z.string().describe('The content to write to the file'),
        }),
    }
);

// --- List Directory Tool ---
export const listDirectoryTool = tool(
    async ({ path: dirPath }: { path: string }) => {
        console.log(`[Tool] Listing directory: ${dirPath}`);

        try {
            const items = await fs.readdir(dirPath, { withFileTypes: true });
            const listing = items.map(item => {
                const type = item.isDirectory() ? '[DIR]' : '[FILE]';
                return `${type} ${item.name}`;
            }).join('\n');

            console.log(`[Tool] Directory listed, ${items.length} items`);
            return listing || '(Empty directory)';
        } catch (error: any) {
            const errorMsg = `Error listing directory: ${error.message}`;
            console.error(`[Tool] List Error:`, errorMsg);
            return errorMsg;
        }
    },
    {
        name: 'list_directory',
        description: 'List the contents of a directory at the given path.',
        schema: z.object({
            path: z.string().describe('The path to the directory to list').default('.'),
        }),
    }
);

// --- Web Search Tool (Tavily) ---
export const webSearchTool = tool(
    async ({ query }: { query: string }) => {
        console.log(`[Tool] Web search: ${query}`);

        const apiKey = process.env.TAVILY_API_KEY;
        if (!apiKey) {
            return 'Error: TAVILY_API_KEY not configured in environment variables.';
        }

        try {
            const response = await fetch('https://api.tavily.com/search', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    api_key: apiKey,
                    query,
                    max_results: 5,
                    include_answer: true,
                    include_raw_content: false,
                }),
            });

            if (!response.ok) {
                throw new Error(`Tavily API error: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();

            let result = '';
            if (data.answer) {
                result += `**Answer:** ${data.answer}\n\n`;
            }

            if (data.results && data.results.length > 0) {
                result += '**Sources:**\n';
                for (const r of data.results.slice(0, 3)) {
                    result += `- [${r.title}](${r.url})\n  ${r.content?.slice(0, 200)}...\n\n`;
                }
            }

            console.log(`[Tool] Search completed, found ${data.results?.length || 0} results`);
            return result || 'No results found.';
        } catch (error: any) {
            const errorMsg = `Web search error: ${error.message}`;
            console.error(`[Tool] Search Error:`, errorMsg);
            return errorMsg;
        }
    },
    {
        name: 'web_search',
        description: 'Search the web for information using Tavily. Returns an answer and relevant sources.',
        schema: z.object({
            query: z.string().describe('The search query'),
        }),
    }
);
