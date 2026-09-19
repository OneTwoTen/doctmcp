import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { deviceNameSchema } from "@doctmcp/schemas";
import { z } from "zod";
import { type WorkspaceMetadata, WorkspaceRegistry } from "./workspace";

const capabilitiesSchema = z
  .object({
    read: z.boolean().default(false),
    write: z.boolean().default(false),
    delete: z.boolean().default(false),
    execute: z.boolean().default(false),
  })
  .strict()
  .default(() => ({
    read: false,
    write: false,
    delete: false,
    execute: false,
  }));

const workspaceConfigSchema = z
  .object({
    id: z.string().trim().min(1).max(100),
    name: z.string().trim().min(1).max(100),
    root: z.string().trim().min(1),
    capabilities: capabilitiesSchema,
    deny: z.array(z.string().min(1)).default([]),
  })
  .strict();

const rawAgentConfigSchema = z
  .object({
    serverUrl: z.string().url(),
    deviceName: deviceNameSchema,
    credentialPath: z.string().trim().min(1).optional(),
    workspaces: z.array(workspaceConfigSchema).min(1).max(32),
  })
  .strict();

export type AgentConfig = Readonly<{
  serverUrl: string;
  deviceName: string;
  credentialPath: string;
  workspaces: readonly WorkspaceMetadata[];
  workspaceRegistry: WorkspaceRegistry;
}>;

export type AgentConfigErrorCode =
  | "CONFIG_UNAVAILABLE"
  | "INVALID_CONFIG"
  | "INVALID_SERVER_URL"
  | "INVALID_WORKSPACE";

export class AgentConfigError extends Error {
  constructor(public readonly code: AgentConfigErrorCode) {
    super("Cấu hình doctmcp không hợp lệ hoặc không thể đọc.");
    this.name = "AgentConfigError";
  }
}

function normalizeServerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AgentConfigError("INVALID_SERVER_URL");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(
    url.hostname.toLowerCase(),
  );
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new AgentConfigError("INVALID_SERVER_URL");
  }
  return url.origin;
}

function defaultCredentialPath(): string {
  return join(homedir(), ".doctmcp", "device-credential.json");
}

export async function loadAgentConfig(
  configPath: string,
): Promise<AgentConfig> {
  let rawText: string;
  let absoluteConfigPath: string;
  try {
    absoluteConfigPath = await realpath(resolve(configPath));
    rawText = await readFile(absoluteConfigPath, "utf8");
  } catch {
    throw new AgentConfigError("CONFIG_UNAVAILABLE");
  }

  let rawValue: unknown;
  try {
    rawValue = JSON.parse(rawText) as unknown;
  } catch {
    throw new AgentConfigError("INVALID_CONFIG");
  }
  const parsed = rawAgentConfigSchema.safeParse(rawValue);
  if (!parsed.success) throw new AgentConfigError("INVALID_CONFIG");

  const serverUrl = normalizeServerUrl(parsed.data.serverUrl);
  const baseDirectory = dirname(absoluteConfigPath);
  const workspaces = parsed.data.workspaces.map((workspace) => ({
    ...workspace,
    root: isAbsolute(workspace.root)
      ? workspace.root
      : resolve(baseDirectory, workspace.root),
  }));
  let workspaceRegistry: WorkspaceRegistry;
  try {
    workspaceRegistry = await WorkspaceRegistry.create(workspaces);
  } catch {
    throw new AgentConfigError("INVALID_WORKSPACE");
  }
  const credentialPath = parsed.data.credentialPath
    ? isAbsolute(parsed.data.credentialPath)
      ? parsed.data.credentialPath
      : resolve(baseDirectory, parsed.data.credentialPath)
    : defaultCredentialPath();

  return Object.freeze({
    serverUrl,
    deviceName: parsed.data.deviceName,
    credentialPath,
    workspaces: workspaceRegistry.list(),
    workspaceRegistry,
  });
}
