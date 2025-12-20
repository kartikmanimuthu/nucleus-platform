"use client"

import * as React from "react"
import { Check, ChevronDown, Terminal, Loader2, X } from "lucide-react"
import { cn } from "@/lib/utils"
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible"

const Tool = CollapsiblePrimitive.Root

const ToolTrigger = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.CollapsibleTrigger>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.CollapsibleTrigger>
>(({ className, children, ...props }, ref) => (
  <CollapsiblePrimitive.CollapsibleTrigger
    ref={ref}
    className={cn(
      "flex w-full items-center gap-2 rounded-md p-2 text-sm font-medium transition-all hover:bg-muted/50 [&[data-state=open]>svg]:rotate-180",
      className
    )}
    {...props}
  >
    {children}
    <ChevronDown className="ml-auto h-4 w-4 transition-transform duration-200" />
  </CollapsiblePrimitive.CollapsibleTrigger>
))
ToolTrigger.displayName = "ToolTrigger"

const ToolContent = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.CollapsibleContent>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.CollapsibleContent>
>(({ className, children, ...props }, ref) => (
  <CollapsiblePrimitive.CollapsibleContent
    ref={ref}
    className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down"
    {...props}
  >
    <div className={cn("rounded-md border bg-card px-4 py-3 shadow-sm", className)}>
      {children}
    </div>
  </CollapsiblePrimitive.CollapsibleContent>
))
ToolContent.displayName = "ToolContent"

interface ToolHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  toolName?: string
  state?: 'running' | 'result' | 'call'
}

const ToolHeader = ({ toolName, state, className, ...props }: ToolHeaderProps) => {
  return (
    <div className={cn("flex items-center gap-2", className)} {...props}>
      <div className={cn(
        "flex h-6 w-6 items-center justify-center rounded-full border",
        state === 'running' ? "bg-muted text-muted-foreground" :
        state === 'result' ? "bg-primary/10 text-primary border-primary/20" :
        "bg-muted"
      )}>
        {state === 'running' ? <Loader2 className="h-3 w-3 animate-spin" /> :
         state === 'result' ? <Check className="h-3 w-3" /> :
         <Terminal className="h-3 w-3" />}
      </div>
      <span className="font-medium">{toolName || "Tool Execution"}</span>
      {state === 'running' && <span className="text-xs text-muted-foreground animate-pulse">Running...</span>}
    </div>
  )
}

export { Tool, ToolTrigger, ToolContent, ToolHeader }
