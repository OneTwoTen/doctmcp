# Pairing thiết bị

Pairing thuộc M3, sau khi M1 local MCP và M2 server → local đã hoạt động ổn định.

## Trạng thái hiện tại

M3.1 đã khóa **device identity + persistence contract**. M3.2 (#31) đã hoàn tất qua PR #38 với pairing session/code lifecycle và atomic claim. M3.3 (#32) đã hoàn tất implementation trên PR #39 với long-lived device credential + authenticated bridge handshake; head đã pass CI 204/204 test sau vòng review fix.

## Mục tiêu M3.2

Cho phép một local runtime chưa có credential tạo pairing session ngắn hạn, hiển thị code cho user và được claim bởi đúng `ownerId` mà không truyền credential dài hạn qua chat/UI.

M3.2 kết thúc ở trạng thái:

```text
pairing claimed
    +
Device đã được tạo và bind owner
```

Long-lived credential được cấp ở completion boundary của M3.3, không tái sử dụng pairing code.

## Luồng pairing đã implement

```text
Local Runtime (unpaired)
    -> PairingService.createPairingSession()
    <- pairingCode + PairingSession(expiresAt)

Owner/UI (trusted ownerId input trong M3)
    -> PairingService.claimPairingCode(code, ownerId, deviceName, metadata)

Pairing repository atomic boundary
    -> validate digest + pending + unexpired
    -> DeviceRepository.create(...)
    -> mark session claimed + bind deviceId
    -> invalidate code ngay lập tức
```

`pairingSessionId` là opaque UUID v4 riêng, không phải `deviceId`, bridge session id hoặc MCP session id. Optional `localCorrelationId` chỉ dùng để correlation local runtime ở credential delivery flow và không phải authorization identity.

## Pairing code contract

Constant hiện tại:

- TTL mặc định: `DEFAULT_PAIRING_TTL_MS = 5 phút`;
- alphabet: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`;
- 32 symbol, loại `I`, `O`, `0`, `1` để giảm nhầm lẫn khi nhập tay;
- 12 symbol ngẫu nhiên, format `XXXX-XXXX-XXXX`;
- entropy: 60 bit;
- generator: `crypto.getRandomValues()`, không dùng `Math.random()`;
- normalization: case-insensitive, bỏ whitespace và dấu `-`, sau đó lookup theo canonical uppercase form.

Ví dụ:

```text
Pairing code: ABCD-EFGH-JKLM
Expires in 5 minutes.
```

Code plaintext chỉ được trả về khi tạo session. Store không persist raw code; lookup dùng SHA-256 digest của canonical code với domain prefix `doctmcp-pairing:v1:`.

Pairing code:

- ngắn hạn;
- dùng một lần;
- invalidated ngay khi claim thành công;
- không được dùng làm device credential dài hạn;
- không được đưa vào structured error hoặc production log.

## Pairing state

External state chỉ có:

```text
pending -> claimed
pending -> expired
pending -> cancelled
```

`claimed` bắt buộc có `claimedAt` + `deviceId`. `expired`/`cancelled` không mang claimed device identity.

Claim tại đúng `expiresAt` đã được coi là hết hạn.

## Atomic claim boundary

Không được implement flow sau:

```text
check pending
await deviceRepository.create(...)
mark claimed
```

nếu không có transaction/lock/CAS bao quanh toàn bộ sequence.

`InMemoryPairingSessionRepository` hiện serialize mọi mutation bằng async critical section và chạy `DeviceRepository.create()` bên trong claim boundary. Authoritative claim time được đọc sau khi repository đã acquire boundary, vì vậy request không thể dùng timestamp stale để claim sau `expiresAt`. Hai request claim cùng code đồng thời chỉ một request có thể tạo device; request còn lại nhận generic `PAIRING_CODE_UNAVAILABLE`.

In-memory adapter là test/reference adapter. Production persistence phải thay boundary này bằng database transaction, row lock, compare-and-swap hoặc cơ chế tương đương để pairing transition và device creation cùng nằm trong atomic unit-of-work. Không được tách chúng thành hai write độc lập chỉ vì chuyển sang database.

Nếu `DeviceRepository.create()` fail trước khi commit pairing state, session vẫn `pending` và code chưa bị consume.

## Error/oracle boundary

Malformed, non-string, unknown, expired, reused và cancelled code đều map ra cùng public service error:

```text
PAIRING_CODE_UNAVAILABLE
```

Mục đích là giữ behavior deterministic nhưng không cung cấp endpoint oracle để phân biệt code có tồn tại hay đã từng được dùng.

Validation của `ownerId`, `deviceName` và device metadata xảy ra trước mutation. Raw pairing code không xuất hiện trong error message.

## Anti-bruteforce hook

`PairingClaimAttemptGuard` là boundary cho M4/HTTP layer áp rate limit theo trusted owner/user và network context.

Hook nhận:

- `ownerId`;
- SHA-256 `codeDigest` hoặc `null` nếu format/type code invalid;
- optional `remoteAddress`.

Hook cố ý **không nhận raw pairing code** để giảm nguy cơ secret bị log bởi rate-limit/observability layer. M3.2 chưa triển khai full user auth/IP rate-limit infrastructure.

## Device identity — M3.1

Mỗi thiết bị có immutable `deviceId` dùng cho routing và authorization. M3.1 sinh ID bằng `crypto.randomUUID()` nên format hiện tại là UUID v4.

`Device` persist:

- immutable `deviceId`;
- immutable opaque `ownerId`;
- mutable `deviceName`;
- mutable `platform`, optional `appVersion`, optional `runtimeVersion`;
- `createdAt`, `updatedAt`.

`deviceName` chỉ là display metadata. Rename/metadata không thay đổi ownership.

Raw credential, authoritative `online`, bridge/MCP session id không thuộc `Device` record.

## Credential sau pairing — M3.3

Sau khi pairing claim thành công, `PairingCredentialCompletionService` dùng đúng `deviceId` vừa bind để issue long-lived credential:

```text
PairingService.claimPairingCode(...)
        │
        ▼
claimed PairingSession + Device
        │
        ▼
DeviceCredentialService.issue(deviceId)
        │
        ▼
pending delivery keyed by pairingSessionId
  pairingSessionId
  localCorrelationId?
  deviceId
  credentialId/version
  raw credential
```

Raw pairing code không xuất hiện trong delivery payload và không bao giờ trở thành device credential. `localCorrelationId` giúp control-plane giao secret về đúng local pairing channel nhưng không phải auth identity.

Duplicate/replay pairing code bị chặn tại one-time pairing boundary trước lần credential issue thứ hai.

### Recoverable/idempotent completion

Reference runtime giữ completion thành công transient trong memory theo `pairingSessionId` cho tới khi local xác nhận đã persist credential:

- retry `resumeClaimedPairing(pairingSessionId, ownerId)` trong cùng process trả lại đúng raw credential pending, không issue generation thứ hai;
- nếu pairing claim đã commit nhưng credential issue fail, cùng API resolve claimed session rồi retry issue mà không pair lại;
- ownership được resolve từ server-side `DeviceRepository`; caller dùng owner sai nhận `PAIRING_COMPLETION_UNAVAILABLE`;
- `acknowledgeDelivery(pairingSessionId)` xóa raw secret pending khỏi memory sau khi local lưu thành công.

Reference cache không persist raw secret. Production adapter dùng chung database vẫn phải đặt pairing claim + device creation + credential persistence trong cùng transaction/unit-of-work; recovery cache không thay thế transaction durability.

### Credential contract

- raw secret: 32 random bytes, base64url, 256 bit entropy;
- `credentialId`: UUID v4 riêng, unique giữa device/generation;
- server persist SHA-256 digest với domain prefix `doctmcp-device-credential:v1:`;
- raw secret chỉ trả lúc issue/rotate và không nằm trong `Device` hoặc persisted credential snapshot;
- mỗi device tối đa một credential active;
- owner được resolve từ server-side `DeviceRepository`;
- verify lỗi trả generic `CREDENTIAL_UNAVAILABLE`;
- revoke/rotate dùng CAS trên expected `credentialId + version` để concurrent mutation chỉ một request thắng.

### Authenticated reconnect

Local `BridgeServerTransport` gửi credential trong `bridge.hello` WebSocket frame:

```text
bridge.hello
  sessionId
  auth:
    mode: device
    deviceId
    credential
```

Credential không nằm trong URL/query string. Production gateway mặc định yêu cầu auth và chỉ expose ready session sau verify thành công. `createDoctmcpServerRuntime()` luôn wire verifier thật vào gateway bằng cùng `DeviceCredentialService` instance mà pairing/credential lifecycle sử dụng.

Session giữ `{ownerId, deviceId}` riêng với bridge `sessionId`.

M2 legacy handshake chỉ được bật bằng explicit `allowLegacyUnauthenticated: true` trong compatibility/test path; auth fail không fallback sang legacy.

### Revoke / rotate active session

Server runtime expose lifecycle API đúng security boundary:

- `revokeDeviceCredential(deviceId)` revoke credential, đóng active authenticated session của đúng device và làm old secret reconnect fail;
- `rotateDeviceCredential(deviceId)` tạo generation mới atomically, đóng active session cũ, old secret fail và new secret reconnect được.

Tracking ở M3.3 chỉ đủ cho active invalidation. #33 vẫn xây authoritative device-session registry, duplicate-session replacement, heartbeat và online/offline state.

## Test coverage

M3.2 + M3.3 hiện có regression coverage cho:

- create pairing session trả code + expiry đúng contract;
- default pairing generator không phụ thuộc `Math.random()`;
- claim code hợp lệ tạo/bind đúng một device;
- expiry boundary và stale timestamp bị reject;
- reused/cancelled/invalid/non-string code bị reject generic;
- concurrent pairing claim chỉ một request thắng;
- invalid device metadata bị reject trước mutation;
- normalization case/dash/whitespace deterministic;
- guard chỉ nhận digest, không nhận raw pairing code;
- device creation fail không consume pairing code;
- pairing completion issue đúng một credential và giữ local correlation;
- successful completion resume trả cùng pending delivery;
- credential issue fail sau claim vẫn recover bằng `pairingSessionId`;
- wrong owner không resume được completion;
- credential issue/verify/revoke/rotate;
- wrong/mismatched/revoked credential generic;
- concurrent rotate/revoke và rotate/rotate chỉ một generation mutation thắng;
- production composition root wire credential verifier thật;
- authenticated gateway chặn MCP trước auth;
- raw credential không xuất hiện trong URL/error;
- authenticated MCP initialize/tools flow thật;
- revoke/rotate đóng active session và enforce credential generation khi reconnect;
- M2 acceptance vẫn pass trong explicit legacy compatibility mode.

CI #189 trên implementation head: `check` xanh, `typecheck` xanh, **204/204 test**, M2 acceptance 6/6 và Windows shell regression step xanh.
