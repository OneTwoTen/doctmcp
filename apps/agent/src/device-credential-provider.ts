import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  deviceCredentialSecretSchema,
  deviceIdSchema,
} from "@doctmcp/schemas";
import { z } from "zod";

const localDeviceCredentialSchema = z
  .object({
    deviceId: deviceIdSchema,
    credential: deviceCredentialSecretSchema,
  })
  .strict();

const persistedCredentialSchema = localDeviceCredentialSchema
  .extend({ version: z.literal(1) })
  .strict();

export interface LocalDeviceCredential {
  readonly deviceId: string;
  readonly credential: string;
}

export type LocalDeviceCredentialProviderErrorCode =
  | "INVALID_CREDENTIAL_RECORD"
  | "CREDENTIAL_STORAGE_INVALID"
  | "CREDENTIAL_STORAGE_FAILED";

export class LocalDeviceCredentialProviderError extends Error {
  constructor(
    public readonly code: LocalDeviceCredentialProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LocalDeviceCredentialProviderError";
  }
}

export interface DeviceCredentialProvider {
  load(): Promise<LocalDeviceCredential | null>;
  replace(credential: LocalDeviceCredential): Promise<void>;
}

function parseCredentialRecord(value: unknown): LocalDeviceCredential {
  const parsed = localDeviceCredentialSchema.safeParse(value);
  if (!parsed.success) {
    throw new LocalDeviceCredentialProviderError(
      "INVALID_CREDENTIAL_RECORD",
      "Local device credential không hợp lệ.",
    );
  }
  return Object.freeze({ ...parsed.data });
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

export class InMemoryDeviceCredentialProvider
  implements DeviceCredentialProvider
{
  #credential: LocalDeviceCredential | null;

  constructor(initial: LocalDeviceCredential | null = null) {
    this.#credential = initial ? parseCredentialRecord(initial) : null;
  }

  load(): Promise<LocalDeviceCredential | null> {
    return Promise.resolve(
      this.#credential ? Object.freeze({ ...this.#credential }) : null,
    );
  }

  replace(credential: LocalDeviceCredential): Promise<void> {
    this.#credential = parseCredentialRecord(credential);
    return Promise.resolve();
  }
}

export class FileDeviceCredentialProvider implements DeviceCredentialProvider {
  constructor(readonly path: string) {
    if (!path) {
      throw new LocalDeviceCredentialProviderError(
        "CREDENTIAL_STORAGE_FAILED",
        "Credential storage path không hợp lệ.",
      );
    }
  }

  async load(): Promise<LocalDeviceCredential | null> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return null;
      throw new LocalDeviceCredentialProviderError(
        "CREDENTIAL_STORAGE_FAILED",
        "Không thể đọc local device credential.",
      );
    }

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new LocalDeviceCredentialProviderError(
        "CREDENTIAL_STORAGE_INVALID",
        "Local credential storage chứa dữ liệu không hợp lệ.",
      );
    }

    const parsed = persistedCredentialSchema.safeParse(value);
    if (!parsed.success) {
      throw new LocalDeviceCredentialProviderError(
        "CREDENTIAL_STORAGE_INVALID",
        "Local credential storage chứa dữ liệu không hợp lệ.",
      );
    }

    return Object.freeze({
      deviceId: parsed.data.deviceId,
      credential: parsed.data.credential,
    });
  }

  async replace(credential: LocalDeviceCredential): Promise<void> {
    const parsed = parseCredentialRecord(credential);
    const directory = dirname(this.path);
    const temporaryPath = join(
      directory,
      `.${basename(this.path)}.${globalThis.crypto.randomUUID()}.tmp`,
    );
    let committed = false;

    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(
          JSON.stringify({
            version: 1,
            deviceId: parsed.deviceId,
            credential: parsed.credential,
          }),
          "utf8",
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, this.path);
      committed = true;
    } catch {
      throw new LocalDeviceCredentialProviderError(
        "CREDENTIAL_STORAGE_FAILED",
        "Không thể cập nhật local device credential.",
      );
    } finally {
      if (!committed) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    }
  }
}
