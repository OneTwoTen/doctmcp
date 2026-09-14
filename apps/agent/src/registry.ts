import type { CallToolResult } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { DuplicateToolError } from "./errors";

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolContext {
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
  inputSchema?: TInputSchema;
  outputSchema?: TOutputSchema;
  annotations?: ToolAnnotations;
  handler: (
    args: z.infer<TInputSchema>,
    context: ToolContext,
  ) => Promise<ToolExecutionResult>;
}

export class ToolRegistry {
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool definitions collection
  private readonly tools = new Map<string, ToolDefinition<any, any>>();

  register<
    TInputSchema extends z.ZodTypeAny = z.ZodTypeAny,
    TOutputSchema extends z.ZodTypeAny = z.ZodTypeAny,
  >(tool: ToolDefinition<TInputSchema, TOutputSchema>): void {
    if (this.tools.has(tool.name)) {
      throw new DuplicateToolError(tool.name);
    }
    this.tools.set(tool.name, tool);
  }

  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tool retrieval
  get(name: string): ToolDefinition<any, any> | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous tools collection
  list(): ToolDefinition<any, any>[] {
    return Array.from(this.tools.values());
  }

  get size(): number {
    return this.tools.size;
  }
}
