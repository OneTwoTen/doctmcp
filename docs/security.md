# Bảo mật

`doctmcp` có thể đọc/ghi file và thực thi lệnh trên máy local, vì vậy security là yêu cầu kiến trúc từ đầu, không phải phần bổ sung sau.

## Trust boundary

Các ranh giới chính:

- MCP client/ChatGPT → public server.
- Public server → authenticated device/session.
- Custom transport → local MCP runtime.
- Local MCP runtime → permission engine.
- Local tool → filesystem/process/network/resource của hệ điều hành.

Mỗi boundary phải validate dữ liệu ở mức phù hợp. Không dựa vào việc lớp phía trước đã validate để bỏ kiểm tra ở lớp sau khi hậu quả có thể ảnh hưởng máy local.

## Nguyên tắc nền

- Không expose local MCP runtime trực tiếp ra Internet chỉ để public server kết nối vào.
- Local chủ động mở outbound connection tới public server.
- Ngoài local development, dùng TLS/WSS cho kết nối remote.
- Không ghi log token, pairing code thực, private key hoặc credential đầy đủ.
- Permission quan trọng phải được enforce tại local runtime.
- Path filesystem phải normalize/canonicalize trước khi áp allow/deny policy.
- Tool có side effect phải có timeout/cancellation hoặc giới hạn tương ứng khi khả thi.
- Credential thiết bị phải có khả năng revoke/rotate trước khi dùng production.

## MCP không thay thế permission

MCP mô tả capability và tool call, nhưng việc một tool tồn tại trong `tools/list` không đồng nghĩa mọi request đều được phép thực thi.

Local runtime phải kiểm tra permission trước khi gọi implementation thật.

Ví dụ:

```text
tools/call filesystem.read
        │
        ▼
validate input
        │
        ▼
canonicalize path
        │
        ▼
permission check
        │
        ├─ deny -> structured tool error
        │
        └─ allow -> read file
```

## Giả định public server có thể bị compromise

Public server không được coi là boundary duy nhất bảo vệ hệ điều hành local.

Nếu public server bị compromise, permission local vẫn phải hạn chế được capability theo policy đã cấu hình. Đây là lý do permission không được chỉ đặt ở server.

## Filesystem

Yêu cầu tối thiểu:

- canonical path check;
- deny ưu tiên hơn allow;
- chống path traversal;
- kiểm tra symlink/canonical target khi policy phụ thuộc path;
- giới hạn kích thước đọc/ghi khi cần;
- không expose thư mục secret theo mặc định.

## Shell

`shell.exec` là capability nhạy cảm nhất trong M1.

Trước khi coi tool này đủ an toàn cho remote use cần có ít nhất:

- timeout;
- output size limit;
- cwd policy;
- environment filtering;
- permission/approval policy;
- structured exit status;
- không tự động log toàn bộ command output nếu có thể chứa secret.

Không dựa vào blacklist vài command nguy hiểm như lớp bảo vệ duy nhất.

## Device identity và ownership

M3.1 khóa các invariants sau:

- `deviceId` là immutable routing identity; `deviceName` không phải authorization/routing key;
- `ownerId` là opaque principal server-side và không được đổi qua device metadata update;
- owner-scoped store API phải chặn lookup/update chéo owner;
- caller phải coi UUID v4 `deviceId` là opaque, không dùng format hoặc thứ tự ID làm authorization;
- `Device` không chứa authoritative `online` state, bridge session object hoặc MCP SDK session id.

Identity đã authenticated ở server vẫn **không** bypass permission local của M1.

## Pairing security — M3.2

Pairing code là credential ngắn hạn, dùng một lần. Nó không được tái sử dụng làm device token dài hạn.

Contract hiện tại:

- TTL mặc định 5 phút;
- 12 symbol trên alphabet 32 ký tự dễ đọc = 60 bit entropy;
- generator dùng `crypto.getRandomValues()`, không dùng `Math.random()`;
- raw pairing code chỉ trả về lúc create session;
- store lookup bằng SHA-256 digest của canonical code với domain prefix;
- claim tại `expiresAt` hoặc muộn hơn bị coi là expired;
- claim thành công invalidate code ngay lập tức;
- cancelled/expired/reused/unknown/malformed code đều map ra generic `PAIRING_CODE_UNAVAILABLE` ở service boundary;
- production log/structured error không được chứa raw code.

Code normalization cho phép case-insensitive và bỏ whitespace/dash. Đây chỉ là UX normalization, không làm thay đổi entropy của code được sinh.

### Atomic claim

Pairing claim và device creation không được tách thành chuỗi write độc lập kiểu:

```text
check pending -> await create device -> mark claimed
```

nếu không có transaction/lock/CAS bao quanh toàn bộ sequence.

