import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalMcpRuntime } from "./local-mcp-runtime";
import { createMcpTestHarness, type McpTestHarness } from "./test-harness";
import { WorkspaceRegistry } from "./workspace";

type SchemaRecord = Record<string, unknown>;

interface ObjectContract {
  properties: readonly string[];
  required: readonly string[];
  constraints?: Readonly<Record<string, SchemaRecord>>;
}

interface ToolContract {
  description: string;
  annotations: SchemaRecord;
  actions?: Readonly<Record<string, ObjectContract>>;
  object?: ObjectContract;
}

const expectedCatalog: Readonly<Record<string, ToolContract>> = {
  workspace: {
    description: "List and inspect configured local workspaces",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    actions: {
      list: {
        properties: ["action"],
        required: ["action"],
      },
      get: {
        properties: ["action", "workspace"],
        required: ["action", "workspace"],
        constraints: {
          workspace: { type: "string", minLength: 1 },
        },
      },
    },
  },
  system: {
    description: "Read basic local system information and resolve executables",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    actions: {
      info: {
        properties: ["action"],
        required: ["action"],
      },
      which: {
        properties: ["action", "command"],
        required: ["action", "command"],
        constraints: {
          command: { type: "string", minLength: 1, maxLength: 1024 },
        },
      },
    },
  },
  "filesystem.read": {
    description:
      "Read-only filesystem operations inside workspace (read, list, stat, search)",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    actions: {
      read: {
        properties: ["action", "workspace", "path", "offset", "limit"],
        required: ["action", "workspace", "path"],
        constraints: {
          workspace: { type: "string", minLength: 1 },
          path: { type: "string", minLength: 1 },
          offset: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 1, maximum: 1048576 },
        },
      },
      list: {
        properties: [
          "action",
          "workspace",
          "path",
          "recursive",
          "limit",
          "maxDepth",
        ],
        required: ["action", "workspace"],
        constraints: {
          workspace: { type: "string", minLength: 1 },
          path: { type: "string" },
          recursive: { type: "boolean" },
          limit: { type: "integer", minimum: 1, maximum: 1000 },
          maxDepth: { type: "integer", minimum: 1, maximum: 10 },
        },
      },
      stat: {
        properties: ["action", "workspace", "path"],
        required: ["action", "workspace"],
        constraints: {
          workspace: { type: "string", minLength: 1 },
          path: { type: "string" },
        },
      },
      search: {
        properties: ["action", "workspace", "path", "query", "maxResults"],
        required: ["action", "workspace", "query"],
        constraints: {
          workspace: { type: "string", minLength: 1 },
          path: { type: "string" },
          query: { type: "string", minLength: 1 },
          maxResults: { type: "integer", minimum: 1, maximum: 200 },
        },
      },
    },
  },
  "filesystem.write": {
    description:
      "Create and modify files and directories inside a local workspace",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
    actions: {
      write: {
        properties: [
          "action",
          "workspace",
          "path",
          "content",
          "overwrite",
          "createParents",
        ],
        required: ["action", "workspace", "path", "content"],
        constraints: {
          workspace: { type: "string", minLength: 1 },
          path: { type: "string", minLength: 1 },
          content: { type: "string" },
          overwrite: { type: "boolean" },
          createParents: { type: "boolean" },
        },
      },
      patch: {
        properties: [
          "action",
          "workspace",
          "path",
          "oldText",
          "newText",
          "expectedOccurrences",
        ],
        required: ["action", "workspace", "path", "oldText", "newText"],
        constraints: {
          workspace: { type: "string", minLength: 1 },
          path: { type: "string", minLength: 1 },
          oldText: { type: "string", minLength: 1 },
          newText: { type: "string" },
          expectedOccurrences: {
            type: "integer",
            minimum: 1,
            maximum: 1000,
          },
        },
      },
      mkdir: {
        properties: ["action", "workspace", "path", "recursive"],
        required: ["action", "workspace", "path"],
        constraints: {
          workspace: { type: "string", minLength: 1 },
          path: { type: "string", minLength: 1 },
          recursive: { type: "boolean" },
        },
      },
      move: {
        properties: ["action", "workspace", "from", "to", "overwrite"],
        required: ["action", "workspace", "from", "to"],
        constraints: {
          workspace: { type: "string", minLength: 1 },
          from: { type: "string", minLength: 1 },
          to: { type: "string", minLength: 1 },
          overwrite: { type: "boolean" },
        },
      },
    },
  },
  "filesystem.delete": {
    description: "Delete a file or directory inside a configured workspace",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
    object: {
      properties: ["workspace", "path", "recursive"],
      required: ["workspace", "path"],
      constraints: {
        workspace: { type: "string", minLength: 1 },
        path: { type: "string" },
        recursive: { type: "boolean", default: false },
      },
    },
  },
  "shell.exec": {
    description:
      "Execute a command directly inside a configured workspace with bounded output and timeout",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    object: {
      properties: ["workspace", "command", "args", "cwd", "timeoutMs"],
      required: ["workspace", "command"],
      constraints: {
        workspace: { type: "string", minLength: 1 },
        command: { type: "string", minLength: 1, maxLength: 1024 },
        args: { type: "array", default: [] },
        cwd: { type: "string", minLength: 1, default: "." },
        timeoutMs: { type: "integer", exclusiveMinimum: 0 },
      },
    },
  },
};

