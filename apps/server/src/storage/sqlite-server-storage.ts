import type { DeviceCredentialRepository } from "../device-credential";
import type { DeviceRepository } from "../device-repository";
import type { PairingSessionRepository } from "../pairing";
import type { PairingCredentialCompletionRepository } from "../pairing-credential-completion";
import {
  type OpenSqliteDatabaseOptions,
  openSqliteDatabase,
  type SqliteDatabaseHandle,
} from "./sqlite-database";
import { SqliteDeviceCredentialRepository } from "./sqlite-device-credential-repository";
import { SqliteDeviceRepository } from "./sqlite-device-repository";
import { SqlitePairingCredentialCompletionRepository } from "./sqlite-pairing-credential-completion-repository";
import { SqlitePairingSessionRepository } from "./sqlite-pairing-repository";

export type ServerStorageMode = "sqlite" | "memory";

export function resolveServerStorageMode(
  env: Readonly<Record<string, string | undefined>>,
): ServerStorageMode {
  const mode = env.DOCTMCP_STORAGE_MODE ?? "sqlite";
  if (mode === "sqlite") return mode;
  if (mode === "memory" && env.NODE_ENV !== "production") return mode;
  throw new Error(
    "DOCTMCP_STORAGE_MODE phải là sqlite; memory chỉ dành cho test/development.",
  );
}

export interface SqliteServerStorage {
  readonly database: SqliteDatabaseHandle;
  readonly deviceRepository: DeviceRepository;
  readonly credentialRepository: DeviceCredentialRepository;
  readonly pairingRepository: PairingSessionRepository;
  readonly pairingCredentialCompletionRepository: PairingCredentialCompletionRepository;
  readonly path: string;
  close(): void;
}

/**
 * M6.6 production assembly: migrate first; share one connection among device,
 * credentials, pairing, and completion storage. Runtime active socket/session
 * registries are constructed separately and must never be persisted.
 */
export async function openSqliteServerStorage(
  options: OpenSqliteDatabaseOptions = {},
): Promise<SqliteServerStorage> {
  const handle = await openSqliteDatabase(options);
  try {
    const devices = new SqliteDeviceRepository(handle.database);
    const credentials = new SqliteDeviceCredentialRepository(handle.database);
    const pairings = new SqlitePairingSessionRepository(
      handle.database,
      devices,
    );
    const completions = new SqlitePairingCredentialCompletionRepository(
      handle.database,
    );
    return Object.freeze({
      database: handle,
      deviceRepository: devices,
      credentialRepository: credentials,
      pairingRepository: pairings,
      pairingCredentialCompletionRepository: completions,
      path: handle.path,
      close: () => handle.close(),
    });
  } catch (error) {
    handle.close();
    throw error;
  }
}
