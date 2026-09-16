# Pairing thiết bị

Pairing thuộc M3, sau khi M1 local MCP và M2 server → local đã hoạt động ổn định.

## Trạng thái hiện tại

M3.1 đã khóa **device identity + persistence contract**. M3.2 (#31) đã hoàn tất qua PR #38 với pairing session/code lifecycle và atomic claim. M3.3 (#32) đã hoàn tất implementation trên PR #39 với long-lived device credential + authenticated bridge handshake.

Implementation hiện tại đã pass **213/213 test**, 878 assertions trên 30 files; M2 acceptance 6/6 và Windows regression đều xanh.

## Mục tiêu M3.2

Cho phép local runtime chưa có credential tạo pairing session ngắn hạn, hiển thị code cho user và được claim bởi đúng `ownerId` mà không truyền credential dài hạn qua chat/UI.

M3.2 kết thúc ở trạng thái:

```text
pairing claimed
    +
Device đã được tạo và bind owner
```

Long-lived credential được cấp ở completion boundary của M3.3, không tái sử dụng pairing code.

## Luồng pairing

```text
Local Runtime (unpaired)
    -> PairingService.createPairingSession()
    <- pairingCode + PairingSession(expiresAt)

Owner/UI
    -> PairingService.claimPairingCode(code, ownerId, deviceName, metadata)

Pairing repository atomic boundary
    -> validate digest + pending + unexpired
    -> DeviceRepository.create(...)
    -> mark session claimed + bind deviceId
    -> invalidate code ngay lập tức
```

`pairingSessionId` là opaque UUID v4 riêng, không phải `deviceId`, bridge session id hoặc MCP session id. Optional `localCorrelationId` chỉ dùng để correlation local runtime ở credential delivery flow và không phải authorization identity.

## Pairing code contract

- TTL mặc định: `DEFAULT_PAIRING_TTL_MS = 5 phút`;
- alphabet: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`;
- 32 symbol, loại `I`, `O`, `0`, `1` để giảm nhầm lẫn;
- 12 symbol ngẫu nhiên, format `XXXX-XXXX-XXXX`;
- entropy: 60 bit;
- generator: `crypto.getRandomValues()`, không dùng `Math.random()`;
- normalization: case-insensitive, bỏ whitespace và dấu `-`, sau đó lookup theo canonical uppercase form.

Raw pairing code chỉ được trả lúc tạo session. Store không persist raw code; lookup dùng SHA-256 digest của canonical code với domain prefix `doctmcp-pairing:v1:`.

Pairing code là credential ngắn hạn, dùng một lần, invalidated ngay khi claim thành công và không bao giờ được promote thành device credential dài hạn.

## Pairing state

External pairing state:

```text
pending -> claimed
pending -> expired
pending -> cancelled
```

`claimed` bắt buộc có `claimedAt + deviceId`. `expired`/`cancelled` không mang claimed device identity. Claim tại đúng `expiresAt` đã được coi là hết hạn.

Credential delivery là state machine riêng của M3.3:

```text
pending(generation N)
    -> recovering(generation N)
    -> pending(generation N+1)
    -> delivered(generation N+1)
```

`delivered` là terminal. Một pairing session đã delivered không được resume để mint/rotate credential mới.

## Atomic claim boundary

Không được tách claim thành chuỗi write độc lập kiểu:

```text
check pending
await deviceRepository.create(...)
mark claimed
```

nếu không có transaction/lock/CAS bao quanh sequence.

`InMemoryPairingSessionRepository` hiện serialize mutation bằng async critical section và chạy `DeviceRepository.create()` bên trong claim boundary. Authoritative claim time được đọc sau khi acquire boundary. Hai claim đồng thời cùng code chỉ một request tạo device; request còn lại nhận generic `PAIRING_CODE_UNAVAILABLE`.

Production persistence phải thay boundary này bằng database transaction, row lock, compare-and-swap hoặc cơ chế tương đương.

## Error/oracle boundary

Malformed, non-string, unknown, expired, reused và cancelled code đều map ra cùng public error:

```text
PAIRING_CODE_UNAVAILABLE
```

Validation `ownerId`, `deviceName` và metadata xảy ra trước mutation. Raw pairing code không được xuất hiện trong structured error hoặc production log.

## Anti-bruteforce hook

`PairingClaimAttemptGuard` là boundary để HTTP/auth layer sau này áp rate limit theo trusted owner/user và network context. Guard chỉ nhận `ownerId`, code digest hoặc `null`, và optional remote address; không nhận raw pairing code.

## Device identity — M3.1

Mỗi thiết bị có immutable `deviceId` dùng cho routing và authorization. Reference implementation hiện sinh UUID v4 bằng `crypto.randomUUID()`.

`Device` persist:

- immutable `deviceId`;
- immutable opaque `ownerId`;
- mutable `deviceName`;
- mutable platform/app/runtime metadata;
- `createdAt`, `updatedAt`.

Raw credential, authoritative online state, bridge session object và MCP SDK session id không thuộc `Device` record.

## Credential sau pairing — M3.3

Sau khi pairing claim thành công, `PairingCredentialCompletionService` issue long-lived credential cho đúng device:

```text
claimed PairingSession + Device
        -> DeviceCredentialService.issue(deviceId)
        -> pending delivery
             pairingSessionId
             localCorrelationId?
             deviceId
             credentialId/version
             raw credential
```

Raw pairing code không xuất hiện trong delivery payload. Raw device credential chỉ tồn tại ở delivery result/transient cache; completion repository không persist secret.

## Recoverable/idempotent completion

`PairingCredentialCompletionRepository` giữ authoritative metadata:

```text
pairingSessionId
deviceId
credentialId
credentialVersion
state: pending | recovering | delivered
```

Các invariant:

- same-process retry trả lại đúng raw credential pending, không issue generation thứ hai;
- owner luôn được resolve lại từ server-side `DeviceRepository` **trước** cache lookup;
- biết `pairingSessionId` không đủ để lấy raw credential;
- issue fail sau claim có thể resume bằng `pairingSessionId` mà không pair lại;
- `delivered` luôn terminal qua process restart và cả khi credential active sau đó bị revoke.

### Crash recovery reservation

Nếu process restart sau khi credential digest đã persist nhưng raw secret chưa được delivery/ACK, secret cũ không thể khôi phục từ digest. Recovery dùng durable reservation:

```text
pending(generation N)
  -> beginRecovery(): recovering(generation N)
  -> rotateExpected(N -> N+1)
  -> finishRecovery(): pending(generation N+1)
  -> deliver raw secret N+1
```

Điểm quan trọng là `recovering` được persist **trước** credential mutation. Trong state này mọi ACK đều bị reject.

Nếu crash xảy ra sau rotate nhưng trước `finishRecovery()`:

```text
completion = recovering(N)
credential store = active(N+1)
raw secret N+1 = lost
```

Lần resume tiếp theo đọc active generation, CAS `advanceRecovery()` từ reservation N sang N+1, rồi rotate **đúng expected generation N+1** sang N+2. Raw secret chỉ được trả sau khi `finishRecovery()` đã commit `pending(N+2)`.

Nhờ đó:

- stale ACK của N không thể đánh dấu delivered trong recovery window;
- generation có secret bị mất không được coi là deliverable;
- concurrent worker không thể vô tình rotate một generation mới hơn mà worker khác vừa tạo;
- worker chỉ được trả raw secret nếu completion finalize cho chính generation đó thành công.

Production adapter phải persist và CAS atomically các transition `beginRecovery`, `advanceRecovery`, `finishRecovery`, `acknowledge`. Raw secret tuyệt đối không được persist trong completion record.

## ACK contract

`acknowledgeDelivery()` yêu cầu:

```text
pairingSessionId
ownerId
credentialId
credentialVersion
```

Behavior:

- `pending` + exact owner/generation → `delivered`;
- `delivered` + exact owner/generation → success/no-op, để retry ACK an toàn khi response trước bị mất;
- wrong owner → reject;
- stale/wrong generation → reject;
- `recovering` → reject;
- failed ACK không xóa transient raw secret.

Sau terminal ACK thành công, raw secret pending được xóa khỏi memory.

## Credential contract

- raw secret: 32 random bytes, base64url, 256 bit entropy;
- `credentialId`: UUID v4 riêng, unique giữa device/generation;
- server persist SHA-256 digest với domain prefix `doctmcp-device-credential:v1:`;
- mỗi device tối đa một credential active;
- owner resolve từ server-side `DeviceRepository`;
- verify lỗi trả generic `CREDENTIAL_UNAVAILABLE`;
- revoke/rotate dùng CAS trên expected `credentialId + version`;
- `rotateExpected()` là primitive nội bộ cho recovery và chỉ rotate đúng generation đã reserve.

## Authenticated reconnect

Local `BridgeServerTransport` gửi credential trong `bridge.hello` frame:

```text
bridge.hello
  sessionId
  auth:
    mode: device
    deviceId
    credential
```

Credential không nằm trong URL/query. Production gateway mặc định yêu cầu auth. `createDoctmcpServerRuntime()` luôn wire verifier thật bằng cùng credential repository mà lifecycle sử dụng.

Runtime không expose trực tiếp `credentialService` hoặc `credentialRepository`; caller phải đi qua lifecycle API có active-session invalidation.

M2 legacy handshake chỉ bật explicit qua `allowLegacyUnauthenticated: true` trong compatibility/test path; auth fail không fallback sang legacy.

## Revoke / rotate active session

Server runtime enforce:

- revoke đóng active authenticated session của đúng device và old secret reconnect fail;
- rotate đóng session cũ, old secret fail, new secret reconnect được;
- auth in-flight được drain và stale verify bị reject;
- sau initial auth, gateway acquire synchronous **ready lease**;
- credential được reverify dưới lease ngay trước `ready`/`bridge.hello.ack`;
- mutation tới sau ready lease chờ lease drain trước khi mutate;
- correctness không dựa vào event-loop delay hay post-ACK sweep;
- shutdown resolve auth/ready drain waiter để mutation không treo.

#33 vẫn xây authoritative device-session registry, duplicate-session policy, heartbeat và online/offline state.

## Test coverage

M3.2 + M3.3 hiện có regression cho:

- pairing create/claim/expiry/reuse/cancel/concurrency;
- pairing code normalization và no-secret-log boundary;
- issue/verify/revoke/rotate credential và CAS concurrency;
- owner-check trước pending-secret cache;
- issue fail sau claim và restart persist-before-delivery recovery;
- crash **sau rotate nhưng trước completion finalize**;
- `recovering` chặn stale ACK;
- exact duplicate delivered ACK idempotent;
- delivered terminal qua restart/revoke;
- authenticated bridge và pre-auth MCP rejection;
- ready lease + final credential revalidation;
- revoke/rotate active-session invalidation;
- shutdown drain waiter;
- M2 compatibility flow.

Implementation verification: `check` ✅, `typecheck` ✅, **213/213 tests**, 878 assertions, 30 files; M2 acceptance 6/6 và Windows shell regression ✅.
