# Issue #34 Local Reconnect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cho local agent đã pair tự reconnect authenticated bridge bằng cùng credential với bounded exponential backoff + jitter, deterministic lifecycle và không tạo parallel/stale reconnect loop.

**Architecture:** Giữ `BridgeServerTransport` one-shot. Thêm credential provider và `LocalBridgeReconnectController` ở `apps/agent`; controller đọc credential cho từng attempt, tạo transport mới, dùng cùng local MCP runtime để connect tuần tự, classify failure và schedule retry. Mọi timer/callback được guard bằng lifecycle + exact attempt reference.

**Tech Stack:** Bun 1.4.2, TypeScript 7 strict, MCP TypeScript SDK v2, Bun WebSocket, Zod/shared schemas, Bun test, Biome.

**Spec:** `docs/specs/2026-09-17-m3-local-reconnect-design.md`

## Global Constraints

- Không thêm dependency mới nếu Bun/Node API và dependency hiện có đủ dùng.
- `BridgeServerTransport` vẫn là one-shot transport; không nhét reconnect loop vào transport.
- Raw credential không được xuất hiện trong log/error/public snapshot.
- Default backoff: min 500ms, max 30000ms, factor 2, jitter 0.2, stable-ready reset 30000ms.
- `AUTH_FAILED`/`AUTH_REQUIRED` và missing credential không được retry vô hạn.
- Manual `stop()` phải cancel timer/current attempt và không reconnect lại.
- Mọi stale callback/timer phải bị generation guard chặn.
- Verification cuối: `bun run check`, `bun run typecheck`, `bun test`, `bun run test:m2` và Windows `shell.exec` CI.

---

### Task 1: Local credential provider với atomic file replace

**Files:**
- Create: `apps/agent/src/device-credential-provider.test.ts`
- Create: `apps/agent/src/device-credential-provider.ts`
- Modify: `apps/agent/src/index.ts`

**Interfaces:**
- Consumes: `deviceIdSchema`, `deviceCredentialSecretSchema` từ `@doctmcp/schemas`.
- Produces:

```ts
export interface LocalDeviceCredential {
  readonly deviceId: string;
  readonly credential: string;
}

export interface DeviceCredentialProvider {
  load(): Promise<LocalDeviceCredential | null>;
  replace(credential: LocalDeviceCredential): Promise<void>;
}

export class InMemoryDeviceCredentialProvider implements DeviceCredentialProvider {}
export class FileDeviceCredentialProvider implements DeviceCredentialProvider {}
```

- [ ] **Step 1: Viết test đỏ cho memory provider và validation**

```ts
const provider = new InMemoryDeviceCredentialProvider();
expect(await provider.load()).toBeNull();
await provider.replace({ deviceId: DEVICE_ID, credential: CREDENTIAL });
expect(await provider.load()).toEqual({ deviceId: DEVICE_ID, credential: CREDENTIAL });
expect(provider.replace({ deviceId: "bad", credential: CREDENTIAL })).rejects.toMatchObject({
  code: "INVALID_CREDENTIAL_RECORD",
});
```

- [ ] **Step 2: Viết test đỏ cho file provider atomic replace và secret-safe error**

```ts
const provider = new FileDeviceCredentialProvider(path);
expect(await provider.load()).toBeNull();
await provider.replace({ deviceId: DEVICE_ID, credential: CREDENTIAL });
expect(await provider.load()).toEqual({ deviceId: DEVICE_ID, credential: CREDENTIAL });
await writeFile(path, `not-json-${CREDENTIAL}`);
await expect(provider.load()).rejects.toMatchObject({ code: "CREDENTIAL_STORAGE_INVALID" });
try {
  await provider.load();
} catch (error) {
  expect(String((error as Error).message)).not.toContain(CREDENTIAL);
}
```

- [ ] **Step 3: Chạy test targeted để xác nhận RED**

Run: `bun test apps/agent/src/device-credential-provider.test.ts`

Expected: FAIL vì module/classes chưa tồn tại.

- [ ] **Step 4: Implement minimal provider**

Production behavior bắt buộc:

```ts
const localDeviceCredentialSchema = z.object({
  deviceId: deviceIdSchema,
  credential: deviceCredentialSecretSchema,
}).strict();

const persistedCredentialSchema = localDeviceCredentialSchema.extend({
  version: z.literal(1),
}).strict();
```

`FileDeviceCredentialProvider.replace()` phải ghi temp file cùng directory bằng `open(tempPath, "wx", 0o600)`, `writeFile()`, `sync()`, `close()`, sau đó `rename(tempPath, targetPath)`. `finally` cleanup temp nếu rename chưa commit. Error message chỉ mô tả category/path operation, không include raw content/credential.

