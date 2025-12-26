import fs from 'fs';
import path from 'path';

export interface Thread {
    id: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    model?: string;
}

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const THREADS_FILE = path.join(DATA_DIR, 'threads.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Ensure threads file exists
if (!fs.existsSync(THREADS_FILE)) {
    fs.writeFileSync(THREADS_FILE, JSON.stringify([]));
}

export class ThreadStore {
    private getAllThreads(): Thread[] {
        try {
            const data = fs.readFileSync(THREADS_FILE, 'utf-8');
            return JSON.parse(data);
        } catch (error) {
            console.error('Error reading threads file:', error);
            return [];
        }
    }

    private saveThreads(threads: Thread[]): void {
        try {
            fs.writeFileSync(THREADS_FILE, JSON.stringify(threads, null, 2));
        } catch (error) {
            console.error('Error writing threads file:', error);
        }
    }

    async listThreads(): Promise<Thread[]> {
        return this.getAllThreads().sort((a, b) => b.updatedAt - a.updatedAt);
    }

    async getThread(id: string): Promise<Thread | undefined> {
        const threads = this.getAllThreads();
        return threads.find(t => t.id === id);
    }

    async createThread(id: string, title: string = "New Chat", model?: string): Promise<Thread> {
        const threads = this.getAllThreads();
        const newThread: Thread = {
            id,
            title,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            model
        };
        threads.push(newThread);
        this.saveThreads(threads);
        return newThread;
    }

    async updateThread(id: string, updates: Partial<Thread>): Promise<Thread | undefined> {
        const threads = this.getAllThreads();
        const index = threads.findIndex(t => t.id === id);
        if (index === -1) return undefined;

        threads[index] = {
            ...threads[index],
            ...updates,
            updatedAt: Date.now()
        };
        this.saveThreads(threads);
        return threads[index];
    }

    async deleteThread(id: string): Promise<boolean> {
        let threads = this.getAllThreads();
        const initialLength = threads.length;
        threads = threads.filter(t => t.id !== id);

        if (threads.length !== initialLength) {
            this.saveThreads(threads);

            // Also try to delete the checkpoint file if it exists
            try {
                const checkpointFile = path.join(DATA_DIR, `${id}.json`);
                if (fs.existsSync(checkpointFile)) {
                    fs.unlinkSync(checkpointFile);
                }
            } catch (e) {
                // Ignore error if checkpoint file doesn't exist
            }
            return true;
        }
        return false;
    }
}

export const threadStore = new ThreadStore();
