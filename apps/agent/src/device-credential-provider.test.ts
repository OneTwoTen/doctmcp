import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileDeviceCredentialProvider,
  InMemoryDeviceCredentialProvider,
  LocalDeviceCredentialProviderError,
} from "./device-credential-provider";

const DEVICE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CREDENTIAL = "A".repeat(43);
const NEXT_CREDENTIAL = "B".repeat(43);

describe("local device credential provider", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.allSettled(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  test("in-memory provider loads null then replaces a validated credential snapshot", async () => {
    const provider = new InMemoryDeviceCredentialProvider();

    expect(await provider.load()).toBeNull();

    await provider.replace({ deviceId: DEVICE_ID, credential: CREDENTIAL });
    const first = await provider.load();
    expect(first).toEqual({ deviceId: DEVICE_ID, credential: CREDENTIAL });

    await provider.replace({
      deviceId: DEVICE_ID.toUpperCase(),
      credential: NEXT_CREDENTIAL,
    });
    expect(await provider.load()).toEqual({
      deviceId: DEVICE_ID,
      credential: NEXT_CREDENTIAL,
    });
  });

  test("rejects malformed credential records without echoing raw credential material", async () => {
    const provider = new InMemoryDeviceCredentialProvider();
    const secret = "secret-that-must-not-appear";

    let failure: unknown;
    try {
      await provider.replace({
        deviceId: "not-a-device-id",
        credential: secret,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(LocalDeviceCredentialProviderError);
    expect(failure).toMatchObject({ code: "INVALID_CREDENTIAL_RECORD" });
    expect(String((failure as Error).message)).not.toContain(secret);
    expect(await provider.load()).toBeNull();
  });

  test("file provider treats a missing file as unpaired and atomically replaces persisted credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "doctmcp-credential-provider-"));
    roots.push(root);
    const path = join(root, "nested", "device-credential.json");
    const provider = new FileDeviceCredentialProvider(path);

    expect(await provider.load()).toBeNull();

    await provider.replace({ deviceId: DEVICE_ID, credential: CREDENTIAL });
    expect(await provider.load()).toEqual({
      deviceId: DEVICE_ID,
      credential: CREDENTIAL,
    });

    await provider.replace({
      deviceId: DEVICE_ID,
      credential: NEXT_CREDENTIAL,
    });
    expect(await provider.load()).toEqual({
      deviceId: DEVICE_ID,
      credential: NEXT_CREDENTIAL,
    });

    const raw = JSON.parse(await readFile(path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(raw).toEqual({
      version: 1,
      deviceId: DEVICE_ID,
      credential: NEXT_CREDENTIAL,
    });

    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  test("file provider rejects failed replacement and cleans its temporary file", async () => {
    const root = await mkdtemp(join(tmpdir(), "doctmcp-credential-provider-"));
    roots.push(root);
    const path = join(root, "device-credential.json");
    await mkdir(path);
    const provider = new FileDeviceCredentialProvider(path);

    await expect(
      provider.replace({ deviceId: DEVICE_ID, credential: CREDENTIAL }),
    ).rejects.toMatchObject({ code: "CREDENTIAL_STORAGE_FAILED" });

    expect((await stat(path)).isDirectory()).toBe(true);
    expect(await readdir(root)).toEqual(["device-credential.json"]);
  });

  test("file provider rejects malformed persisted content with a generic secret-safe error", async () => {
    const root = await mkdtemp(join(tmpdir(), "doctmcp-credential-provider-"));
    roots.push(root);
    const path = join(root, "device-credential.json");
    const leaked = `not-json-${CREDENTIAL}`;
    await writeFile(path, leaked, "utf8");
    const provider = new FileDeviceCredentialProvider(path);

    let failure: unknown;
    try {
      await provider.load();
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(LocalDeviceCredentialProviderError);
    expect(failure).toMatchObject({ code: "CREDENTIAL_STORAGE_INVALID" });
    expect(String((failure as Error).message)).not.toContain(CREDENTIAL);
    expect(String((failure as Error).message)).not.toContain(leaked);
  });
});