- [ ] **Step 5: Chạy test targeted để xác nhận GREEN**

Run: `bun test apps/agent/src/device-credential-provider.test.ts`

Expected: PASS.

- [ ] **Step 6: Export provider từ agent package**

Thêm vào `apps/agent/src/index.ts`:

```ts
export * from "./device-credential-provider";
```

- [ ] **Step 7: Commit**

```sh
git add apps/agent/src/device-credential-provider.ts apps/agent/src/device-credential-provider.test.ts apps/agent/src/index.ts
git commit -m "feat(agent): add local device credential provider"
```

---

### Task 2: Pure backoff/failure policy helpers

**Files:**
- Create: `apps/agent/src/local-bridge-reconnect.test.ts`
- Create: `apps/agent/src/local-bridge-reconnect.ts`

**Interfaces:**
- Consumes: `BridgeServerTransportError`, `BridgeServerTransportErrorCode`.
- Produces:

```ts
export interface LocalBridgeBackoffPolicy {
  readonly minDelayMs: number;
  readonly maxDelayMs: number;
  readonly factor: number;
  readonly jitterRatio: number;
  readonly stableReadyMs: number;
}

export const DEFAULT_LOCAL_BRIDGE_BACKOFF_POLICY: LocalBridgeBackoffPolicy;

export function calculateReconnectDelay(
  consecutiveFailure: number,
  policy: LocalBridgeBackoffPolicy,
  random: () => number,
): number;

export type LocalBridgeFailureDisposition =
  | "retry"
  | "auth-failed"
  | "protocol-failed";

export function classifyBridgeFailure(error: unknown): LocalBridgeFailureDisposition;
```

- [ ] **Step 1: Viết test đỏ cho exponential backoff/jitter bounds**

```ts
expect(calculateReconnectDelay(1, policy, () => 0)).toBe(500);
expect(calculateReconnectDelay(2, policy, () => 0.5)).toBe(1000);
expect(calculateReconnectDelay(3, policy, () => 1)).toBe(2400);
expect(calculateReconnectDelay(20, policy, () => 1)).toBe(30000);
```

`random()` phải được clamp/validate về `[0, 1]` để test deterministic không tạo delay ngoài bound.

- [ ] **Step 2: Viết test đỏ cho failure classification**

```ts
expect(classifyBridgeFailure(new BridgeServerTransportError("AUTH_FAILED", "x"))).toBe("auth-failed");
expect(classifyBridgeFailure(new BridgeServerTransportError("TIMEOUT", "x"))).toBe("retry");
expect(classifyBridgeFailure(new BridgeServerTransportError("UNSUPPORTED_VERSION", "x"))).toBe("protocol-failed");
```

- [ ] **Step 3: Chạy targeted test để xác nhận RED**

Run: `bun test apps/agent/src/local-bridge-reconnect.test.ts`

Expected: FAIL vì helper chưa tồn tại.

- [ ] **Step 4: Implement minimal helper**

Failure map:

```ts
AUTH_FAILED | AUTH_REQUIRED -> "auth-failed"
SOCKET_ERROR | SESSION_CLOSED | TIMEOUT -> "retry"
INVALID_MESSAGE | MESSAGE_TOO_LARGE | UNSUPPORTED_VERSION |
HANDSHAKE_REQUIRED | UNEXPECTED_MESSAGE | BACKPRESSURE | INVALID_STATE
  -> "protocol-failed"
unknown Error -> "retry"
```

Delay formula phải đúng spec và validate policy positive/finite trước khi controller nhận.

- [ ] **Step 5: Chạy targeted test để xác nhận GREEN**

Run: `bun test apps/agent/src/local-bridge-reconnect.test.ts`

Expected: helper tests PASS.

- [ ] **Step 6: Commit**

```sh
git add apps/agent/src/local-bridge-reconnect.ts apps/agent/src/local-bridge-reconnect.test.ts
git commit -m "feat(agent): add reconnect backoff policy"
```

---

### Task 3: Reconnect controller state machine + generation guards

**Files:**
- Modify: `apps/agent/src/local-bridge-reconnect.ts`
- Modify: `apps/agent/src/local-bridge-reconnect.test.ts`
- Modify: `apps/agent/src/index.ts`

**Interfaces:**
- Consumes: `DeviceCredentialProvider`, MCP `Transport`, `BridgeServerTransport`, helpers Task 2.
- Produces:

