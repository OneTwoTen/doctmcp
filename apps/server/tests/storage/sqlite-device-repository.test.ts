import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openSqliteDatabase,
  type SqlMigration,
} from "../../src/storage/sqlite-database";
import { SqliteDeviceRepository } from "../../src/storage/sqlite-device-repository";
import { describeDeviceRepositoryContract } from "../contracts/device-repository-contract-suite";

const DEVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEVICE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const folders: string[] = [];

async function temporaryDataDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "doctmcp-m6-device-"));
  folders.push(root);
  return join(root, "data");
}

afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const sample = (ownerId = "owner-a") => ({
  ownerId,
  deviceName: "Persisted device",
  metadata: {
    platform: "linux-x64",
    appVersion: "1.0.0",
    runtimeVersion: "bun-1.4.2",
  },
});

describeDeviceRepositoryContract("SQLite", async (options) => {
  const dataDir = await temporaryDataDirectory();
  const handle = await openSqliteDatabase({ dataDir });
  return {
    repository: new SqliteDeviceRepository(handle.database, options),
    close: () => handle.close(),
  };
});

describe("M6.3 SQLite device integration", () => {
  test("create/update persist qua close và reopen trên connection mới", async () => {
    const dataDir = await temporaryDataDirectory();
    const first = await openSqliteDatabase({ dataDir });
    const idFactory = () => DEVICE_A;
    try {
      const repository = new SqliteDeviceRepository(first.database, {
        generateDeviceId: idFactory,
        now: () => new Date("2026-09-19T04:00:00.000Z"),
      });
      await repository.create(sample());
      await repository.updateForOwner("owner-a", DEVICE_A, {
        deviceName: "After update",
        metadata: { platform: "darwin-arm64" },
      });
    } finally {
      first.close();
    }

    const second = await openSqliteDatabase({ dataDir });
    try {
      const repository = new SqliteDeviceRepository(second.database);
      const device = await repository.getForOwner("owner-a", DEVICE_A);
      expect(device).toMatchObject({
        deviceId: DEVICE_A,
        ownerId: "owner-a",
        deviceName: "After update",
        metadata: { platform: "darwin-arm64" },
      });
      expect(device?.metadata.appVersion).toBeUndefined();
      expect(device?.createdAt.toISOString()).toBe("2026-09-19T04:00:00.000Z");
      expect(device?.updatedAt.toISOString()).toBe("2026-09-19T04:00:00.000Z");
      expect(await repository.getForOwner("owner-b", DEVICE_A)).toBeNull();
    } finally {
      second.close();
    }
  });

  test("duplicate identity qua hai connections chỉ tạo một row", async () => {
    const dataDir = await temporaryDataDirectory();
    const first = await openSqliteDatabase({ dataDir });
    const second = await openSqliteDatabase({ dataDir });
    try {
      const ownerA = new SqliteDeviceRepository(first.database, {
        generateDeviceId: () => DEVICE_A,
      });
      const ownerB = new SqliteDeviceRepository(second.database, {
        generateDeviceId: () => DEVICE_A,
      });
      const attempts = await Promise.allSettled([
        ownerA.create(sample("owner-a")),
        ownerB.create(sample("owner-b")),
      ]);
      expect(
        attempts.filter((item) => item.status === "fulfilled"),
      ).toHaveLength(1);
      expect(attempts.find((item) => item.status === "rejected")).toMatchObject(
        {
          status: "rejected",
          reason: { code: "DEVICE_ALREADY_EXISTS" },
        },
      );
      const allRows = first.database
        .query("SELECT device_id, owner_id FROM devices")
        .all() as { device_id: string; owner_id: string }[];
      expect(allRows).toHaveLength(1);
      expect(allRows[0]?.device_id).toBe(DEVICE_A);
    } finally {
      first.close();
      second.close();
    }
  });

  test("upgrade V1 -> V2 không xóa dữ liệu cũ và index owner có mặt", async () => {
    const dataDir = await temporaryDataDirectory();
    const baselineSql = await Bun.file(
      new URL(
        "../../src/storage/migrations/0001_storage_baseline.sql",
        import.meta.url,
      ),
    ).text();
    const baseline: SqlMigration = {
      version: 1,
      name: "0001_storage_baseline",
      sql: baselineSql,
    };
    const first = await openSqliteDatabase({ dataDir, migrations: [baseline] });
    first.database.exec("CREATE TABLE legacy_records (value TEXT NOT NULL)");
    first.database
      .query("INSERT INTO legacy_records (value) VALUES ('keep')")
      .run();
    first.close();

    const second = await openSqliteDatabase({ dataDir });
    try {
      expect(
        second.database.query("SELECT value FROM legacy_records").all(),
      ).toEqual([{ value: "keep" }]);
      expect(
        second.database
          .query("SELECT version FROM schema_migrations ORDER BY version")
          .all(),
      ).toEqual([{ version: 1 }, { version: 2 }]);
      const repo = new SqliteDeviceRepository(second.database, {
        generateDeviceId: () => DEVICE_B,
      });
      expect((await repo.create(sample())).deviceId).toBe(DEVICE_B);
      const indexes = second.database
        .query("PRAGMA index_list('devices')")
        .all() as { name: string }[];
      expect(indexes.map((index) => index.name)).toContain(
        "idx_devices_owner_created_id",
      );
      const columns = second.database
        .query("PRAGMA table_info('devices')")
        .all() as { name: string }[];
      expect(columns.map((column) => column.name)).not.toContain("is_online");
      expect(columns.map((column) => column.name)).not.toContain("socket");
    } finally {
      second.close();
    }
  });

  test("database chặn mutation identity kể cả ngoài repository", async () => {
    const handle = await openSqliteDatabase({
      dataDir: await temporaryDataDirectory(),
    });
    try {
      const repo = new SqliteDeviceRepository(handle.database, {
        generateDeviceId: () => DEVICE_A,
      });
      await repo.create(sample());
      expect(() =>
        handle.database
          .query("UPDATE devices SET owner_id = 'owner-b' WHERE device_id = ?1")
          .run(DEVICE_A),
      ).toThrow("device identity is immutable");
      expect(() =>
        handle.database
          .query("UPDATE devices SET device_id = ?1 WHERE device_id = ?2")
          .run(DEVICE_B, DEVICE_A),
      ).toThrow("device identity is immutable");
      expect((await repo.getById(DEVICE_A))?.ownerId).toBe("owner-a");
      expect(await repo.getById(DEVICE_B)).toBeNull();
    } finally {
      handle.close();
    }
  });
});
