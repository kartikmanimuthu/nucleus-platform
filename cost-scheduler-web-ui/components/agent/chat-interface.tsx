'use client';

import { useChat } from '@ai-sdk/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Send, Bot, User, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

// AI elements
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from '@/components/ai-elements/reasoning';
import {
  Tool,
  ToolTrigger,
  ToolContent,
  ToolHeader,
} from '@/components/ai-elements/tool';

export function ChatInterface() {
  const [input, setInput] = useState('');
  const { messages, sendMessage, status, setMessages } = useChat({
    api: '/api/chat',
    maxSteps: 30,
  } as any);

  const isLoading = status === 'streaming' || status === 'submitted';

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInput(e.target.value);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input?.trim() || isLoading) return;

    const text = input.trim();
    setInput('');

    await sendMessage({
      text,
    } as any);
  };

  const handleClear = () => {
    setMessages([]);
  };

  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      setTimeout(() => {
        scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 100);
    }
  }, [messages, status]);

  return (
    <div className="flex flex-col h-[calc(100vh-theme(spacing.16))] md:h-[calc(100vh-6rem)] max-w-4xl mx-auto w-full border rounded-xl overflow-hidden shadow-sm bg-background">
      {/* Header */}
      <div className="p-4 border-b bg-muted/30 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bot className="w-5 h-5 text-primary" />
          <h2 className="font-semibold">Nucleus DevOps Agent</h2>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleClear}
          title="Clear Chat"
        >
          <Trash2 className="w-4 h-4 text-muted-foreground" />
        </Button>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 p-4">
        <div className="space-y-6">
          {messages.length === 0 && (
            <div className="text-center text-muted-foreground py-10">
              <Bot className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p>Hello! I'm your DevOps assistant.</p>
              <p className="text-sm">
                I have &quot;executive permission&quot; to check your system.
              </p>
              <p className="text-xs mt-2 text-muted-foreground/60">
                Try asking: &quot;List files in current directory&quot;
              </p>
            </div>
          )}

          {messages.map((m: any) => (
            <div
              key={m.id}
              className={cn(
                'flex gap-3',
                m.role === 'user' ? 'justify-end' : 'justify-start',
              )}
            >
              {m.role !== 'user' && (
                <Avatar className="w-8 h-8 border mt-1">
                  <AvatarFallback className="bg-primary/10">
                    <Bot className="w-4 h-4" />
                  </AvatarFallback>
                </Avatar>
              )}

              <div
                className={cn(
                  'flex flex-col gap-2 max-w-[85%]',
                  m.role === 'user' ? 'items-end' : 'items-start',
                )}
              >
                <div
                  className={cn(
                    'rounded-lg px-4 py-2',
                    m.role === 'user'
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-secondary text-secondary-foreground',
                  )}
                >
                  <div className="whitespace-pre-wrap">
                    {m.parts ? (
                      m.parts.map((p: any, i: number) => {
                        if (p.type === 'reasoning') {
                          return (
                            <div
                              key={i}
                              className="mb-2 w-full min-w-[300px]"
                            >
                              <Reasoning
                                defaultValue={
                                  m.id ===
                                  messages[messages.length - 1].id
                                    ? 'open'
                                    : 'closed'
                                }
                              >
                                <ReasoningTrigger>
                                  {m.id ===
                                    messages[messages.length - 1].id &&
                                  isLoading ? (
                                    <span className="flex items-center gap-2">
                                      <span className="animate-pulse">
                                        Reasoning...
                                      </span>
                                    </span>
                                  ) : (
                                    'Reasoning Process'
                                  )}
                                </ReasoningTrigger>
                                <ReasoningContent>
                                  {p.text}
                                </ReasoningContent>
                              </Reasoning>
                            </div>
                          );
                        }
                        if (p.type === 'text') {
                          return <span key={i}>{p.text}</span>;
                        }
                        return null;
                      })
                    ) : (
                      m.content
                    )}
                  </div>
                </div>

              {/* Tool Invocations */}
                {(() => {
                  // Handle Vercel AI SDK 5.0+ parts where tool invocations are flat parts with dynamic types (e.g., 'tool-execute_command')
                  // We filter for parts that have a toolCallId and map them to the format expected by the UI
                  const toolParts =
                    m.parts?.filter(
                      (p: any) =>
                        p.toolCallId &&
                        p.type !== 'tool-invocation' && // Avoid double counting if 'tool-invocation' is used in future
                        p.type.startsWith('tool-'),
                    ) || [];

                  const partsToolInvocations = toolParts.map((p: any) => ({
                    toolCallId: p.toolCallId,
                    toolName: p.type.replace(/^tool-/, ''),
                    args: p.input || {},
                    result: p.output,
                  }));

                  const toolInvocations =
                    m.toolInvocations?.length > 0
                      ? m.toolInvocations
                      : partsToolInvocations.length > 0
                        ? partsToolInvocations
                        : m.parts
                            ?.filter((p: any) => p.type === 'tool-invocation')
                            .map((p: any) => p.toolInvocation) || [];

                  return toolInvocations.map((toolInvocation: any) => {
                    const toolCallId = toolInvocation.toolCallId;
                    const hasResult = 'result' in toolInvocation;
                    const result = toolInvocation.result;
                    const args = toolInvocation.args;
                    const toolName = toolInvocation.toolName;

                    return (
                      <div
                        key={toolCallId}
                        className="w-full min-w-[300px] mt-1"
                      >
                        <Tool defaultOpen={!hasResult}>
                          <ToolTrigger>
                            <ToolHeader
                              toolName={toolName}
                              state={hasResult ? 'result' : 'running'}
                            />
                          </ToolTrigger>
                          <ToolContent>
                            <div className="space-y-2">
                              <div className="text-xs text-muted-foreground font-mono bg-muted/30 p-2 rounded">
                                <span className="font-semibold select-none">
                                  ${' '}
                                </span>
                                {args.command || JSON.stringify(args)}
                              </div>

                              {hasResult && (
                                <div className="mt-2">
                                  <div className="text-xs font-semibold mb-1 opacity-70">
                                    Output:
                                  </div>
                                  <div className="max-h-60 overflow-y-auto text-xs font-mono bg-black/5 dark:bg-white/5 p-2 rounded whitespace-pre-wrap">
                                    {typeof result === 'string'
                                      ? result
                                      : JSON.stringify(result, null, 2)}
                                  </div>
                                </div>
                              )}
                            </div>
                          </ToolContent>
                        </Tool>
                      </div>
                    );
                  });
                })()}
              </div>

              {m.role === 'user' && (
                <Avatar className="w-8 h-8 border mt-1">
                  <AvatarFallback className="bg-muted">
                    <User className="w-4 h-4" />
                  </AvatarFallback>
                </Avatar>
              )}
            </div>
          ))}

          <div ref={scrollRef} />
        </div>
      </ScrollArea>

      {/* Input */}
      <div className="p-4 border-t bg-background">
        <form onSubmit={handleSubmit} className="flex gap-2">
          <Input
            value={input}
            onChange={handleInputChange}
            placeholder="Type a command or ask a question..."
            className="flex-1"
            disabled={isLoading}
          />
          <Button type="submit" disabled={isLoading || !input.trim()}>
            <Send className="w-4 h-4" />
          </Button>
        </form>
      </div>
    </div>
  );
}