```ts
export type LocalBridgeReconnectState =
  | "idle"
  | "connecting"
  | "ready"
  | "backoff"
  | "pairing-required"
  | "auth-failed"
  | "protocol-failed"
  | "credential-failed"
  | "stopped";

export interface LocalBridgeReconnectSnapshot {
  readonly state: LocalBridgeReconnectState;
  readonly lifecycleGeneration: number;
  readonly attemptGeneration: number;
  readonly consecutiveFailures: number;
  readonly lastFailureCode?: string;
  readonly retryDelayMs?: number;
  readonly deviceId?: string;
}

export interface LocalBridgeRuntimeConnector {
  connect(transport: Transport): Promise<void>;
}

export class LocalBridgeReconnectController {
  readonly snapshot: LocalBridgeReconnectSnapshot;
  start(): void;
  stop(): Promise<void>;
}
```

Scheduler injectable:

```ts
export interface LocalBridgeReconnectScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}
```

- [ ] **Step 1: Viết fake transport/runtime/scheduler trong test**

Fake transport phải implement real `Transport` surface tối thiểu (`start`, `send`, `close`, `onclose`, `onerror`, `onmessage`) và track số active transport. Fake runtime `connect()` chỉ gọi `transport.start()` để controller test không phụ thuộc MCP SDK internals.

- [ ] **Step 2: Viết test đỏ transient retry không parallel socket**

Flow:

```text
start -> attempt 1 connecting
attempt 1 ready
emit SOCKET_ERROR + close
state backoff, active socket = 0
run backoff timer
attempt 2 connecting
active socket <= 1 mọi thời điểm
attempt 2 ready
```

Assert attempt 2 nhận cùng `deviceId + credential` từ provider.

- [ ] **Step 3: Viết test đỏ terminal states**

Cover:

```text
provider.load() null -> pairing-required, no transport
AUTH_FAILED -> auth-failed, no backoff timer
UNSUPPORTED_VERSION -> protocol-failed, no backoff timer
provider.load() reject -> credential-failed, no transport
```

Snapshot chỉ chứa failure code/category và không chứa credential.

- [ ] **Step 4: Viết test đỏ stop/backoff/connect**

Cover:

```text
stop while backoff -> timer cleared, state stopped, run stale timer no effect
stop while connecting -> exact transport close called, stale close no retry
stop twice -> idempotent
```

- [ ] **Step 5: Viết test đỏ stable-ready reset**

```text
failure -> consecutiveFailures = 1
reconnect -> ready < stableReadyMs -> close -> next failure = 2
reconnect -> ready >= stableReadyMs -> consecutiveFailures reset 0
later close -> next failure = 1
```

- [ ] **Step 6: Viết test đỏ stale generation callback**

Giữ callback của attempt cũ; sau khi attempt mới ready, invoke lại old `onclose`/`onerror` và stale timers. Assert snapshot/active attempt của generation mới không đổi và không tạo attempt thứ ba.

- [ ] **Step 7: Chạy targeted test để xác nhận RED**

Run: `bun test apps/agent/src/local-bridge-reconnect.test.ts`

Expected: controller tests FAIL vì class/state machine chưa tồn tại.

- [ ] **Step 8: Implement controller minimal theo exact-attempt guard**

Attempt object:

```ts
interface ActiveBridgeAttempt {
  readonly lifecycleGeneration: number;
  readonly attemptGeneration: number;
  readonly transport: Transport & { close(): Promise<void> };
  failure?: unknown;
  finalized: boolean;
}
```

Controller chỉ finalize khi object này vẫn là `currentAttempt`. Retryable failure clear stable timer, finalize exact attempt, await/best-effort close nếu cần, rồi arm đúng một backoff timer. Timer callback capture lifecycle + expected failure sequence và trở thành no-op khi stale.

`onerror` chỉ record sanitized failure; lifecycle transition thực hiện khi transport close/connect reject để tránh double schedule.

- [ ] **Step 9: Chạy targeted test để xác nhận GREEN**

Run: `bun test apps/agent/src/local-bridge-reconnect.test.ts`

Expected: PASS.

- [ ] **Step 10: Export controller**

Thêm vào `apps/agent/src/index.ts`:

```ts
export * from "./local-bridge-reconnect";
```

- [ ] **Step 11: Commit**

```sh
git add apps/agent/src/local-bridge-reconnect.ts apps/agent/src/local-bridge-reconnect.test.ts apps/agent/src/index.ts
git commit -m "feat(agent): add local bridge reconnect controller"
```

---

### Task 4: Cross-layer authenticated reconnect acceptance

**Files:**
- Create: `apps/server/src/m3-reconnect-acceptance.test.ts`

**Interfaces:**
- Consumes: `createDoctmcpServerRuntime`, `InMemoryDeviceRepository`, `InMemoryDeviceCredentialRepository`, `DeviceCredentialService`, `createLocalMcpRuntime`, `LocalBridgeReconnectController`, `InMemoryDeviceCredentialProvider`, `WorkspaceRegistry`.
- Produces: regression proof cho #34 với production WebSocket transport/server registry.

