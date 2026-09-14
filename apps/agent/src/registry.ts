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

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ToolExecutionResult = CallToolResult;

export interface ToolDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  title?: string;
  description: string;
  inputSchema?: TSchema;
  annotations?: ToolAnnotations;
  handler: (
    args: z.infer<TSchema>,
    context: ToolContext,
  ) => Promise<ToolExecutionResult>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register<TSchema extends z.ZodTypeAny>(tool: ToolDefinition<TSchema>): void {
    if (this.tools.has(tool.name)) {
      throw new DuplicateToolError(tool.name);
    }
    this.tools.set(tool.name, tool as unknown as ToolDefinition);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  get size(): number {
    return this.tools.size;
  }
}
