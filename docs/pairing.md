# Pairing thiết bị

Pairing thuộc M3, sau khi M1 local MCP và M2 server → local đã hoạt động ổn định.

## Trạng thái

- M3.1: device identity + persistence contract — hoàn tất.
- M3.2 (#31): pairing session/code lifecycle + atomic claim — hoàn tất qua PR #38.
- M3.3 (#32): long-lived device credential + authenticated bridge handshake — implementation nằm trên PR #39 và đang chờ merge.

Tài liệu này mô tả contract hiện tại của M3.2/M3.3. Số test/head/CI thay đổi theo từng commit nên verification mới nhất được giữ ở PR thay vì hard-code tại đây.

## Luồng tổng thể

```text
Local Runtime (chưa pair)
    -> createPairingSession()
    <- pairingCode + pairingSessionId + expiresAt

Owner/UI
    -> claimPairingCode(code, ownerId, deviceName, metadata)

Atomic pairing boundary
    -> validate code digest + pending + TTL
    -> create immutable Device
    -> mark pairing claimed + bind deviceId
    -> invalidate pairing code

Credential completion boundary
    -> issue long-lived device credential
    -> persist completion metadata, không persist raw secret
    -> deliver credential cho local
    -> local ACK exact credential generation

Local Runtime
    -> bridge.hello { deviceId, credential }
    -> authenticated WebSocket session
```

Pairing code và device credential là hai loại secret khác nhau. Pairing code tuyệt đối không được promote thành long-lived credential.

## Pairing code contract

- TTL mặc định: `DEFAULT_PAIRING_TTL_MS = 5 phút`;
- alphabet: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`;
- 12 symbols trên alphabet 32 ký tự = 60 bit entropy;
- format hiển thị: `XXXX-XXXX-XXXX`;
- generator dùng `crypto.getRandomValues()`, không dùng `Math.random()`;
- normalization không phân biệt hoa/thường, bỏ whitespace và `-`;
- raw code chỉ trả lúc create session;
- store chỉ persist SHA-256 digest có domain prefix `doctmcp-pairing:v1:`;
- claim thành công invalidate code ngay;
- malformed/unknown/expired/reused/cancelled cùng map ra `PAIRING_CODE_UNAVAILABLE`;
- raw code không được đưa vào production log hoặc structured error.

## Pairing state

```text
pending -> claimed
pending -> expired
pending -> cancelled
```

`claimed` bắt buộc có `claimedAt + deviceId`. `deviceId` là immutable routing identity; `pairingSessionId` chỉ là correlation identity của pairing flow, không phải bearer credential.

## Atomic claim boundary

Không triển khai production theo chuỗi write rời rạc:

```text
check pending
await create device
mark claimed
```

nếu không có transaction/lock/CAS bao toàn bộ sequence.

`InMemoryPairingSessionRepository` là reference adapter và serialize mutation bằng critical section. Production adapter phải cung cấp database transaction, row lock, compare-and-swap hoặc primitive tương đương để hai claim đồng thời không thể tạo hai device.

## Device credential contract

Sau pairing, server cấp credential riêng cho đúng `deviceId`:

- raw secret: 32 CSPRNG bytes, encode base64url, 256 bit entropy;
- `credentialId`: UUID v4 riêng cho từng generation;
- server chỉ persist SHA-256 digest với domain prefix `doctmcp-device-credential:v1:`;
- mỗi device có tối đa một credential active;
- `credentialId` không reuse giữa device/generation;
- owner luôn resolve từ server-side `DeviceRepository`;
- verify lỗi trả generic `CREDENTIAL_UNAVAILABLE`;
- revoke/rotate dùng expected `credentialId + version` làm CAS boundary;
- raw credential không nằm trong `Device` record và không được log.

## Credential completion state

Authoritative completion repository chỉ giữ metadata:

```text
pairingSessionId
deviceId
credentialId
credentialVersion
state: pending | recovering | delivered
recoveryTargetCredentialId? // chỉ khi recovering
```

Raw secret chỉ tồn tại transient ở result/cache trong process.

State machine:

```text
pending(generation N)
    -> recovering(source N, target T)
    -> pending(generation N+1, credentialId T)
    -> delivered(generation N+1, credentialId T)
```

`delivered` là terminal. Một pairing đã delivered không được resume để mint credential mới.

## Crash-safe recovery

Nếu process chết sau khi credential digest đã persist nhưng raw secret chưa delivery, digest không thể dùng để khôi phục raw secret. Recovery phải tạo generation mới.

Reservation được persist trước credential mutation:

```text
pending(N)
  -> recovering(source N, target T)       // durable reservation
  -> rotateExpectedWithCredentialId(N,T) // exact source + exact target
  -> pending(T/N+1)                       // finalize completion
  -> deliver raw secret T/N+1
```

Nếu crash sau rotate nhưng trước finalize:

```text
completion = recovering(source N, target T)
credential  = active(T/N+1)
raw secret  = lost
```

Lần resume tiếp theo chỉ coi active generation là recovery commit nếu `credentialId` đúng target đã reserve và version đúng `N + 1`. Sau đó recovery advance source, reserve target mới và rotate tiếp để tạo một generation có raw secret deliverable.

Nếu active credential bị explicit revoke hoặc explicit rotate sang một id khác, recovery fail closed và không được đảo ngược mutation bên ngoài pairing.

## Per-device lifecycle linearization

Durable recovery reservation giải quyết crash giữa hai store, nhưng chưa đủ để giải quyết race trong cùng runtime. Production composition root vì vậy có thêm `DeviceCredentialLifecycleCoordinator` theo `deviceId`.

Default `InMemoryDeviceCredentialLifecycleCoordinator` là reference implementation cho **một server process**. Nếu nhiều server instance cùng truy cập chung credential/completion stores, caller phải inject coordinator dùng shared/distributed per-device lease hoặc primitive serialization tương đương. Không được tạo một in-memory coordinator riêng trên mỗi instance rồi coi đó là cross-instance locking.

Các operation sau dùng cùng lifecycle boundary:

```text
initial credential delivery
  mark lifecycle mutation intent
  -> acquire device lifecycle lock
  -> issue credential
  -> setPending(exact generation)
  -> verify returned generation vẫn active
  -> release lock

recovery delivery
  mark lifecycle mutation intent
  -> acquire same device lifecycle lock
  -> reserve/advance recovery
  -> rotateExpectedWithCredentialId(...)
  -> finishRecovery(exact generation)
  -> verify returned generation vẫn active
  -> release lock

explicit rotate/revoke
  start expected-generation snapshot
  + mark mutation intent immediately
  -> acquire same device lifecycle lock
  -> CAS exact snapshotted generation
  -> close active authenticated sessions
  -> release lock
```

Điểm quan trọng:

- explicit mutation không thể chen vào giữa recovery rotate và `finishRecovery()`;
- initial issue không thể bị rotate/revoke chen giữa `issue()` và `setPending()`;
- mutation intent được đánh dấu trước `await` snapshot để handshake in-flight không thắng do một event-loop gap;
- concurrent rotate/revoke vẫn dùng expected-generation CAS, nên hai request cùng snapshot một generation chỉ một request có thể commit;
- correctness không dựa vào `setTimeout(0)` hoặc post-check timing.

## Same-process cache và stale delivery

Runtime không trả raw secret chỉ vì `PairingCredentialCompletionService` còn cache một completion cũ.

Mọi `claimAndIssue()` / `resumeClaimedPairing()` qua `createDoctmcpServerRuntime()` chạy dưới lifecycle coordinator và revalidate rằng exact `credentialId + version` sắp trả vẫn là active generation.

Do đó nếu explicit rotate/revoke đã thắng sau một delivery trước đó:

- same-process resume không được trả lại cached raw secret cũ;
- pending ACK cho generation đã bị supersede/revoke bị reject;
- exact duplicate ACK của state `delivered` vẫn idempotent kể cả credential sau đó bị revoke/rotate.

## ACK contract

`acknowledgeDelivery()` yêu cầu:

```text
pairingSessionId
ownerId
credentialId
credentialVersion
```

Behavior:

- `pending` + exact owner/generation + generation vẫn active → `delivered`;
- `delivered` + exact owner/generation → success/no-op;
- wrong owner → reject;
- stale/wrong generation → reject;
- `recovering` → reject;
- pending generation đã bị revoke/rotate → reject;
- failed ACK không xóa transient secret;
- ACK transition được serialize với credential lifecycle mutation trong production runtime.

## Authenticated bridge reconnect

Local gửi credential trong control frame, không trong URL/query:

```text
bridge.hello
  sessionId
  auth:
    mode: device
    deviceId
    credential
```

Production gateway mặc định yêu cầu auth. `createDoctmcpServerRuntime()` luôn wire verifier thật trên cùng credential repository mà lifecycle API sử dụng.

M2 legacy hello chỉ được bật explicit qua `allowLegacyUnauthenticated: true` ở direct compatibility/test path; auth failure không fallback sang legacy.

## Ready boundary và active-session invalidation

Handshake production:

```text
initial verify
  -> acquire ready lease
  -> reverify credential
  -> ready
  -> bridge.hello.ack
  -> onSession
  -> release ready lease
```

Credential lifecycle mutation:

- đánh dấu mutation intent trước async snapshot;
- chặn auth mới của cùng device;
- handshake verify đang in-flight thấy mutation marker và fail generic;
- mutation chờ ready lease đã acquire drain trước khi thay credential;
- sau rotate/revoke, active authenticated session của device bị close;
- old secret reconnect fail;
- `stop()` resolve auth/ready drain waiters để shutdown không treo.

## Test bắt buộc cho lifecycle boundary

Regression suite phải giữ ít nhất các case sau:

- barrier tại `setPending`: explicit rotate phải chờ initial issue + completion commit;
- barrier tại `finishRecovery`: explicit rotate phải chờ recovery rotate + finalize;
- concurrent explicit rotate/revoke: chỉ một mutation của cùng expected generation thắng;
- same-process cached completion sau explicit rotate không được trả stale raw secret;
- stale pending ACK sau explicit rotate/revoke bị reject;
- revoke được gọi trong auth in-flight phải thắng trước ready exposure;
- crash sau recovery rotate trước finalize vẫn resume được bằng durable reservation;
- explicit external rotate/revoke không bị recovery đảo ngược;
- active session bị đóng khi credential generation thay đổi.

## Out of scope của M3.3

- authoritative device-session registry / duplicate connection policy / heartbeat / online state (#33);
- reconnect/backoff loop (#34);
- multi-device routing (#35);
- public MCP endpoint và user OAuth (M4);
- OS keychain packaging.