- [ ] **Step 1: Viết setup helper seed authenticated device**

```ts
const deviceRepository = new InMemoryDeviceRepository();
const credentialRepository = new InMemoryDeviceCredentialRepository();
const device = await deviceRepository.create({
  ownerId: "owner-a",
  deviceName: "Reconnect acceptance",
  metadata: { platform: "test" },
});
const credentialService = new DeviceCredentialService({
  repository: credentialRepository,
  deviceRepository,
});
const issued = await credentialService.issue(device.deviceId);
```

Tạo server runtime với hai repository trên, heartbeat timeout nhỏ nhưng hợp lệ; seed local provider bằng `issued.rawCredential`/raw secret field thực tế của #32 contract.

- [ ] **Step 2: Viết test đỏ reconnect sau timeout close**

Flow:

```text
controller.start()
wait controller ready + server device online
capture session A
server closes session A with TIMEOUT semantics
wait server online again
capture session B
assert B.id != A.id
assert provider credential unchanged
assert controller ready
```

Backoff test override dùng min/max nhỏ + jitter 0 để test nhanh deterministic.

- [ ] **Step 3: Viết test đỏ revoke -> terminal auth failure**

Flow:

```text
ready with valid credential
server runtime revokeDeviceCredential(deviceId)
local active session closes
controller attempts reconnect
handshake returns AUTH_FAILED
controller enters auth-failed
wait > max test backoff
assert no additional session/connect generation
```

- [ ] **Step 4: Chạy acceptance targeted để xác nhận RED nếu controller integration còn thiếu**

Run: `bun test apps/server/src/m3-reconnect-acceptance.test.ts`

Expected trước integration hoàn chỉnh: FAIL ở reconnect/SDK reuse hoặc API mismatch cụ thể; sửa production code, không nới assertion.

- [ ] **Step 5: Chỉ sửa integration boundary cần thiết**

Nếu SDK reuse cần local wrapper cập nhật connection bookkeeping, chỉ thay `apps/agent/src/server.ts` với regression test tương ứng. Không recreate tool catalog hoặc duplicate MCP server trừ khi actual SDK behavior chứng minh bắt buộc.

- [ ] **Step 6: Chạy acceptance targeted để xác nhận GREEN**

Run: `bun test apps/server/src/m3-reconnect-acceptance.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```sh
git add apps/server/src/m3-reconnect-acceptance.test.ts apps/agent/src/server.ts apps/agent/src/server.test.ts
git commit -m "test(m3): cover authenticated local reconnect"
```

Chỉ add `server.ts/server.test.ts` nếu thực tế phải sửa.

---

### Task 5: Documentation, full regression và self-review

**Files:**
- Modify: `docs/specs/2026-09-17-m3-local-reconnect-design.md`
- Modify: `docs/plans/2026-09-17-issue-34-local-reconnect.md`
- Modify khi cần: `docs/pairing.md`, `docs/security.md`, `docs/roadmap.md`

**Interfaces:**
- Consumes: implementation cuối của Task 1-4.
- Produces: source-of-truth status và verification evidence.

- [ ] **Step 1: Update docs theo behavior thực tế**

Ghi rõ final state names, backoff constants, credential file adapter scope, stable-ready reset, failure classification và generation guard. Không mô tả OS keychain/pairing UI là đã implement.

- [ ] **Step 2: Chạy targeted regressions**

```sh
bun test apps/agent/src/device-credential-provider.test.ts
bun test apps/agent/src/local-bridge-reconnect.test.ts
bun test apps/server/src/m3-reconnect-acceptance.test.ts
```

- [ ] **Step 3: Chạy full verification**

```sh
bun run check
bun run typecheck
bun test
bun run test:m2
```

Expected: tất cả pass; CI Windows `shell.exec` pass.

- [ ] **Step 4: Review diff theo acceptance #34**

Kiểm tra cụ thể:

```text
[ ] không raw credential trong logger/error/snapshot
[ ] no parallel socket/connect attempt
[ ] stale close/error/timer no-op
[ ] stop cancel timer/current attempt
[ ] AUTH_FAILED/missing credential terminal
[ ] timeout/network retry bounded
[ ] stable-ready reset đúng 30s default
[ ] file replace temp+sync+rename
[ ] M2 behavior không đổi
```

- [ ] **Step 5: Cập nhật history trạng thái complete sau khi verification xanh**

Thêm history row ngày `2026-09-17` với final test counts/CI evidence.

- [ ] **Step 6: Commit docs/hardening**

```sh
git add docs apps/agent apps/server
git commit -m "docs(m3): finalize local reconnect contract"
```
