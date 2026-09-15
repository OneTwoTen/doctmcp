import { describe, expect, test } from "bun:test";
import type { CreateDeviceInput } from "@doctmcp/schemas";
import {
  type DeviceRepositoryError,
  InMemoryDeviceRepository,
} from "./device-repository";

const DEVICE_A = "11111111-1111-4111-8111-111111111111";
const DEVICE_B = "22222222-2222-4222-8222-222222222222";
const DEVICE_C_LOWER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEVICE_C_UPPER = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";

const baseInput = (ownerId = "owner-a"): CreateDeviceInput => ({
  ownerId,
  deviceName: "DoCT-MAC",
  metadata: {
    platform: "darwin-arm64",
    appVersion: "0.1.0",
    runtimeVersion: "bun-1.4.2",
  },
});

function sequence<T>(values: readonly T[]): () => T {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) {
      throw new Error("Test sequence đã hết dữ liệu.");
    }
    index += 1;
    return value;
  };
}

describe("InMemoryDeviceRepository", () => {
  test("create sinh immutable identity và snapshot không leak shared reference", async () => {
    const repo = new InMemoryDeviceRepository({
      generateDeviceId: () => DEVICE_A,
      now: () => new Date("2026-09-15T04:00:00.000Z"),
    });

    const created = await repo.create(baseInput());

    expect(created.deviceId).toBe(DEVICE_A);
    expect(created.ownerId).toBe("owner-a");
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.metadata)).toBe(true);

    created.updatedAt.setTime(0);
    expect(() => {
      (created.metadata as { platform: string }).platform = "tampered";
    }).toThrow();

    const reread = await repo.getById(DEVICE_A);
    expect(reread?.updatedAt.toISOString()).toBe("2026-09-15T04:00:00.000Z");
    expect(reread?.metadata.platform).toBe("darwin-arm64");
  });

  test("deviceId được canonicalize trước duplicate detection và lookup", async () => {
    const repo = new InMemoryDeviceRepository({
      generateDeviceId: sequence([DEVICE_C_UPPER, DEVICE_C_LOWER]),
    });

    const created = await repo.create(baseInput("owner-a"));
    expect(created.deviceId).toBe(DEVICE_C_LOWER);
    expect((await repo.getById(DEVICE_C_UPPER))?.deviceId).toBe(DEVICE_C_LOWER);

    await expect(repo.create(baseInput("owner-b"))).rejects.toMatchObject({
      code: "DEVICE_ALREADY_EXISTS",
    } satisfies Partial<DeviceRepositoryError>);
  });

  test("duplicate generated id bị reject deterministic", async () => {
    const repo = new InMemoryDeviceRepository({
      generateDeviceId: () => DEVICE_A,
    });

    await repo.create(baseInput("owner-a"));

    await expect(repo.create(baseInput("owner-b"))).rejects.toMatchObject({
      code: "DEVICE_ALREADY_EXISTS",
    } satisfies Partial<DeviceRepositoryError>);
  });

  test("rename và metadata update không đổi deviceId hoặc ownerId", async () => {
    const repo = new InMemoryDeviceRepository({
      generateDeviceId: () => DEVICE_A,
      now: sequence([
        new Date("2026-09-15T04:00:00.000Z"),
        new Date("2026-09-15T04:01:00.000Z"),
      ]),
    });
    const created = await repo.create(baseInput());

    const updated = await repo.updateForOwner("owner-a", DEVICE_A, {
      deviceName: "Work Mac",
      metadata: {
        platform: "darwin-arm64",
        appVersion: "0.2.0",
        runtimeVersion: "bun-1.4.2",
      },
    });

    expect(updated?.deviceId).toBe(created.deviceId);
    expect(updated?.ownerId).toBe(created.ownerId);
    expect(updated?.deviceName).toBe("Work Mac");
    expect(updated?.metadata.appVersion).toBe("0.2.0");
    expect(updated?.createdAt.toISOString()).toBe(
      created.createdAt.toISOString(),
    );
    expect(updated?.updatedAt.toISOString()).toBe("2026-09-15T04:01:00.000Z");
  });

  test("update lỗi clock không để lại partial mutation", async () => {
    const repo = new InMemoryDeviceRepository({
      generateDeviceId: () => DEVICE_A,
      now: sequence([
        new Date("2026-09-15T04:00:00.000Z"),
        new Date(Number.NaN),
      ]),
    });
    await repo.create(baseInput());

    await expect(
      repo.updateForOwner("owner-a", DEVICE_A, { deviceName: "Must not commit" }),
    ).rejects.toMatchObject({
      code: "INVALID_CLOCK",
    } satisfies Partial<DeviceRepositoryError>);

    const reread = await repo.getById(DEVICE_A);
    expect(reread?.deviceName).toBe("DoCT-MAC");
    expect(reread?.updatedAt.toISOString()).toBe("2026-09-15T04:00:00.000Z");
  });

  test("update reject clock đi lùi và giữ nguyên record", async () => {
    const repo = new InMemoryDeviceRepository({
      generateDeviceId: () => DEVICE_A,
      now: sequence([
        new Date("2026-09-15T04:00:00.000Z"),
        new Date("2026-09-15T03:59:59.000Z"),
      ]),
    });
    await repo.create(baseInput());

    await expect(
      repo.updateForOwner("owner-a", DEVICE_A, { deviceName: "Must not commit" }),
    ).rejects.toMatchObject({
      code: "INVALID_CLOCK",
    } satisfies Partial<DeviceRepositoryError>);

    const reread = await repo.getById(DEVICE_A);
    expect(reread?.deviceName).toBe("DoCT-MAC");
    expect(reread?.updatedAt.toISOString()).toBe("2026-09-15T04:00:00.000Z");
  });

  test("malformed device id có error code riêng", async () => {
    const repo = new InMemoryDeviceRepository();

    await expect(repo.getById("not-a-device-id")).rejects.toMatchObject({
      code: "INVALID_DEVICE_ID",
    } satisfies Partial<DeviceRepositoryError>);
  });

  test("owner-scoped APIs không lookup/list/update chéo owner", async () => {
    const repo = new InMemoryDeviceRepository({
      generateDeviceId: sequence([DEVICE_A, DEVICE_B]),
    });
    await repo.create(baseInput("owner-a"));
    await repo.create(baseInput("owner-b"));

    expect(await repo.getForOwner("owner-a", DEVICE_B)).toBeNull();
    expect(
      await repo.updateForOwner("owner-a", DEVICE_B, { deviceName: "Nope" }),
    ).toBeNull();
    expect(await repo.isOwnedBy("owner-a", DEVICE_B)).toBe(false);

    const ownerADevices = await repo.listByOwnerId("owner-a");
    expect(ownerADevices.map((device) => device.deviceId)).toEqual([DEVICE_A]);

    const ownerBDevice = await repo.getForOwner("owner-b", DEVICE_B);
    expect(ownerBDevice?.deviceName).toBe("DoCT-MAC");
  });

  test("list theo owner có thứ tự deterministic", async () => {
    const repo = new InMemoryDeviceRepository({
      generateDeviceId: sequence([DEVICE_B, DEVICE_A]),
      now: () => new Date("2026-09-15T04:00:00.000Z"),
    });
    await repo.create(baseInput());
    await repo.create({ ...baseInput(), deviceName: "Second" });

    const devices = await repo.listByOwnerId("owner-a");
    expect(devices.map((device) => device.deviceId)).toEqual([
      DEVICE_A,
      DEVICE_B,
    ]);
    expect(Object.isFrozen(devices)).toBe(true);
  });

  test("invalid metadata bị reject tại repository boundary", async () => {
    const repo = new InMemoryDeviceRepository({
      generateDeviceId: () => DEVICE_A,
    });

    await expect(
      repo.create({
        ...baseInput(),
        metadata: { ...baseInput().metadata, platform: "" },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_DEVICE_INPUT",
    } satisfies Partial<DeviceRepositoryError>);
  });
});