`InMemoryPairingSessionRepository` dùng async critical section và gọi `DeviceRepository.create()` bên trong atomic claim boundary. Hai claim đồng thời cùng một code chỉ một request được phép tạo device.

Production persistence phải dùng database transaction, row lock, compare-and-swap hoặc cơ chế tương đương. Nếu database adapter không thể đặt pairing transition + device creation trong cùng atomic unit-of-work thì adapter đó chưa đáp ứng M3.2 security contract.

### Anti-bruteforce boundary

`PairingClaimAttemptGuard` là abstraction để HTTP/auth layer sau này áp rate limit theo trusted owner/user và network context mà không sửa domain flow.

Guard chỉ nhận:

- `ownerId`;
- code digest hoặc `null` nếu malformed;
- optional remote address.

Raw pairing code không được truyền vào guard để tránh bị observability/rate-limit layer log ngoài ý muốn.

M3.2 chưa triển khai full user auth/IP rate-limit infrastructure. Endpoint production sau này vẫn bắt buộc có rate limit phù hợp vì pairing code là human-readable credential.

## Device credential và bridge authentication — M3.3

M3.3 tách long-lived device credential khỏi `Device` record và khóa các boundary sau:

- raw credential được sinh từ 32 random bytes bằng `crypto.getRandomValues()` = 256 bit entropy;
- server persist SHA-256 digest của domain-prefixed secret, không persist raw credential;
- raw credential chỉ được trả ở thời điểm issue/rotate để giao một lần cho local runtime;
- `credentialId` là UUID v4 riêng, không được reuse giữa device hoặc generation;
- mỗi device có tối đa một credential active;
- ownership luôn lấy từ `DeviceRepository`, không tin `ownerId` do local gửi;
- verify failure dùng generic `CREDENTIAL_UNAVAILABLE`, không echo secret;
- manual digest compare dùng constant-time loop;
- pairing code tuyệt đối không được promote thành long-lived credential.

### Pairing → credential completion

Sau atomic pairing claim, `PairingCredentialCompletionService` issue credential cho đúng `deviceId` vừa được tạo và tạo pending-delivery payload gồm:

```text
pairingSessionId
localCorrelationId?
deviceId
credentialId
credentialVersion
raw credential
```

Payload không chứa pairing code. Duplicate/replay pairing claim dừng trước credential issue thứ hai.

Raw credential chỉ được giữ transient trong memory. Authoritative completion state nằm trong `PairingCredentialCompletionRepository` và **không chứa raw secret**:

```text
pairingSessionId
deviceId
credentialId
credentialVersion
state: pending | delivered
```

`resumeClaimedPairing(pairingSessionId, ownerId)` luôn resolve claimed session và kiểm tra ownership từ server-side `DeviceRepository` **trước** khi đọc transient cache. `pairingSessionId` vì vậy không trở thành bearer secret; wrong owner luôn nhận generic `PAIRING_COMPLETION_UNAVAILABLE` kể cả raw credential đang còn trong memory.

Nếu process restart sau khi credential digest đã persist nhưng trước delivery/ack, raw secret cũ không thể khôi phục từ digest. Recovery path phát hiện credential active đã tồn tại, rotate sang generation mới và trả raw secret mới cho đúng owner. Generation thất lạc cũ bị vô hiệu ngay; server không cần persist raw credential để đạt crash recovery.

ACK không còn là thao tác “xóa cache” đơn thuần. `acknowledgeDelivery()` yêu cầu `pairingSessionId + ownerId + credentialId + credentialVersion`, owner được verify server-side và repository CAS đúng generation `pending -> delivered`.

Security invariant:

- wrong owner hoặc stale generation ACK không consume pending delivery;
- chỉ ACK đúng generation mới xóa raw secret transient;
- `delivered` là terminal và phải persist qua restart;
- pairing session đã delivered không được resume để issue/rotate credential mới, kể cả credential hiện tại sau đó bị revoke.

`InMemoryPairingCredentialCompletionRepository` chỉ là reference adapter. Production persistence phải implement cùng contract và persist terminal state. Runtime cho phép inject `pairingCredentialCompletionRepository` riêng mà không expose raw secret.

Với production persistence dùng chung database, pairing transition + device creation + credential persistence/completion state vẫn nên nằm trong transaction/unit-of-work phù hợp. Recovery-by-rotation là safety net cho cửa sổ persist-before-delivery, không thay thế transaction durability.

### Authenticated bridge handshake

Credential được gửi trong `bridge.hello` WebSocket control frame:

```text
bridge.hello
  sessionId
  auth:
    mode: device
    deviceId
    credential
```

Không đưa credential vào URL/query string.

Production gateway mặc định yêu cầu auth. `createDoctmcpServerRuntime()` luôn wire gateway với `DeviceCredentialService.verify()` dùng cùng repository instance với credential lifecycle. Legacy unauthenticated handshake không được expose từ production composition root.

