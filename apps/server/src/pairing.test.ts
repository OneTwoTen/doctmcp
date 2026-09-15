import { describe, expect, test } from "bun:test";
import type { ClaimPairingInput } from "@doctmcp/schemas";
import {
  type DeviceRepositoryError,
  InMemoryDeviceRepository,
} from "./device-repository";
import {
  DEFAULT_PAIRING_TTL_MS,
  InMemoryPairingSessionRepository,
  PAIRING_CODE_ENTROPY_BITS,
  PairingService,
  type PairingServiceError,
} from "./pairing";

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const DEVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEVICE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CODE_A = "ABCD-EFGH-JKLM";
const CODE_B = "NPQR-STUV-WXYZ";

const validClaim = (ownerId = "owner-a"): ClaimPairingInput => ({
  ownerId,
  deviceName: "DoCT-MAC",
  metadata: {
    platform: "darwin-arm64",
    appVersion: "0.2.0",
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

function createHarness(
  options: {
    now?: () => Date;
    generatePairingCode?: () => string;
    generatePairingSessionId?: () => string;
    generateDeviceId?: () => string;
    claimAttemptGuard?: ConstructorParameters<
      typeof PairingService
    >[0]["claimAttemptGuard"];
  } = {},
) {
  const deviceRepository = new InMemoryDeviceRepository({
    generateDeviceId: options.generateDeviceId ?? (() => DEVICE_A),
    now: options.now,
  });
  const pairingRepository = new InMemoryPairingSessionRepository(
    deviceRepository,
  );
  const service = new PairingService({
    repository: pairingRepository,
    now: options.now,
    generatePairingCode: options.generatePairingCode ?? (() => CODE_A),
    generatePairingSessionId:
      options.generatePairingSessionId ?? (() => SESSION_A),
    claimAttemptGuard: options.claimAttemptGuard,
  });

  return { deviceRepository, pairingRepository, service };
}

describe("PairingService", () => {
  test("create trả short-lived code 60-bit và session không persist raw code", async () => {
    const now = new Date("2026-09-15T06:00:00.000Z");
    const { pairingRepository, service } = createHarness({
      now: () => new Date(now),
    });

    const created = await service.createPairingSession({
      localCorrelationId: "local-runtime-1",
    });

    expect(created.pairingCode).toBe(CODE_A);
    expect(PAIRING_CODE_ENTROPY_BITS).toBe(60);
    expect(created.session.pairingSessionId).toBe(SESSION_A);
    expect(created.session.state).toBe("pending");
    expect(created.session.localCorrelationId).toBe("local-runtime-1");
    expect(
      created.session.expiresAt.getTime() - created.session.createdAt.getTime(),
    ).toBe(DEFAULT_PAIRING_TTL_MS);
    expect(JSON.stringify(created.session)).not.toContain(CODE_A);
    expect(JSON.stringify(created.session)).not.toContain("ABCDEFGHIJKL");

    const reread = await pairingRepository.getById(SESSION_A);
    expect(JSON.stringify(reread)).not.toContain(CODE_A);
  });

  test("default code generator dùng CSPRNG, không phụ thuộc Math.random", async () => {
    const deviceRepository = new InMemoryDeviceRepository({
      generateDeviceId: () => DEVICE_A,
    });
    const repository = new InMemoryPairingSessionRepository(deviceRepository);
    const service = new PairingService({ repository });
    const originalRandom = Math.random;
    Math.random = () => {
      throw new Error("Math.random must not be used");
    };

    try {
      const created = await service.createPairingSession();
      expect(created.pairingCode).toMatch(
        /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/,
      );
    } finally {
      Math.random = originalRandom;
    }
  });

  test("claim hợp lệ tạo đúng một device và bind đúng owner", async () => {
    let nowMs = Date.parse("2026-09-15T06:00:00.000Z");
    const { deviceRepository, service } = createHarness({
      now: () => new Date(nowMs),
    });
    await service.createPairingSession();
    nowMs += 30_000;

    const claimed = await service.claimPairingCode(CODE_A, validClaim());

    expect(claimed.session.state).toBe("claimed");
    expect(claimed.session.deviceId).toBe(DEVICE_A);
    expect(claimed.device.deviceId).toBe(DEVICE_A);
    expect(claimed.device.ownerId).toBe("owner-a");
    expect(await deviceRepository.isOwnedBy("owner-a", DEVICE_A)).toBe(true);
  });

  test("reuse code bị reject bằng generic deterministic error", async () => {
    const { service } = createHarness();
    await service.createPairingSession();
    await service.claimPairingCode(CODE_A, validClaim());

    await expect(
      service.claimPairingCode(CODE_A, validClaim("owner-b")),
    ).rejects.toMatchObject({
      code: "PAIRING_CODE_UNAVAILABLE",
      message: "Pairing code không khả dụng.",
    } satisfies Partial<PairingServiceError>);
  });

  test("claim tại expiry boundary bị reject và session chuyển expired", async () => {
    let nowMs = Date.parse("2026-09-15T06:00:00.000Z");
    const { deviceRepository, service } = createHarness({
      now: () => new Date(nowMs),
    });
    await service.createPairingSession();
    nowMs += DEFAULT_PAIRING_TTL_MS;

    await expect(
      service.claimPairingCode(CODE_A, validClaim()),
    ).rejects.toMatchObject({
      code: "PAIRING_CODE_UNAVAILABLE",
    } satisfies Partial<PairingServiceError>);

    expect((await service.getPairingSession(SESSION_A))?.state).toBe("expired");
    expect(await deviceRepository.listByOwnerId("owner-a")).toHaveLength(0);
  });

  test("hai claim concurrent chỉ một request thắng và chỉ một device được tạo", async () => {
    let nowMs = Date.parse("2026-09-15T06:00:00.000Z");
    const { deviceRepository, service } = createHarness({
      now: () => new Date(nowMs),
      generateDeviceId: sequence([DEVICE_A, DEVICE_B]),
    });
    await service.createPairingSession();
    nowMs += 1_000;

    const results = await Promise.allSettled([
      service.claimPairingCode(CODE_A, validClaim("owner-a")),
      service.claimPairingCode(CODE_A, validClaim("owner-b")),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toBeDefined();
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toMatchObject({
        code: "PAIRING_CODE_UNAVAILABLE",
      } satisfies Partial<PairingServiceError>);
    }

    const devices = [
      ...(await deviceRepository.listByOwnerId("owner-a")),
      ...(await deviceRepository.listByOwnerId("owner-b")),
    ];
    expect(devices).toHaveLength(1);
    expect((await service.getPairingSession(SESSION_A))?.state).toBe("claimed");
  });

  test("cancelled và invalid code đều dùng generic unavailable error", async () => {
    const { service } = createHarness();
    const created = await service.createPairingSession();
    expect(
      (await service.cancelPairingSession(created.session.pairingSessionId))
        .state,
    ).toBe("cancelled");

    for (const code of [CODE_A, "NOT-A-PAIRING-CODE"]) {
      await expect(
        service.claimPairingCode(code, validClaim()),
      ).rejects.toMatchObject({
        code: "PAIRING_CODE_UNAVAILABLE",
        message: "Pairing code không khả dụng.",
      } satisfies Partial<PairingServiceError>);
    }
  });

  test("device metadata invalid bị reject trước guard và trước mutation", async () => {
    let guardCalls = 0;
    const { deviceRepository, service } = createHarness({
      claimAttemptGuard: {
        beforeClaim: () => {
          guardCalls += 1;
        },
      },
    });
    await service.createPairingSession();

    await expect(
      service.claimPairingCode(CODE_A, {
        ...validClaim(),
        metadata: {
          ...validClaim().metadata,
          platform: "",
        },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_PAIRING_INPUT",
    } satisfies Partial<PairingServiceError>);

    expect(guardCalls).toBe(0);
    expect((await service.getPairingSession(SESSION_A))?.state).toBe("pending");
    expect(await deviceRepository.listByOwnerId("owner-a")).toHaveLength(0);
  });

  test("normalization bỏ dash/whitespace và không phân biệt case", async () => {
    const { service } = createHarness();
    await service.createPairingSession();

    const claimed = await service.claimPairingCode(
      "abcd efgh-jklm",
      validClaim(),
    );
    expect(claimed.session.state).toBe("claimed");
  });

  test("claim guard nhận digest + boundary context nhưng không nhận raw code", async () => {
    const attempts: unknown[] = [];
    const { service } = createHarness({
      claimAttemptGuard: {
        beforeClaim: (attempt) => {
          attempts.push(attempt);
        },
      },
    });
    await service.createPairingSession();
    await service.claimPairingCode(CODE_A, validClaim(), {
      remoteAddress: "203.0.113.7",
    });

    expect(attempts).toHaveLength(1);
    const snapshot = JSON.stringify(attempts[0]);
    expect(snapshot).toContain("203.0.113.7");
    expect(snapshot).not.toContain(CODE_A);
    expect(snapshot).not.toContain("ABCDEFGHIJKL");
    expect(snapshot).toMatch(/[0-9a-f]{64}/);
  });

  test("structured error không leak raw pairing code", async () => {
    const { service } = createHarness();
    await service.createPairingSession();
    await service.claimPairingCode(CODE_A, validClaim());

    try {
      await service.claimPairingCode(CODE_A, validClaim());
      throw new Error("Expected reused pairing code to fail");
    } catch (error) {
      const typed = error as PairingServiceError;
      const snapshot = JSON.stringify({
        name: typed.name,
        code: typed.code,
        message: typed.message,
      });
      expect(snapshot).not.toContain(CODE_A);
      expect(snapshot).not.toContain("ABCDEFGHIJKL");
    }
  });

  test("explicit expire chuyển toàn bộ pending session hết hạn", async () => {
    let nowMs = Date.parse("2026-09-15T06:00:00.000Z");
    const { service } = createHarness({
      now: () => new Date(nowMs),
      generatePairingCode: sequence([CODE_A, CODE_B]),
      generatePairingSessionId: sequence([SESSION_A, SESSION_B]),
    });
    await service.createPairingSession();
    await service.createPairingSession();
    nowMs += DEFAULT_PAIRING_TTL_MS;

    expect(await service.expirePairingSessions()).toBe(2);
    expect((await service.getPairingSession(SESSION_A))?.state).toBe("expired");
    expect((await service.getPairingSession(SESSION_B))?.state).toBe("expired");
  });

  test("device repository failure không consume pairing code", async () => {
    const invalidDeviceIdRepository = new InMemoryDeviceRepository({
      generateDeviceId: () => "not-a-device-id",
    });
    const pairingRepository = new InMemoryPairingSessionRepository(
      invalidDeviceIdRepository,
    );
    const service = new PairingService({
      repository: pairingRepository,
      generatePairingCode: () => CODE_A,
      generatePairingSessionId: () => SESSION_A,
    });
    await service.createPairingSession();

    await expect(
      service.claimPairingCode(CODE_A, validClaim()),
    ).rejects.toMatchObject({
      code: "INVALID_DEVICE_ID",
    } satisfies Partial<DeviceRepositoryError>);
    expect((await service.getPairingSession(SESSION_A))?.state).toBe("pending");
  });
});
