'use client';

import { useChat } from '@ai-sdk/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Bot, User, Trash2, Loader2, Terminal, Send, ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export function ChatInterface() {
  const { 
    messages, 
    sendMessage,
    isLoading, 
    setMessages,
  } = useChat({
    api: '/api/chat',
    maxSteps: 5,
    onError: (error) => {
      console.error('Chat error:', error);
    },
  });

  const [inputValue, setInputValue] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [messages]);

  const handleClear = () => {
    setMessages([]);
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
  };

  const handleFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim() || isLoading) return;

    const value = inputValue;
    setInputValue('');
    
    await sendMessage({
      text: value
    });
  };

  return (
    <div className="flex flex-col h-[calc(100vh-theme(spacing.16))] md:h-[calc(100vh-6rem)] max-w-4xl mx-auto w-full border rounded-xl overflow-hidden shadow-lg bg-background">
      {/* Header */}
      <div className="p-4 border-b bg-gradient-to-r from-primary/10 to-primary/5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="relative">
            <Bot className="w-6 h-6 text-primary" />
            {isLoading && (
              <span className="absolute -top-1 -right-1 flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-primary"></span>
              </span>
            )}
          </div>
          <div>
            <h2 className="font-semibold text-lg">Nucleus DevOps Agent</h2>
            <p className="text-xs text-muted-foreground">
              {isLoading ? 'Processing...' : 'Ready to assist'}
            </p>
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={handleClear}
          title="Clear Chat"
          disabled={messages.length === 0}
        >
          <Trash2 className="w-4 h-4 text-muted-foreground hover:text-destructive transition-colors" />
        </Button>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 p-4">
        <div className="space-y-4">
          {messages.length === 0 && (
            <div className="text-center text-muted-foreground py-12">
              <Bot className="w-16 h-16 mx-auto mb-4 opacity-40" />
              <h3 className="text-lg font-medium mb-2">Welcome to Nucleus DevOps Agent</h3>
              <p className="text-sm mb-4">
                I have executive permissions to check your system.
              </p>
              <div className="max-w-md mx-auto space-y-2 text-xs">
                <p className="font-mono bg-muted/50 p-2 rounded cursor-pointer hover:bg-muted transition-colors" onClick={() => setInputValue("List all EC2 instances")}>
                  💡 Try: &quot;List all EC2 instances&quot;
                </p>
                <p className="font-mono bg-muted/50 p-2 rounded cursor-pointer hover:bg-muted transition-colors" onClick={() => setInputValue("Show disk usage")}>
                  💡 Try: &quot;Show disk usage&quot;
                </p>
                <p className="font-mono bg-muted/50 p-2 rounded cursor-pointer hover:bg-muted transition-colors" onClick={() => setInputValue("Check running Docker containers")}>
                  💡 Try: &quot;Check running Docker containers&quot;
                </p>
              </div>
            </div>
          )}

          {messages.map((message) => {
            return (
              <div
                key={message.id}
                className={cn(
                  'flex gap-3 animate-in fade-in slide-in-from-bottom-2 duration-300',
                  message.role === 'user' ? 'justify-end' : 'justify-start',
                )}
              >
                {message.role === 'assistant' && (
                  <Avatar className="w-8 h-8 border-2 border-primary/20 mt-1">
                    <AvatarFallback className="bg-primary/10">
                      <Bot className="w-4 h-4 text-primary" />
                    </AvatarFallback>
                  </Avatar>
                )}

                <div
                  className={cn(
                    'flex flex-col gap-2 max-w-[85%]',
                    message.role === 'user' ? 'items-end' : 'items-start',
                  )}
                >
                  {/* Render Message Parts */}
                  {message.parts && message.parts.map((keydown, index) => {
                    // Note: 'keydown' is just a variable name, strictly typing it is hard without generics
                    // Using 'part' as variable name
                    const part = keydown as any; 

                    if (part.type === 'text') {
                        return (
                            <div
                                key={`${message.id}-part-${index}`}
                                className={cn(
                                'rounded-lg px-4 py-2.5 shadow-sm',
                                message.role === 'user'
                                    ? 'bg-primary text-primary-foreground'
                                    : 'bg-secondary text-secondary-foreground border',
                                )}
                            >
                                <div className="whitespace-pre-wrap text-sm leading-relaxed">
                                {part.text || ""}
                                </div>
                            </div>
                        );
                    }
                    
                    if (part.type === 'reasoning') {
                         return (
                            <div key={`${message.id}-part-${index}`} className="w-full border rounded-lg overflow-hidden bg-muted/20 text-xs mb-2">
                                <div className="px-3 py-1.5 bg-muted/40 text-muted-foreground italic flex items-center gap-2">
                                    <Bot className="w-3 h-3" />
                                    Thought Process
                                </div>
                                <div className="p-3 whitespace-pre-wrap text-muted-foreground font-mono">
                                    {part.text || ""}
                                </div>
                            </div>
                         );
                    }

                    // Check for tool invocation (dynamic or tool-NAME)
                    if (part.type === 'dynamic-tool' || part.type.startsWith('tool-') || part.toolCallId) {
                        const toolName = part.toolName || (part.type.startsWith('tool-') ? part.type.replace('tool-', '') : 'tool');
                        const args = part.input || part.args; // standard naming is input, previous was args
                        const result = part.output || part.result;
                        const state = part.state; // 'input-streaming', 'input-available', 'output-available', 'output-error'
                        
                        const isRunning = state === 'input-streaming' || state === 'input-available' || (!result && !part.errorText);

                        return (
                            <div
                            key={part.toolCallId || `${message.id}-tool-${index}`}
                            className="w-full border rounded-lg overflow-hidden bg-muted/30 text-sm mt-2"
                            >
                            {/* Tool Header */}
                            <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 border-b">
                                <Terminal className="w-4 h-4 text-muted-foreground" />
                                <span className="font-medium text-xs">
                                {toolName}
                                </span>
                                {isRunning && (
                                <Loader2 className="w-3 h-3 animate-spin ml-auto text-muted-foreground" />
                                )}
                            </div>

                            {/* Command / Input */}
                            <div className="px-3 py-2 font-mono text-xs bg-black/5 dark:bg-white/5">
                                <span className="text-muted-foreground select-none">$ </span>
                                <span>{JSON.stringify(args)}</span>
                            </div>

                            {/* Result */}
                            {result && (
                                <div className="px-3 py-2 border-t">
                                <div className="text-xs font-semibold text-muted-foreground mb-1">
                                    Output:
                                </div>
                                <div className="max-h-60 overflow-y-auto w-full text-xs font-mono bg-black/5 dark:bg-white/5 p-2 rounded whitespace-pre-wrap break-all">
                                    {typeof result === 'string'
                                    ? result
                                    : JSON.stringify(result, null, 2)}
                                </div>
                                </div>
                            )}
                             {part.errorText && (
                                <div className="px-3 py-2 border-t bg-destructive/10 text-destructive text-xs">
                                    Error: {part.errorText}
                                </div>
                             )}
                            </div>
                        );
                    }
                    
                    return null;
                  })}
                </div>

                {message.role === 'user' && (
                  <Avatar className="w-8 h-8 border-2 border-muted mt-1">
                    <AvatarFallback className="bg-muted">
                      <User className="w-4 h-4" />
                    </AvatarFallback>
                  </Avatar>
                )}
              </div>
            );
          })}

           <div ref={scrollRef} />
        </div>
      </ScrollArea>

      <form onSubmit={handleFormSubmit} className="p-4 border-t bg-background">
        <div className="flex gap-2">
            <Input
              value={inputValue}
              onChange={handleInputChange}
              placeholder="Ask the DevOps agent to run a command..."
              className="flex-1"
              autoFocus
            />
            <Button type="submit" disabled={isLoading || !inputValue.trim()}>
                <Send className="w-4 h-4" />
            </Button>
        </div>
      </form>
    </div>
  );
}
