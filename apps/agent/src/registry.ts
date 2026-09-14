import type { CallToolResult } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { DuplicateToolError } from "./errors";

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export type ToolRequestId = string | number;

export interface ToolContext {
  signal: AbortSignal;
  requestId?: ToolRequestId;
  sessionId?: string;
  meta?: Record<string, unknown>;
  extra?: unknown;
}

export type ToolExecutionResult = CallToolResult;

export interface ToolDefinition<
  TInputSchema extends z.ZodTypeAny = z.ZodTypeAny,
  TOutputSchema extends z.ZodTypeAny = z.ZodTypeAny,
> {
  name: string;
  title?: string;
  description: string;
  inputSchema: TInputSchema;
  outputSchema?: TOutputSchema;
  annotations?: ToolAnnotations;
  handler: (
    args: z.infer<TInputSchema>,
    context: ToolContext,
  ) => Promise<ToolExecutionResult>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Readonly<ToolDefinition>>();

  register<
    TInputSchema extends z.ZodTypeAny = z.ZodTypeAny,
    TOutputSchema extends z.ZodTypeAny = z.ZodTypeAny,
  >(
    tool: ToolDefinition<TInputSchema, TOutputSchema>,
  ): Readonly<ToolDefinition<TInputSchema, TOutputSchema>> {
    if (this.tools.has(tool.name)) {
      throw new DuplicateToolError(tool.name);
    }
    const frozenAnnotations = tool.annotations
      ? Object.freeze({ ...tool.annotations })
      : undefined;
    const frozenTool: Readonly<ToolDefinition<TInputSchema, TOutputSchema>> =
      Object.freeze({
        ...tool,
        ...(frozenAnnotations ? { annotations: frozenAnnotations } : {}),
      });
    this.tools.set(tool.name, frozenTool);
    return frozenTool;
  }

  get(name: string): Readonly<ToolDefinition> | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): readonly Readonly<ToolDefinition>[] {
    return Object.freeze(Array.from(this.tools.values()));
  }

  get size(): number {
    return this.tools.size;
  }
}
