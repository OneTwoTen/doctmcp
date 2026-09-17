# M3.5 — Local reconnect/backoff và credential resume

## Trạng thái

**Approved để triển khai cho issue #34.**

Issue này xây trên authenticated bridge handshake của #32 và generation-aware device session/liveness của #33. Không thay đổi policy server `new authenticated session replaces old` và không thêm pairing UI, multi-device routing hoặc public MCP endpoint.

## Mục tiêu

Local agent đã pair phải có thể tự khôi phục authenticated bridge sau network/server interruption mà không pair lại, đồng thời tránh reconnect storm, parallel socket và stale callback phá generation mới.

Các thuộc tính bắt buộc:

- credential được đọc từ local provider, không hard-code trong config/log;
- transient failure retry bằng exponential backoff bounded + jitter;
- auth/credential/protocol failure cần hành động của người dùng không chạy retry loop vô hạn;
- mỗi controller chỉ có tối đa một active connect attempt/socket generation;
- `stop()` hủy timer và đóng attempt hiện tại;
- callback/timer cũ chỉ được mutate state nếu còn đúng lifecycle/generation;
- credential replacement ghi local atomically hoặc fail rõ ràng, không báo thành công giả.

## Ranh giới kiến trúc

`BridgeServerTransport` tiếp tục là **one-shot transport**. Reconnect không được nhét vào transport vì transport hiện chịu trách nhiệm framing, handshake, queue/backpressure và socket cleanup; thêm reconnect tại đây sẽ tạo state machine kép khó kiểm soát race.

Reconnect nằm ở `LocalBridgeReconnectController` trong `apps/agent`:

```text
LocalBridgeReconnectController
  -> DeviceCredentialProvider.load()
  -> tạo BridgeServerTransport generation N
  -> LocalMcpServerInstance.connect(transport)
  -> ready
  -> socket/heartbeat/server interruption
  -> classify failure
  -> close/drain generation N
  -> bounded backoff
  -> generation N+1
```

MCP SDK v2 cho phép `Protocol.connect(transport)` gắn transport mới bằng cách thay transport hiện tại; reconnect vẫn tuần tự, không được có hai `connect()` active song song. Controller giữ một local MCP runtime/tool registry và chỉ tạo transport mới cho mỗi generation.

## State machine

State public của controller:

```text
idle
  -> connecting
  -> ready
  -> backoff
  -> connecting ...

connecting/ready
  -> pairing-required
  -> auth-failed
  -> protocol-failed
  -> credential-failed

any active state
  -> stopped
```

`connecting` bao gồm cả TCP/WebSocket connect và authenticated `bridge.hello` handshake. Không tạo state `authenticating` giả vì transport hiện không expose event socket-open/handshake-start ra ngoài.

Terminal/action-required states:

- `pairing-required`: provider không có `{ deviceId, credential }`;
- `auth-failed`: gateway trả `AUTH_FAILED` hoặc `AUTH_REQUIRED`;
- `protocol-failed`: version/protocol/local invariant không tương thích;
- `credential-failed`: local credential storage đọc/validate thất bại;
- `stopped`: manual shutdown; không tự restart.

Caller có thể sửa nguyên nhân rồi gọi `start()` lại. `start()` trong một active state là idempotent/no-op; từ terminal/stopped tạo lifecycle generation mới.

## Credential provider

Contract local:

```ts
export interface LocalDeviceCredential {
  readonly deviceId: string;
  readonly credential: string;
}

export interface DeviceCredentialProvider {
  load(): Promise<LocalDeviceCredential | null>;
  replace(credential: LocalDeviceCredential): Promise<void>;
}
```

Mọi input/output được validate bằng shared `deviceIdSchema` và `deviceCredentialSecretSchema` của `@doctmcp/schemas`.

Hai adapter thuộc issue:

1. `InMemoryDeviceCredentialProvider` cho deterministic unit/integration test.
2. `FileDeviceCredentialProvider` làm reference local persistence trước OS keychain packaging.

File adapter lưu format versioned:

```json
{"version":1,"deviceId":"<uuid-v4>","credential":"<43-char-base64url>"}
```

Atomic replace:

1. tạo parent directory nếu thiếu;
2. ghi file tạm cùng directory với mode `0600`;
3. flush/sync file tạm;
4. đóng handle;
5. `rename()` file tạm vào target;
6. cleanup temp khi operation fail trước commit.

Không log/echo nội dung file, raw credential hoặc JSON parse input trong error. OS keychain production adapter vẫn out of scope.

## Backoff policy

Default:

- `minDelayMs = 500`;
- `maxDelayMs = 30_000`;
- `factor = 2`;
- `jitterRatio = 0.2`;
- `stableReadyMs = 30_000`.

Với consecutive retry number `n >= 1`:

```text
base = min(maxDelayMs, minDelayMs * factor^(n - 1))
multiplier = 1 + ((random * 2) - 1) * jitterRatio
delay = clamp(round(base * multiplier), minDelayMs, maxDelayMs)
```

`random()` và timer scheduler injectable trong test. Production dùng `Math.random()` và global timer.