Credential service/repository mutation không được expose trên `DoctmcpServerRuntime`; caller chỉ có thể revoke/rotate qua lifecycle API có session invalidation. Repository adapters có thể được inject lúc tạo runtime để production thay in-memory persistence mà không phá security boundary này.

Legacy mode chỉ được bật rõ ràng bằng `allowLegacyUnauthenticated: true` khi tạo gateway trực tiếp cho M2 compatibility/test; auth failure không được fallback sang legacy mode.

Gateway chỉ tạo/expose `BridgeGatewaySession` sau khi authenticated ready boundary hoàn tất. Authenticated session giữ:

```text
bridge sessionId
+
identity { ownerId, deviceId }
```

hai namespace này độc lập. Authenticator output được runtime-validate trước khi bind session. Duplicate `sessionId` được kiểm tra lại sau async authentication để hai handshake đồng thời không cùng tạo ready session.

Trước khi auth hoàn tất:

- `mcp.message` bị reject;
- invalid/unknown/revoked/mismatched credential không tạo ready session;
- error trả `AUTH_REQUIRED`/`AUTH_FAILED` generic và không echo credential.

Local `BridgeServerTransport` giữ credential trong auth config và chỉ đưa secret vào `bridge.hello`. Khi gateway trả auth error rồi đóng socket ngay, transport xử lý queued control frame trước native-close cleanup để giữ đúng generic auth error thay vì ghi đè thành `SESSION_CLOSED`.

### Revoke và rotate

`revoke`/`rotate` dùng expected `credentialId + version` làm CAS generation boundary. Hai mutation concurrent trên cùng generation chỉ một mutation được commit.

Server composition root cung cấp lifecycle API có active-session propagation:

- `revokeDeviceCredential(deviceId)` revoke generation hiện tại, đóng authenticated session đang active của đúng device và làm credential cũ fail khi reconnect;
- `rotateDeviceCredential(deviceId)` atomically tạo generation mới, đóng active session cũ, làm secret cũ fail và chỉ secret mới reconnect được;
- auth đã bắt đầu trước mutation phải drain xong; nếu verify trả snapshot cũ trong lúc mutation đang active thì authenticator reject generic thay vì bind session;
- sau initial auth, gateway acquire synchronous **ready lease** trước khi session có thể chuyển `ready`;
- dưới ready lease, gateway reverify credential ngay trước ready/`bridge.hello.ack`;
- revoke/rotate đến sau ready lease chờ lease drain rồi mới mutate, vì vậy handshake được linearize: hoặc commit khi credential còn valid, hoặc bị reject trước ACK;
- không dùng event-loop delay, post-ACK `onSession` guard hay final sweep làm correctness primitive;
- shutdown resolve drain waiter trước khi stop gateway để revoke/rotate đang chờ auth/ready lease không treo vô hạn;
- failure CAS không làm mất generation đang active;
- concurrent rotate/rotate và rotate/revoke đều có regression test.

M3.3 chỉ giữ tracking active session tối thiểu để security property revoke/rotate không bị mơ hồ. #33 vẫn là nơi xây authoritative device-session registry, duplicate connection policy, heartbeat/liveness và online/offline state; không tồn tại hai source of truth lâu dài.

## Audit

Khi thêm audit, mặc định chỉ nên lưu metadata cần thiết:

- user/session;
- device;
- tool;
- thời điểm;
- duration;
- success/failure;
- error code không nhạy cảm.

Không mặc định lưu toàn bộ nội dung file, command output hoặc argument có thể chứa secret.

## Security testing

Feature security-sensitive phải có denied-path test.

Ví dụ:

- path ngoài allow root;
- path nằm trong deny root;
- expired/reused/cancelled pairing code;
- concurrent pairing claim;
- malformed pairing input không mutate state;
- raw pairing code không xuất hiện trong structured error/snapshot;
- wrong/mismatched/revoked device credential;
- concurrent credential rotate/revoke;
- cached pairing completion vẫn owner-check trước khi trả raw secret;
- process-restart recovery sau persist-before-delivery rotate credential thất lạc;
- wrong/stale pairing delivery ACK không consume pending secret;
- delivered completion không resume được qua restart hoặc sau credential revoke;
- raw credential không xuất hiện trong URL/error/log snapshot;
- MCP frame trước authenticated handshake;
- credential thay đổi giữa auth và ready revalidation bị reject trước ACK/session;
- revoke/rotate đóng active authenticated session đúng device;
- shutdown không để credential mutation drain waiter treo vô hạn;
- runtime không expose credential mutation service/repository;
- shell timeout;
- oversized output;
- invalid bridge handshake;
- owner A lookup/update device của owner B.
