import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openSqliteDatabase,
  SQLITE_DATABASE_FILENAME,
  type SqlMigration,
} from "../../src/storage/sqlite-database";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function dataDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "doctmcp-m6-sqlite-"));
  temporaryDirectories.push(root);
  return join(root, "nested", "persistent");
}

const V1: SqlMigration = {
  version: 1,
  name: "0001_test_records",
  sql: "CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL);",
};

const V2: SqlMigration = {
  version: 2,
  name: "0002_test_upgrade",
  sql: "ALTER TABLE records ADD COLUMN label TEXT NOT NULL DEFAULT 'old';",
};

describe("M6.2 SQLite bootstrap and migrations", () => {
  test("missing data directory được tạo, WAL và path deterministic", async () => {
    const directory = await dataDir();
    const opened = await openSqliteDatabase({ dataDir: directory });
    try {
      expect(opened.path).toBe(join(directory, SQLITE_DATABASE_FILENAME));
      expect(
        (opened.database.query("PRAGMA journal_mode;").get() as {
          journal_mode: string;
        }).journal_mode,
      ).toBe("wal");
      expect(
        (opened.database.query("PRAGMA foreign_keys;").get() as {
          foreign_keys: number;
        }).foreign_keys,
      ).toBe(1);
      expect(
        opened.database
          .query("SELECT version, name FROM schema_migrations")
          .all(),
      ).toEqual([{ version: 1, name: "0001_storage_baseline" }]);
    } finally {
      opened.close();
    }
  });

  test("existing database giữ dữ liệu qua close/reopen, không apply migration lặp", async () => {
    const directory = await dataDir();
    const first = await openSqliteDatabase({
      dataDir: directory,
      migrations: [V1],
    });
    first.database
      .query("INSERT INTO records (id, value) VALUES (1, 'persisted')")
      .run();
    first.close();

    const second = await openSqliteDatabase({
      dataDir: directory,
      migrations: [V1],
    });
    try {
      expect(second.database.query("SELECT * FROM records").all()).toEqual([
        { id: 1, value: "persisted" },
      ]);
      expect(
        second.database.query("SELECT version FROM schema_migrations").all(),
      ).toEqual([{ version: 1 }]);
    } finally {
      second.close();
    }
  });

  test("versioned migration nâng schema cũ không mất bản ghi", async () => {
    const directory = await dataDir();
    const original = await openSqliteDatabase({
      dataDir: directory,
      migrations: [V1],
    });
    original.database
      .query("INSERT INTO records (id, value) VALUES (7, 'untouched')")
      .run();
    original.close();

    const upgraded = await openSqliteDatabase({
      dataDir: directory,
      migrations: [V1, V2],
    });
    try {
      expect(upgraded.database.query("SELECT * FROM records").all()).toEqual([
        { id: 7, value: "untouched", label: "old" },
      ]);
      expect(
        upgraded.database
          .query("SELECT version FROM schema_migrations ORDER BY version")
          .all(),
      ).toEqual([{ version: 1 }, { version: 2 }]);
    } finally {
      upgraded.close();
    }
  });

  test("migration lỗi rollback DDL/DML và không đánh dấu đã apply", async () => {
    const directory = await dataDir();
    const original = await openSqliteDatabase({
      dataDir: directory,
      migrations: [V1],
    });
    original.database
      .query("INSERT INTO records (id, value) VALUES (1, 'safe')")
      .run();
    original.close();

    await expect(
      openSqliteDatabase({
        dataDir: directory,
        migrations: [
          V1,
          {
            version: 2,
            name: "0002_invalid",
            sql: "INSERT INTO records (id, value) VALUES (2, 'rollback'); INSERT INTO missing_table VALUES (1);",
          },
        ],
      }),
    ).rejects.toThrow("SQLite migration 2 (0002_invalid) thất bại.");

    const reopened = await openSqliteDatabase({
      dataDir: directory,
      migrations: [V1],
    });
    try {
      expect(reopened.database.query("SELECT * FROM records").all()).toEqual([
        { id: 1, value: "safe" },
      ]);
      expect(reopened.database.query("SELECT version FROM schema_migrations").all()).toEqual([
        { version: 1 },
      ]);
    } finally {
      reopened.close();
    }
  });

  test("migrations phải đúng thứ tự, version/name hiện có không được đổi", async () => {
    const directory = await dataDir();
    await expect(
      openSqliteDatabase({
        dataDir: directory,
        migrations: [V2, V1],
      }),
    ).rejects.toThrow("version tăng dần");

    const first = await openSqliteDatabase({
      dataDir: directory,
      migrations: [V1],
    });
    first.close();

    await expect(
      openSqliteDatabase({
        dataDir: directory,
        migrations: [{ ...V1, name: "0001_renamed" }],
      }),
    ).rejects.toThrow("migration không tương thích");
    await expect(
      openSqliteDatabase({
        dataDir: directory,
        migrations: [],
      }),
    ).rejects.toThrow("migration không tương thích");
  });

  test("DOCTMCP_DATA_DIR thiếu hoặc rỗng bị từ chối, không có fallback ./data", async () => {
    await expect(
      openSqliteDatabase({ dataDir: "  " }),
    ).rejects.toThrow("DOCTMCP_DATA_DIR");
  });

  test("hai bootstrap đồng thời không apply cùng migration hai lần", async () => {
    const directory = await dataDir();
    const [first, second] = await Promise.all([
      openSqliteDatabase({ dataDir: directory, migrations: [V1] }),
      openSqliteDatabase({ dataDir: directory, migrations: [V1] }),
    ]);
    try {
      expect(
        first.database.query("SELECT version FROM schema_migrations").all(),
      ).toEqual([{ version: 1 }]);
      expect(
        second.database.query("SELECT version FROM schema_migrations").all(),
      ).toEqual([{ version: 1 }]);
    } finally {
      first.close();
      second.close();
    }
  });
});
