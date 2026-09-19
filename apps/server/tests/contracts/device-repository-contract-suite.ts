import { describe, expect, test } from "bun:test";
import type {
  DeviceRepository,
  InMemoryDeviceRepositoryOptions,
} from "../../src/device-repository";

const DEVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEVICE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const INITIAL_TIME = Date.parse("2026-09-19T04:00:00.000Z");

interface DeviceHarness {
  readonly repository: DeviceRepository;
  readonly close?: () => Promise<void> | void;
}

type DeviceFactory = (
  options: InMemoryDeviceRepositoryOptions,
) => Promise<DeviceHarness> | DeviceHarness;

async function withRepository(
  factory: DeviceFactory,
  run: (
    repository: DeviceRepository,
    setDeviceId: (deviceId: string) => void,
    setNow: (milliseconds: number) => void,
  ) => Promise<void>,
): Promise<void> {
  let nextDeviceId = DEVICE_A;
  let nowMs = INITIAL_TIME;
  const harness = await factory({
    generateDeviceId: () => nextDeviceId,
    now: () => new Date(nowMs),
  });
  try {
    await run(
      harness.repository,
      (id) => {
        nextDeviceId = id;
      },
      (time) => {
        nowMs = time;
      },
    );
  } finally {
    await harness.close?.();
  }
}

function input(ownerId = "owner-a") {
  return {
    ownerId,
    deviceName: "Original",
    metadata: { platform: "darwin-arm64", appVersion: "1.0.0" },
  };
}

