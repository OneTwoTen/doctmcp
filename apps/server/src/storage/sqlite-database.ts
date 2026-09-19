import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export const SQLITE_DATABASE_FILENAME = "doctmcp.db";

export interface SqlMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export interface OpenSqliteDatabaseOptions {
  readonly dataDir?: string;
  /** Test fixtures hoặc migrations từ một release được version hóa. */
  readonly migrations?: readonly SqlMigration[];
}

export interface SqliteDatabaseHandle {
  readonly database: Database;
  readonly path: string;
  close(): void;
}

interface AppliedMigration {
  readonly version: number;
  readonly name: string;
}

function validateMigrations(migrations: readonly SqlMigration[]): void {
  let previousVersion = 0;
  const names = new Set<string>();
  for (const migration of migrations) {
    if (
      !Number.isSafeInteger(migration.version) ||
      migration.version <= previousVersion ||
      !/^[a-zA-Z0-9_]+$/.test(migration.name) ||
      names.has(migration.name) ||
      !migration.sql.trim()
    ) {
      throw new Error(
        "SQLite migrations phải có version tăng dần, name duy nhất và SQL không rỗng.",
      );
    }
    previousVersion = migration.version;
    names.add(migration.name);
  }
}

async function readBundledMigrations(): Promise<readonly SqlMigration[]> {
  return [
    {
      version: 1,
      name: "0001_storage_baseline",
      sql: await Bun.file(
        new URL("./migrations/0001_storage_baseline.sql", import.meta.url),
      ).text(),
    },
    {
      version: 2,
      name: "0002_devices",
      sql: await Bun.file(
        new URL("./migrations/0002_devices.sql", import.meta.url),
      ).text(),
    },
    {
      version: 3,
      name: "0003_device_credentials",
      sql: await Bun.file(
        new URL("./migrations/0003_device_credentials.sql", import.meta.url),
      ).text(),
    },
    {
      version: 4,
      name: "0004_pairing_sessions",
      sql: await Bun.file(
        new URL("./migrations/0004_pairing_sessions.sql", import.meta.url),
      ).text(),
    },
  ];
}

/**
 * Giữ BEGIN IMMEDIATE từ lúc đọc history đến COMMIT: hai process/connection
 * không thể cùng quyết định chạy một migration trên cùng database file.
 * DDL + insert version nằm trong cùng transaction, lỗi sẽ rollback tất cả.
 */
function applyMigrations(
  database: Database,
  migrations: readonly SqlMigration[],
): void {
  validateMigrations(migrations);
  database.exec("BEGIN IMMEDIATE;");
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const applied = database
      .query("SELECT version, name FROM schema_migrations ORDER BY version")
      .all() as AppliedMigration[];

    for (const [index, record] of applied.entries()) {
      const expected = migrations[index];
      if (
        !expected ||
        record.version !== expected.version ||
        record.name !== expected.name
      ) {
        throw new Error(
          "SQLite database có migration không tương thích với release hiện tại.",
        );
      }
    }

    for (const migration of migrations.slice(applied.length)) {
      try {
        database.exec(migration.sql);
        database
          .query(
            "INSERT INTO schema_migrations (version, name) VALUES (?1, ?2)",
          )
          .run(migration.version, migration.name);
      } catch (error) {
        throw new Error(
          `SQLite migration ${migration.version} (${migration.name}) thất bại.`,
          { cause: error },
        );
      }
    }

    database.exec("COMMIT;");
  } catch (error) {
    try {
      database.exec("ROLLBACK;");
    } catch {
      // Giữ nguyên lỗi migration gốc, ngay cả khi SQLite đã rollback.
    }
    throw error;
  }
}

/**
 * Bootstrap storage layer độc lập với service/domain. Chưa wire các repository
 * production sang SQLite trong M6.2; việc đó thuộc M6.3–M6.6.
 *
 * DOCTMCP_DATA_DIR phải được cấu hình tường minh, không ghi vào ./data hay /app.
 * Call trước khi gateway listen; mọi lỗi migration làm startup thất bại.
 */
export async function openSqliteDatabase(
  options: OpenSqliteDatabaseOptions = {},
): Promise<SqliteDatabaseHandle> {
  const dataDir = options.dataDir ?? process.env.DOCTMCP_DATA_DIR;
  if (!dataDir?.trim()) {
    throw new Error(
      "DOCTMCP_DATA_DIR phải là đường dẫn data directory hợp lệ.",
    );
  }

  const migrations = options.migrations ?? (await readBundledMigrations());
  validateMigrations(migrations);
  const absoluteDataDir = resolve(dataDir);
  await mkdir(absoluteDataDir, { recursive: true, mode: 0o700 });
  const path = join(absoluteDataDir, SQLITE_DATABASE_FILENAME);
  const database = new Database(path, { create: true, strict: true });

  try {
    database.exec("PRAGMA busy_timeout = 5000;");
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec("PRAGMA foreign_keys = ON;");
    database.exec("PRAGMA synchronous = FULL;");

    const journalMode = database.query("PRAGMA journal_mode;").get() as {
      journal_mode: string;
    } | null;
    if (journalMode?.journal_mode.toLowerCase() !== "wal") {
      throw new Error("SQLite không thể bật WAL trên data directory đã chọn.");
    }

    applyMigrations(database, migrations);
    return {
      database,
      path,
      close: () => database.close(),
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