function asRecord(value: unknown, message: string): SchemaRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message);
  }
  return value as SchemaRecord;
}

function actionValue(schema: SchemaRecord): string | undefined {
  const properties = asRecord(
    schema.properties,
    "Expected schema object to expose properties",
  );
  const action = properties.action;
  if (typeof action !== "object" || action === null || Array.isArray(action)) {
    return undefined;
  }
  const actionSchema = action as SchemaRecord;
  if (typeof actionSchema.const === "string") return actionSchema.const;
  if (
    Array.isArray(actionSchema.enum) &&
    actionSchema.enum.length === 1 &&
    typeof actionSchema.enum[0] === "string"
  ) {
    return actionSchema.enum[0];
  }
  return undefined;
}

function findActionSchema(schema: unknown, action: string): SchemaRecord {
  if (Array.isArray(schema)) {
    for (const child of schema) {
      try {
        return findActionSchema(child, action);
      } catch {
        // Tiếp tục tìm ở branch khác.
      }
    }
    throw new Error(`Action schema '${action}' not found`);
  }
  if (typeof schema !== "object" || schema === null) {
    throw new Error(`Action schema '${action}' not found`);
  }

  const record = schema as SchemaRecord;
  if (record.properties && actionValue(record) === action) return record;

  for (const child of Object.values(record)) {
    try {
      return findActionSchema(child, action);
    } catch {
      // Tiếp tục tìm sâu hơn.
    }
  }
  throw new Error(`Action schema '${action}' not found`);
}

function assertObjectContract(
  schema: unknown,
  contract: ObjectContract,
): void {
  const record = asRecord(schema, "Expected an object JSON schema");
  const properties = asRecord(
    record.properties,
    "Expected object JSON schema properties",
  );

  expect(Object.keys(properties).sort()).toEqual([...contract.properties].sort());
  expect(
    Array.isArray(record.required)
      ? record.required.filter((value): value is string => typeof value === "string").sort()
      : [],
  ).toEqual([...contract.required].sort());
  expect(record.additionalProperties).toBe(false);

  for (const [field, expected] of Object.entries(contract.constraints ?? {})) {
    expect(asRecord(properties[field], `Expected property schema '${field}'`)).toMatchObject(
      expected,
    );
  }
}

describe("M1 tools/list contract", () => {
  const roots: string[] = [];
  const harnesses: McpTestHarness[] = [];

  afterEach(async () => {
    const closeResults = await Promise.allSettled(
      harnesses.splice(0).map((harness) => harness.close()),
    );
    const cleanupResults = await Promise.allSettled(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
    const failures = [...closeResults, ...cleanupResults].filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "M1 contract cleanup failed",
      );
    }
  });

  test("runtime production khóa exact description, annotations và input schema semantics", async () => {
    const root = await mkdtemp(join(tmpdir(), "doctmcp-m1-contract-"));
    roots.push(root);
    const registry = await WorkspaceRegistry.create([
      {
        id: "project",
        name: "Contract project",
        root,
        capabilities: {
          read: true,
          write: true,
          delete: true,
          execute: true,
        },
      },
    ]);

    const harness = await createMcpTestHarness({
      serverInstance: createLocalMcpRuntime(registry),
    });
    harnesses.push(harness);

    const listed = await harness.client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
      Object.keys(expectedCatalog).sort(),
    );

    for (const tool of listed.tools) {
      const contract = expectedCatalog[tool.name];
      expect(contract).toBeDefined();
      if (!contract) continue;

      expect(tool.description).toBe(contract.description);
      expect(tool.annotations).toEqual(contract.annotations);
      expect(tool.outputSchema).toBeDefined();

      if (contract.actions) {
        for (const [action, actionContract] of Object.entries(contract.actions)) {
          assertObjectContract(
            findActionSchema(tool.inputSchema, action),
            actionContract,
          );
        }
      } else if (contract.object) {
        assertObjectContract(tool.inputSchema, contract.object);
      } else {
        throw new Error(`Tool '${tool.name}' is missing a schema contract`);
      }
    }
  });
});