/** Cùng một bộ test cho InMemory và SQLite, không dùng fixture trong production. */
export function describeDeviceRepositoryContract(
  adapter: string,
  factory: DeviceFactory,
): void {
  describe(`${adapter} device repository contract`, () => {
    test("owner-scoped lookup/list/update và immutable identity", async () => {
      await withRepository(factory, async (repository, setId) => {
        const first = await repository.create(input());
        setId(DEVICE_B);
        await repository.create(input("owner-b"));

        expect(first.deviceId).toBe(DEVICE_A);
        expect(await repository.getForOwner("owner-b", DEVICE_A)).toBeNull();
        expect(await repository.isOwnedBy("owner-b", DEVICE_A)).toBe(false);
        expect(await repository.isOwnedBy("owner-a", DEVICE_A)).toBe(true);
        expect(
          (await repository.listByOwnerId("owner-a")).map(
            (item) => item.deviceId,
          ),
        ).toEqual([DEVICE_A]);
        expect(
          await repository.updateForOwner("owner-b", DEVICE_A, {
            deviceName: "Forbidden",
          }),
        ).toBeNull();
        const renamed = await repository.updateForOwner("owner-a", DEVICE_A, {
          deviceName: "Renamed",
        });
        expect(renamed).toMatchObject({
          deviceId: DEVICE_A,
          ownerId: "owner-a",
          deviceName: "Renamed",
        });
        expect((await repository.getById(DEVICE_A))?.deviceName).toBe(
          "Renamed",
        );
        expect(
          (await repository.getForOwner("owner-b", DEVICE_B))?.ownerId,
        ).toBe("owner-b");
      });
    });

    test("duplicate canonical UUID không overwrite record cũ", async () => {
      await withRepository(factory, async (repository, setId) => {
        setId(DEVICE_A.toUpperCase());
        const first = await repository.create(input());
        expect(first.deviceId).toBe(DEVICE_A);
        expect(
          (await repository.getById(DEVICE_A.toUpperCase()))?.deviceId,
        ).toBe(DEVICE_A);
        setId(DEVICE_A);
        await expect(repository.create(input("owner-b"))).rejects.toMatchObject(
          {
            code: "DEVICE_ALREADY_EXISTS",
          },
        );
        expect((await repository.getById(DEVICE_A))?.ownerId).toBe("owner-a");
        expect(await repository.listByOwnerId("owner-b")).toHaveLength(0);
      });
    });

    test("metadata và Date snapshots không chia sẻ mutable state", async () => {
      await withRepository(factory, async (repository, _setId, setNow) => {
        const original = input();
        const created = await repository.create(original);
        original.metadata.platform = "linux-x64";
        created.createdAt.setTime(0);
        created.updatedAt.setTime(0);
        expect(Object.isFrozen(created)).toBe(true);
        expect(Object.isFrozen(created.metadata)).toBe(true);
        const reread = await repository.getById(DEVICE_A);
        expect(reread?.metadata.platform).toBe("darwin-arm64");
        expect(reread?.createdAt.getTime()).toBe(INITIAL_TIME);
        expect(reread?.updatedAt.getTime()).toBe(INITIAL_TIME);
        expect(reread?.metadata).not.toBe(created.metadata);

        setNow(INITIAL_TIME + 1000);
        const patch = { metadata: { platform: "win32-x64" } };
        const updated = await repository.updateForOwner(
          "owner-a",
          DEVICE_A,
          patch,
        );
        patch.metadata.platform = "linux-x64";
        expect(updated?.metadata.platform).toBe("win32-x64");
        expect(updated?.metadata.appVersion).toBeUndefined();
        expect(updated?.createdAt.getTime()).toBe(INITIAL_TIME);
        expect(updated?.updatedAt.getTime()).toBe(INITIAL_TIME + 1000);
        const listed = await repository.listByOwnerId("owner-a");
        expect(Object.isFrozen(listed)).toBe(true);
        listed[0]?.updatedAt.setTime(0);
        expect((await repository.getById(DEVICE_A))?.updatedAt.getTime()).toBe(
          INITIAL_TIME + 1000,
        );
      });
    });

    test("list theo createdAt rồi deviceId khi cùng timestamp", async () => {
      await withRepository(factory, async (repository, setId) => {
        setId(DEVICE_B);
        await repository.create(input());
        setId(DEVICE_A);
        await repository.create(input());
        expect(
          (await repository.listByOwnerId("owner-a")).map(
            (item) => item.deviceId,
          ),
        ).toEqual([DEVICE_A, DEVICE_B]);
      });
    });

    test("invalid input, owner và deviceId có error code như in-memory", async () => {
      await withRepository(factory, async (repository, setId) => {
        await expect(
          repository.create({
            ...input(),
            metadata: { platform: "" },
          }),
        ).rejects.toMatchObject({ code: "INVALID_DEVICE_INPUT" });
        setId("invalid-uuid");
        await expect(repository.create(input())).rejects.toMatchObject({
          code: "INVALID_DEVICE_ID",
        });
        await expect(repository.getById("invalid-uuid")).rejects.toMatchObject({
          code: "INVALID_DEVICE_ID",
        });
        await expect(repository.listByOwnerId("  ")).rejects.toMatchObject({
          code: "INVALID_DEVICE_INPUT",
        });
        expect(await repository.listByOwnerId("owner-a")).toHaveLength(0);
      });
    });

    test("invalid hoặc backward clock không mutate record", async () => {
      await withRepository(factory, async (repository, _setId, setNow) => {
        await repository.create(input());
        setNow(Number.NaN);
        await expect(
          repository.updateForOwner("owner-a", DEVICE_A, {
            deviceName: "Should not persist",
          }),
        ).rejects.toMatchObject({ code: "INVALID_CLOCK" });
        setNow(INITIAL_TIME - 1);
        await expect(
          repository.updateForOwner("owner-a", DEVICE_A, {
            deviceName: "Still not persisted",
          }),
        ).rejects.toMatchObject({ code: "INVALID_CLOCK" });
        expect((await repository.getById(DEVICE_A))?.deviceName).toBe(
          "Original",
        );
        expect((await repository.getById(DEVICE_A))?.updatedAt.getTime()).toBe(
          INITIAL_TIME,
        );
      });
    });
  });
}
