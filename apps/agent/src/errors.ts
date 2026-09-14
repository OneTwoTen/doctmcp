import type { CallToolResult } from "@modelcontextprotocol/server";

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
  } else {
    // Không leak thông tin nhạy cảm của máy local (đường dẫn, environment, stack) ra client
    errorPayload = {
      code: "INTERNAL_ERROR",
      message: "Internal error",
    };
  }

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(errorPayload),
      },
    ],
  };
}
