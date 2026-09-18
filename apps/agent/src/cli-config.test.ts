import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConfigError, loadAgentConfig } from "./cli-config";

describe("loadAgentConfig", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function setup() {
    const directory = await mkdtemp(join(tmpdir(), "doctmcp-config-"));
    directories.push(directory);
    const workspace = join(directory, "workspace");
    await mkdir(workspace);
    await mkdir(join(workspace, "subdir"));
    return { directory, workspace, configPath: join(directory, "agent.json") };
  }

  test("resolves paths against the canonical config directory and defaults every capability to deny", async () => {
    const fixture = await setup();
    await writeFile(
      fixture.configPath,
      JSON.stringify({
        serverUrl: "https://api.example.test/",
        deviceName: "Workstation",
        credentialPath: "secrets/device.json",
        workspaces: [
          {
            id: "work",
            name: "Work files",
            root: "workspace",
          },
        ],
      }),
    );

    const config = await loadAgentConfig(fixture.configPath);
    expect(config.serverUrl).toBe("https://api.example.test");
    expect(config.credentialPath).toBe(
      join(fixture.directory, "secrets", "device.json"),
    );
    expect(config.workspaceRegistry.list()).toEqual([
      {
        id: "work",
        name: "Work files",
        root: fixture.workspace,
        capabilities: {
          read: false,
          write: false,
          delete: false,
          execute: false,
        },
        deny: [],
      },
    ]);
  });

  test("rejects unknown fields, invalid capability types, and missing workspaces", async () => {
    const fixture = await setup();
    const validWorkspace = {
      id: "work",
      name: "Work",
      root: "workspace",
    };
    const base = {
      serverUrl: "http://localhost:3000",
      deviceName: "Workstation",
      workspaces: [validWorkspace],
    };

    for (const value of [
      { ...base, unexpected: true },
      {
        ...base,
        workspaces: [{ ...validWorkspace, capabilities: { read: "yes" } }],
      },
      { ...base, workspaces: [] },
    ]) {
      await writeFile(fixture.configPath, JSON.stringify(value));
      await expect(loadAgentConfig(fixture.configPath)).rejects.toBeInstanceOf(
        AgentConfigError,
      );
    }
  });

  test("rejects insecure remote server URLs and overlapping or missing workspace paths", async () => {
    const fixture = await setup();
    const workspace = {
      id: "work",
      name: "Work",
      root: "workspace",
    };
    const base = {
      serverUrl: "http://api.example.test",
      deviceName: "Workstation",
      workspaces: [workspace],
    };
    await writeFile(fixture.configPath, JSON.stringify(base));
    await expect(loadAgentConfig(fixture.configPath)).rejects.toMatchObject({
      code: "INVALID_SERVER_URL",
    });

    await writeFile(
      fixture.configPath,
      JSON.stringify({
        ...base,
        serverUrl: "http://localhost:3000",
        workspaces: [
          workspace,
          { id: "nested", name: "Nested", root: "workspace/subdir" },
        ],
      }),
    );
    await expect(loadAgentConfig(fixture.configPath)).rejects.toMatchObject({
      code: "INVALID_WORKSPACE",
    });

    await writeFile(
      fixture.configPath,
      JSON.stringify({
        ...base,
        serverUrl: "http://localhost:3000",
        workspaces: [{ ...workspace, root: "missing" }],
      }),
    );
    await expect(loadAgentConfig(fixture.configPath)).rejects.toMatchObject({
      code: "INVALID_WORKSPACE",
    });
  });
});
