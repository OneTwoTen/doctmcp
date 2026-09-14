import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ToolDomainError } from "./errors";
import { createShellExecTool, type ShellExecToolOptions } from "./shell-exec";
import { WorkspaceRegistry } from "./workspace";

describe("shell.exec process hardening", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function setup(options: ShellExecToolOptions = {}) {
    const root = await mkdtemp(join(tmpdir(), "doctmcp-shell-hardening-"));
    roots.push(root);
    const registry = await WorkspaceRegistry.create([
      {
        id: "project",
        name: "Project",
        root,
        capabilities: { execute: true },
      },
    ]);
    return { root, tool: createShellExecTool(registry, options) };
  }

  function childSpawnerScript(pidFile: string, writeLargeOutput = false): string {
    return [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
      writeLargeOutput ? 'process.stdout.write("x".repeat(4096));' : "",
      "setInterval(() => {}, 1000);",
    ].join("\n");
  }

  async function readChildPid(pidFile: string): Promise<number> {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      try {
        const pid = Number((await readFile(pidFile, "utf8")).trim());
        if (Number.isInteger(pid) && pid > 0) {
          return pid;
        }
      } catch {
        // Parent has not written the child pid yet.
      }
      await delay(25);
    }
    throw new Error("Timed out waiting for descendant pid");
  }

  function isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function expectProcessExit(pid: number): Promise<void> {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      if (!isProcessAlive(pid)) {
        return;
      }
      await delay(25);
    }
    expect(isProcessAlive(pid)).toBe(false);
  }

  function expectDomainError(error: unknown, code: string): void {
    expect(error).toBeInstanceOf(ToolDomainError);
    expect((error as ToolDomainError).code).toBe(code);
  }

  test("timeout terminates descendants, not only the direct child", async () => {
    const { root, tool } = await setup({
      defaultTimeoutMs: 1_000,
      maxTimeoutMs: 2_000,
      killGraceMs: 100,
    });
    const pidFile = join(root, "timeout-child.pid");

    let failure: unknown;
    try {
      await tool.handler(
        {
          workspace: "project",
          command: process.execPath,
          args: ["-e", childSpawnerScript(pidFile)],
          cwd: ".",
          timeoutMs: 1_000,
        },
        { signal: new AbortController().signal },
      );
    } catch (error) {
      failure = error;
    }

    expectDomainError(failure, "TIMEOUT");
    const descendantPid = await readChildPid(pidFile);
    await expectProcessExit(descendantPid);
  });

  test("output limit terminates descendants", async () => {
    const { root, tool } = await setup({
      maxOutputBytes: 128,
      defaultTimeoutMs: 5_000,
      maxTimeoutMs: 5_000,
      killGraceMs: 100,
    });
    const pidFile = join(root, "output-child.pid");

    const result = await tool.handler(
      {
        workspace: "project",
        command: process.execPath,
        args: ["-e", childSpawnerScript(pidFile, true)],
        cwd: ".",
        timeoutMs: 5_000,
      },
      { signal: new AbortController().signal },
    );

    expect(result.structuredContent).toMatchObject({ truncated: true });
    const descendantPid = await readChildPid(pidFile);
    await expectProcessExit(descendantPid);
  });

  test("AbortSignal cancellation terminates descendants", async () => {
    const { root, tool } = await setup({
      defaultTimeoutMs: 5_000,
      maxTimeoutMs: 5_000,
      killGraceMs: 100,
    });
    const pidFile = join(root, "cancel-child.pid");
    const controller = new AbortController();

    const execution = tool.handler(
      {
        workspace: "project",
        command: process.execPath,
        args: ["-e", childSpawnerScript(pidFile)],
        cwd: ".",
        timeoutMs: 5_000,
      },
      { signal: controller.signal },
    );

    const descendantPid = await readChildPid(pidFile);
    controller.abort();

    let failure: unknown;
    try {
      await execution;
    } catch (error) {
      failure = error;
    }
    expectDomainError(failure, "PROCESS_FAILED");
    await expectProcessExit(descendantPid);
  });

  test("Windows .cmd shims execute through the constrained batch bridge", async () => {
    if (process.platform !== "win32") {
      return;
    }

    const { root, tool } = await setup();
    const shim = join(root, "echo-arg.cmd");
    await writeFile(
      shim,
      "@echo off\r\nsetlocal DisableDelayedExpansion\r\necho %~1\r\n",
    );

    const result = await tool.handler(
      {
        workspace: "project",
        command: "./echo-arg.cmd",
        args: ["hello world"],
        cwd: ".",
        timeoutMs: 2_000,
      },
      { signal: new AbortController().signal },
    );

    expect(
      (result.structuredContent as { stdout: string }).stdout.trim(),
    ).toBe("hello world");

    let failure: unknown;
    try {
      await tool.handler(
        {
          workspace: "project",
          command: "./echo-arg.cmd",
          args: ["safe & echo injected"],
          cwd: ".",
          timeoutMs: 2_000,
        },
        { signal: new AbortController().signal },
      );
    } catch (error) {
      failure = error;
    }
    expectDomainError(failure, "INVALID_INPUT");
  });
});
