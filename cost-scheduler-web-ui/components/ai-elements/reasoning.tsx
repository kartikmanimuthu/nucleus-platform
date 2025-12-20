"use client"

import * as React from "react"
import { ChevronDown, Brain } from "lucide-react"
import { cn } from "@/lib/utils"
import * as CollapsiblePrimitive from "@radix-ui/react-collapsible"

const Reasoning = CollapsiblePrimitive.Root

const ReasoningTrigger = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.CollapsibleTrigger>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.CollapsibleTrigger>
>(({ className, children, ...props }, ref) => (
  <CollapsiblePrimitive.CollapsibleTrigger
    ref={ref}
    className={cn(
      "flex w-full items-center gap-2 rounded-md p-2 text-sm font-medium text-muted-foreground transition-all hover:text-foreground [&[data-state=open]>svg]:rotate-180",
      className
    )}
    {...props}
  >
    <Brain className="h-4 w-4" />
    {children || "Reasoning Process"}
    <ChevronDown className="ml-auto h-4 w-4 transition-transform duration-200" />
  </CollapsiblePrimitive.CollapsibleTrigger>
))
ReasoningTrigger.displayName = "ReasoningTrigger"

const ReasoningContent = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.CollapsibleContent>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.CollapsibleContent>
>(({ className, children, ...props }, ref) => (
  <CollapsiblePrimitive.CollapsibleContent
    ref={ref}
    className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down"
    {...props}
  >
    <div
      className={cn(
        "rounded-md border bg-muted/50 px-4 py-3 text-sm text-muted-foreground shadow-sm",
        className
      )}
    >
      {children}
    </div>
  </CollapsiblePrimitive.CollapsibleContent>
))
ReasoningContent.displayName = "ReasoningContent"

export { Reasoning, ReasoningTrigger, ReasoningContent }
