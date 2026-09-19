import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeServerTransport } from "../../../agent/src/bridge-server-transport";
import type { BridgeGatewaySession } from "../../src/gateway";
import {
  createDoctmcpServerRuntime,
  type DoctmcpServerRuntime,
} from "../../src/server-runtime";
import {
  openSqliteServerStorage,
  resolveServerStorageMode,
  type SqliteServerStorage,
} from "../../src/storage/sqlite-server-storage";

const roots: string[] = [];
const runtimes: DoctmcpServerRuntime[] = [];
const transports: BridgeServerTransport[] = [];

async function dataDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "doctmcp-m6-production-"));
  roots.push(root);
  return join(root, "volume", "data");
}

afterEach(async () => {
  await Promise.allSettled(transports.splice(0).map((transport) => transport.close()));
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.stop()));
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

function runtimeFrom(
  storage: SqliteServerStorage,
  onSession?: (session: BridgeGatewaySession) => void,
): DoctmcpServerRuntime {
  const runtime = createDoctmcpServerRuntime({
    port: 0,
    idleTimeoutMs: 0,
    deviceRepository: storage.deviceRepository,
    credentialRepository: storage.credentialRepository,
    pairingRepository: storage.pairingRepository,
    pairingCredentialCompletionRepository:
      storage.pairingCredentialCompletionRepository,
    ...(onSession ? { onSession } : {}),
  });
  runtimes.push(runtime);
  return runtime;
}

async function waitForSession(
  getSession: () => BridgeGatewaySession | undefined,
): Promise<BridgeGatewaySession> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Session timed out")), 2_000);
    const check = (): void => {
      const value = getSession();
      if (value === undefined) {
        setTimeout(check, 1);
        return;
      }
      clearTimeout(timeout);
      resolve(value);
    };
    check();
  });
}

describe("M6.6 production SQLite assembly and restart", () => {
  test("production defaults to sqlite; memory requires explicit non-production opt-in", () => {
    expect(resolveServerStorageMode({})).toBe("sqlite");
    expect(resolveServerStorageMode({ NODE_ENV: "production" })).toBe("sqlite");
    expect(resolveServerStorageMode({
      DOCTMCP_STORAGE_MODE: "sqlite",
      NODE_ENV: "production",
    })).toBe("sqlite");
    expect(resolveServerStorageMode({
      DOCTMCP_STORAGE_MODE: "memory",
      NODE_ENV: "test",
    })).toBe("memory");
    expect(() => resolveServerStorageMode({
      DOCTMCP_STORAGE_MODE: "memory",
      NODE_ENV: "production",
    })).toThrow("memory chỉ dành cho test/development");
    expect(() => resolveServerStorageMode({
      DOCTMCP_STORAGE_MODE: "typo",
    })).toThrow("DOCTMCP_STORAGE_MODE");
  });

  test("SQLite mode không fallback khi thiếu data directory", async () => {
    await expect(openSqliteServerStorage({ dataDir: "" }))
      .rejects.toThrow("DOCTMCP_DATA_DIR");
  });

  test("new runtime and new database connection on same volume retains device/credential and routes a real reconnected bridge", async () => {
    const dataDir = await dataDirectory();
    const first = await openSqliteServerStorage({ dataDir });
    let deviceId: string;
    let rawCredential: string;
    try {
      const runtime = runtimeFrom(first);
      const pairing = await runtime.pairingService.createPairingSession({
        localCorrelationId: "persistent-runtime",
      });
      const completed = await runtime.pairingCredentialCompletionService.claimAndIssue(
        pairing.pairingCode,
        {
          ownerId: "owner-persistent",
          deviceName: "Durable device",
          metadata: { platform: "linux-x64" },
        },
      );
      deviceId = completed.device.deviceId;
      rawCredential = completed.secret;
      await runtime.pairingCredentialCompletionService.acknowledgeDelivery({
        pairingSessionId: completed.session.pairingSessionId,
        ownerId: completed.device.ownerId,
        credentialId: completed.credential.credentialId,
        credentialVersion: completed.credential.version,
      });
      expect((await runtime.deviceRouter.getDevice("owner-persistent", deviceId)).status)
        .toBe("offline");
      await runtime.stop();
    } finally {
      first.close();
    }

    // Simulates a container replacement: no in-memory runtime survives; only
    // the same persistent mount path is passed to a fresh SQLite connection.
    const second = await openSqliteServerStorage({ dataDir });
    try {
      let connected: BridgeGatewaySession | undefined;
      const runtime = runtimeFrom(second, (session) => {
        connected = session;
      });
      expect(second.path).toBe(first.path);
      expect((await runtime.deviceRouter.listDevices("owner-persistent"))
        .map((device) => device.deviceId)).toEqual([deviceId]);
      expect((await runtime.deviceRouter.getDevice("owner-persistent", deviceId)).status)
        .toBe("offline");
      await expect(runtime.deviceRouter.resolve("owner-persistent", deviceId))
        .rejects.toMatchObject({ code: "DEVICE_OFFLINE" });

      const transport = new BridgeServerTransport({
        url: runtime.gateway.url,
        auth: { deviceId, credential: rawCredential },
      });
      transports.push(transport);
      await transport.start();
      const ready = await waitForSession(() => connected);
      expect(ready.state).toBe("ready");
      expect(ready.identity).toEqual({ ownerId: "owner-persistent", deviceId });
      const routed = await runtime.deviceRouter.resolve("owner-persistent", deviceId);
      expect(routed.device.status).toBe("online");
      expect(routed.session).toBe(ready);
      await expect(runtime.deviceRouter.resolve("owner-other", deviceId))
        .rejects.toMatchObject({ code: "DEVICE_NOT_FOUND" });
      await transport.close();
      await runtime.stop();
    } finally {
      second.close();
    }
  });
});