Attempt counter **không reset ngay khi handshake vừa ready**. Nó chỉ reset về `0` khi generation giữ trạng thái `ready` liên tục đủ `stableReadyMs = 30s`. Điều này ngăn socket flap vài trăm mili-giây luôn quay về minimum delay.

## Failure classification

### Retryable

- `SOCKET_ERROR`;
- `SESSION_CLOSED`;
- `TIMEOUT` (bao gồm heartbeat/liveness close);
- native/remote close không có terminal protocol error;
- server tạm unavailable/network interruption.

Retryable failure phải đóng/drain generation cũ trước khi arm backoff timer. Không mở socket mới khi socket cũ còn trong cleanup do chính controller điều khiển.

### Terminal/action-required

- `AUTH_FAILED`, `AUTH_REQUIRED` -> `auth-failed`;
- missing credential -> `pairing-required`;
- `UNSUPPORTED_VERSION`, `INVALID_MESSAGE`, `UNEXPECTED_MESSAGE`, `HANDSHAKE_REQUIRED`, `MESSAGE_TOO_LARGE`, `INVALID_STATE` -> `protocol-failed`;
- credential provider read/validation/storage failure -> `credential-failed`.

`BACKPRESSURE` không phải connect failure bình thường; nếu xuất hiện ở connect lifecycle thì coi là `protocol-failed` thay vì retry tight loop.

## Generation/race semantics

Controller có hai monotonic token:

- **lifecycle generation**: tăng khi `start()` mới sau terminal/stopped và khi `stop()` invalidate toàn bộ async callback hiện tại;
- **attempt generation**: tăng mỗi lần tạo transport mới trong cùng lifecycle.

Mỗi callback giữ reference đến exact attempt object. Callback chỉ được mutate controller khi:

```text
callback.lifecycle == current lifecycle
&& callback.attempt == current attempt
&& attempt chưa finalized
```

Khi server #33 replace old session, close callback của old local transport nếu đến muộn sau generation mới đã active trở thành no-op. Backoff timer và stable-ready timer cũng dùng cùng guard.

## Stop semantics

`stop()`:

1. tăng lifecycle generation để stale callback mất quyền mutate;
2. clear backoff timer;
3. clear stable-ready reset timer;
4. chuyển state `stopped`;
5. đóng current transport nếu có và await cleanup best-effort;
6. không schedule reconnect từ callback close phát sinh bởi chính `stop()`.

Stop trong connect/auth và stop trong backoff đều deterministic/idempotent.

## Logging và secret boundary

Controller logger chỉ emit structured metadata an toàn như:

- state;
- deviceId (sau khi load thành công);
- attempt/generation;
- failure code;
- delay milliseconds.

Không log `credential`, full credential file content hoặc `error.message` từ server/storage. Public snapshot chỉ expose failure **code/category**, không raw Error object.

## Integration với #33

Server #33 đã chốt:

- authenticated session keyed theo immutable `deviceId`;
- new session atomically replaces old;
- old cleanup không evict new generation;
- heartbeat timeout đóng/evict stale session;
- credential generation invalidation đóng session stale.

Local reconnect dùng lại cùng valid credential. Khi heartbeat/server timeout đóng socket, controller classify thành transient và reconnect. Khi revoke làm reconnect trả `AUTH_FAILED`, controller dừng ở `auth-failed` thay vì reconnect storm.

## Test strategy

### Credential provider

- memory provider load/replace;
- file provider missing -> `null`;
- file provider atomic replace đọc lại đúng credential;
- malformed persisted file fail generic, không echo secret/content;
- failed replacement không báo success và cleanup temp best-effort.

### Backoff/state machine

- deterministic exponential delay + injected jitter;
- max/min bound;
- successful stable ready reset counter;
- short-lived ready không reset counter;
- transient disconnect reconnect bằng cùng provider credential;
- server unavailable nhiều lần không tạo parallel transport;
- revoked/auth failed terminal, không arm timer;
- protocol mismatch terminal;
- missing credential -> pairing-required;
- stop trong backoff clear timer;
- stop trong connect đóng current attempt;
- stale close/error/timer generation không restart/kill current generation;
- public snapshot/logger không chứa raw credential.

### Cross-layer acceptance

Dùng production `BridgeServerTransport`, local MCP runtime và `DoctmcpServerRuntime`:

- seed một device credential hợp lệ;
- local controller authenticate và device online;
- đóng active server session với timeout semantics tương đương heartbeat cleanup;
- controller reconnect bằng cùng credential;
- server registry trở lại online với session mới;
- revoke credential, đóng active session và xác nhận reconnect chuyển `auth-failed` không loop.

## Verification

Bắt buộc trước khi hoàn tất:

```sh
bun run check
bun run typecheck
bun test
bun run test:m2
```

CI vẫn phải giữ Windows `shell.exec` regression xanh.

## History

| Ngày | Thay đổi | Lý do | Trạng thái |
|---|---|---|---|
| 2026-09-17 | Khóa reconnect controller, credential provider, backoff/failure/generation semantics | Thiết kế được duyệt cho issue #34 | approved |
