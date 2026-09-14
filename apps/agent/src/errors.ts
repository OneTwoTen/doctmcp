export type ToolErrorCode =
  | "INVALID_INPUT"
  | "WORKSPACE_NOT_FOUND"
  | "PATH_NOT_FOUND"
  | "PATH_OUTSIDE_WORKSPACE"
  | "PERMISSION_DENIED"
  | "ALREADY_EXISTS"
  | "TIMEOUT"
  | "OUTPUT_LIMIT_EXCEEDED"
  | "PROCESS_FAILED"
  | "INTERNAL_ERROR";

export class ToolDomainError extends Error {
  readonly code: ToolErrorCode;
  readonly details?: unknown;

  constructor(code: ToolErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ToolDomainError";
    this.code = code;
    this.details = details;
  }
}

export class DuplicateToolError extends Error {
  constructor(toolName: string) {
    super(`Tool '${toolName}' is already registered`);
    this.name = "DuplicateToolError";
  }
}

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface StructuredToolError {
  code: ToolErrorCode;
  message: string;
  details?: unknown;
}

export function toToolErrorResult(error: unknown): CallToolResult {
  let errorPayload: StructuredToolError;

  if (error instanceof ToolDomainError) {
    errorPayload = {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
  } else if (error instanceof Error) {
    errorPayload = {
      code: "INTERNAL_ERROR",
      message: error.message,
    };
  } else {
    errorPayload = {
      code: "INTERNAL_ERROR",
      message: String(error),
    };
  }

  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(errorPayload),
      },
    ],
  };
}
