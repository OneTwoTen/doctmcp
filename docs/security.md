# Security model

## Trust boundaries

Các boundary chính:

- MCP client/ChatGPT → public server;
- public server → authenticated device/session;
- custom bridge transport → local MCP runtime;
- local MCP runtime → permission engine;
- local tool → filesystem/process/network/resource của hệ điều hành.

Mỗi boundary phải validate dữ liệu ở mức phù hợp. Không được bỏ validation ở lớp sau chỉ vì lớp trước đã validate nếu hậu quả có thể ảnh hưởng máy local.

## Nguyên tắc nền

- Không expose local MCP runtime trực tiếp ra Internet chỉ để public server kết nối vào.
- Local chủ động mở outbound connection tới public server.
- Remote production dùng TLS/WSS.
- Không log raw pairing code, raw device credential, token, private key hoặc secret đầy đủ.
- Permission quan trọng được enforce tại local runtime; authenticated server identity không bypass permission local.
- Filesystem path phải canonicalize trước allow/deny policy.
- Tool có side effect phải có timeout/cancellation/size limit phù hợp.
- Long-lived device credential phải revoke/rotate được.

## Local permission vẫn là boundary cuối

MCP chỉ mô tả capability/tool call. Tool xuất hiện trong `tools/list` không đồng nghĩa mọi request đều được phép chạy.

```text
tools/call
  -> validate input
  -> canonicalize resource/path
  -> local permission check
       deny  -> structured error
       allow -> implementation thật
```

Public server được coi là có thể bị compromise. Local permission vẫn phải giới hạn capability theo policy đã cấu hình.

## Filesystem và shell

Filesystem tối thiểu cần:

- canonical path containment;
- deny ưu tiên hơn allow;
- traversal protection;
- symlink/canonical-target validation;
- read/write size limits khi cần;
- secret directory không được expose mặc định.

`shell.exec` tối thiểu cần:

- timeout/cancellation;
- process-tree termination khi timeout/output limit/cancel;
- output size limit;
- cwd policy;
- environment filtering;
- executable/permission policy;
- structured exit status;
- không mặc định log toàn bộ output.

Blacklist vài command nguy hiểm không phải lớp bảo vệ đủ mạnh.

## Device identity

Security invariant của M3.1:

- `deviceId` là immutable routing identity;
- `deviceName` chỉ là display metadata;
- `ownerId` là opaque server-side principal và immutable qua metadata update;
- owner-scoped API chặn cross-owner lookup/update;
- `Device` không chứa raw credential, authoritative online state, bridge session hoặc MCP session id.

## Pairing security

Pairing code là short-lived one-time credential:

- TTL mặc định 5 phút;
- 60 bit entropy;
- CSPRNG bằng `crypto.getRandomValues()`;
- server persist SHA-256 digest có domain prefix, không raw code;
- claim thành công consume code ngay;
- malformed/unknown/expired/reused/cancelled cùng map generic `PAIRING_CODE_UNAVAILABLE`;
- raw code không đi vào observability/rate-limit hook.

### Atomic pairing claim

Production không được tách:

```text
check pending
-> create Device
-> mark pairing claimed
```

thành các write độc lập không transaction/lock/CAS. Pairing transition và device creation phải nằm trong atomic unit-of-work hoặc primitive tương đương.

M5 start route giới hạn body ở 2 KiB, yêu cầu JSON strict `{deviceName, channelProof}`, dùng remote address do Bun gateway cung cấp và rate-limit theo địa chỉ. `X-Forwarded-For` không được dùng. Remote plaintext pairing start bị từ chối; HTTP chỉ dùng loopback development. TLS proxy ngoài loopback chỉ được tin khi peer IP chính xác nằm trong `TRUSTED_PROXY_ADDRESSES` và `X-Forwarded-Proto` bằng `https`; biến này không bật trust cho forwarded client IP. Pairing repository giới hạn số session và runtime loại record hết hạn theo chu kỳ. Pairing WebSocket có giới hạn frame/socket/attach timeout, proof digest constant-time và một socket active cho mỗi session.

`devices_pair` chỉ đăng ký trên public MCP endpoint đã qua bearer/OAuth scope check. `ownerId` được dẫn xuất từ verified auth context, không nhận trong arguments. Credential chỉ đi trên pairing socket; local persist trước ACK; MCP response/audit chỉ có device metadata và outcome/error code.

## Device credential

Long-lived credential tách khỏi `Device` record:

- raw secret = 32 CSPRNG bytes, 256 bit entropy;
- wire encoding = **43 ký tự unpadded base64url**, chỉ `[A-Za-z0-9_-]`;
- authenticated bridge reject credential sai length, có padding `=`, `+`, `/` hoặc ký tự ngoài base64url trước verifier;
- raw secret chỉ xuất hiện lúc issue/rotate/delivery;
- server persist SHA-256 digest có domain prefix `doctmcp-device-credential:v1:`;
- `credentialId` riêng cho từng generation và không reuse;
- mỗi device tối đa một active credential;
- owner luôn resolve từ `DeviceRepository`;
- wrong/unknown/revoked credential trả generic `CREDENTIAL_UNAVAILABLE` / `AUTH_FAILED` ở public boundary;
- digest comparison dùng constant-time loop;
- pairing code không được promote thành device credential.

## Pairing → credential completion

Durable completion record không chứa secret:

```text
pairingSessionId
deviceId
credentialId
credentialVersion
state: pending | recovering | delivered
recoveryTargetCredentialId?
```

Raw secret chỉ tồn tại transient.

### Crash-safe reservation

Không triển khai recovery theo thứ tự nguy hiểm:

```text
rotate credential
-> sau đó mới persist recovery metadata
```

Correct sequence:

```text
pending(N)
  -> recovering(source N, target T)       // persist/CAS trước mutation
  -> rotateExpectedWithCredentialId(N,T) // exact source + target
  -> pending(T/N+1)                       // finalize
  -> delivered(T/N+1)
```

Invariant:

- ACK bị reject trong `recovering`;
- crash sau rotate trước finalize chỉ được nhận diện là recovery commit nếu active credential khớp đúng reserved target + expected next version;
- explicit revoke làm recovery fail closed, không issue lại;
- explicit rotate sang id khác không bị recovery supersede;
- raw secret chỉ deliver sau exact completion generation đã finalize;
- completion repository không persist secret.

Production completion adapter phải có atomic CAS semantics cho `beginRecovery`, `advanceRecovery`, `finishRecovery`, `acknowledge`, bao gồm `recoveryTargetCredentialId`.

## Per-device credential lifecycle coordinator

Durable reservation xử lý crash consistency giữa credential store và completion store. Nó **không tự giải quyết runtime race** giữa pairing completion và explicit rotate/revoke.

`createDoctmcpServerRuntime()` vì vậy serializes các operation security-sensitive của cùng `deviceId` qua `DeviceCredentialLifecycleCoordinator`.

```text
                 ┌─ initial issue -> setPending ─┐
                 │                              │
device lifecycle ├─ recovery rotate -> finalize ├─ one linearized stream
                 │                              │
                 └─ explicit rotate / revoke ───┘
```

Security properties:

- lifecycle mutation intent được đánh dấu trước async generation snapshot;
- auth mới bị chặn ngay khi mutation intent tồn tại;
- auth đã in-flight được drain/invalidated trước marker release;
- mutation chờ ready lease đang commit hoàn tất;
- initial issue giữ lock qua `issue + setPending`;
- recovery giữ lock qua `rotateExpected + finishRecovery + final active validation`;
- explicit rotate/revoke dùng expected-generation CAS dưới cùng lock;
- explicit mutation không thể chen vào rotate/finalize window;
- concurrent explicit requests snapshot cùng generation vẫn chỉ một CAS commit được;
- active authenticated session bị close sau successful rotate/revoke/recovery rotation trong cùng runtime process.

### Single-process vs multi-instance

`InMemoryDeviceCredentialLifecycleCoordinator` chỉ đảm bảo serialization trong **một server process**.

Nếu nhiều server instance dùng chung credential/completion database, production phải inject một coordinator backed bởi shared/distributed per-device lease, database advisory/row lock, hoặc primitive tương đương. Mỗi process tự tạo một in-memory coordinator riêng **không** đáp ứng cross-instance linearization.

Coordinator không thay thế CAS trong persistence. Cả hai đều cần:

- coordinator: serialize high-level lifecycle sequence;
- credential/completion CAS: bảo vệ authoritative store và crash/retry correctness.

Cross-instance **active-session invalidation** được triển khai ở #33. Registry M3.4 giữ credential generation của session và dùng shared invalidation/pub-sub event generation-aware. Revoke/rotate ở một instance phải close stale session trên instance khác trong bounded default **≤ 5 giây**; delayed/duplicate event không được close session generation mới. Router M3.6 tiếp tục xác minh exact active generation ở mỗi lần resolve.

## Stale completion cache và ACK

Same-process transient cache không được biến `pairingSessionId` thành đường lấy stale secret.

Production runtime revalidate exact active `credentialId + version` trước khi trả completion. Vì vậy sau explicit revoke/rotate:

- cached raw secret cũ không được trả lại;
- pending ACK của generation đã mất hiệu lực bị reject;
- ACK check và transition được serialize với lifecycle mutation;
- exact duplicate ACK của một generation đã `delivered` vẫn idempotent kể cả credential sau đó bị revoke/rotate.

## Authenticated bridge handshake

Credential chỉ đi trong `bridge.hello` frame:

```text
bridge.hello
  sessionId
  auth:
    mode: device
    deviceId
    credential
```

Không đưa credential vào URL/query.

Production gateway:

- yêu cầu auth mặc định;
- `auth.deviceId` dùng shared UUID-v4 schema và được canonicalize;
- `auth.credential` bắt buộc exact 43-char unpadded-base64url shape trước authenticator;
- validate authenticator output;
- bind server-side `{ ownerId, deviceId }` vào ready session;
- reject `mcp.message` trước handshake;
- invalid/unknown/revoked/mismatched credential không tạo ready session;
- auth error generic và không echo secret;
- legacy unauthenticated mode chỉ bật explicit trong M2 compatibility/test path.

## Ready boundary và revoke/rotate race

Initial verify chưa đủ vì credential có thể đổi trước ACK.

```text
initial authenticate
  -> acquire ready lease
  -> reverify credential
  -> ready
  -> bridge.hello.ack
  -> onSession
  -> release ready lease
```

Credential lifecycle mutation:

```text
mark mutation intent
  -> block new auth
  -> wait ready lease drain
  -> mutate exact expected generation
  -> close active device sessions
  -> drain auth in-flight
  -> release lifecycle marker
```

Correctness không dựa vào event-loop delay, `setTimeout(0)`, post-ACK sweep hoặc timing post-check.

`stop()` resolve auth/ready drain waiters trước gateway shutdown để lifecycle operation không treo vô hạn.

## Outbound WebSocket send failure

Ready session không được giữ active nếu native WebSocket không nhận frame.

`sendWebSocketFrameOrCleanup()` phải:

- cleanup session map trước khi reject;
- đóng native connection;
- không để session tiếp tục `ready`;
- hoạt động đúng kể cả `idleTimeoutMs = 0`.

Validation/serialization error của outbound message không được bị nhận nhầm thành socket failure và không được tự đóng một socket khỏe mạnh.

## Public MCP và OIDC (M4)

- `/mcp` là OAuth resource server. Token do authorization server OIDC bên ngoài phát; local MCP/bridge credential không được dùng làm user token.
- Kiểm tra chữ ký bằng key từ HTTPS OIDC discovery/JWKS, exact issuer, configured audience, `exp`, `sub` và scope `mcp`. Sai token nhận generic Bearer 401; thiếu scope nhận 403.
- `ownerId` là hash domain-separated ổn định của `issuer + sub`; không dùng email, display name hoặc OAuth `client_id` làm owner key.
- RFC 9728 Protected Resource Metadata và Bearer challenge được phục vụ công khai để client khám phá authorization server; chúng không chứa secret.
- Public tool alias chứa `deviceId` canonical đầy đủ. Mỗi callback kiểm tra owner và active credential generation lại; tool alias không được route theo device name hoặc fallback sang session khác.
- Cache MCP tool catalog chỉ là metadata trong process. Offline cache chỉ cho phép trả mã `DEVICE_OFFLINE`; nó không cho phép gửi lệnh tới session cũ.
- Audit không ghi bearer token, JWT claims, arguments, file content, command output hoặc tool result.
- `/mcp` fail-closed khi OIDC config thiếu hoặc verifier không khởi tạo được. Mặc định in-memory repository không phù hợp cho production restart/multi-process.

## Audit

Audit mặc định chỉ lưu metadata cần thiết:

- principal/session/device;
- tool/action;
- timestamp/duration;
- success/failure;
- non-sensitive error code.

Không mặc định lưu file content, command output, raw arguments hoặc secret.

## Security regression coverage

Security-sensitive changes phải có denied/race-path test. M3.3 hiện giữ regression cho:

- malformed credential wire shape;
- wrong/mismatched/revoked credential;
- concurrent rotate/revoke và rotate/rotate;
- initial issue vs explicit rotate barrier;
- recovery rotate/finalize vs explicit rotate barrier;
- mutation intent vs handshake in-flight;
- stale same-process completion cache sau rotate/revoke;
- stale pending ACK sau external mutation;
- crash sau rotate trước recovery finalize;
- explicit external revoke/rotate không bị recovery đảo ngược;
- ready revalidation trước ACK/session exposure;
- revoke/rotate đóng active authenticated session;
- outbound send-failure cleanup;
- shutdown drain waiter;
- runtime không expose raw credential service/repository mutation surface.

CI/head/test count mới nhất được ghi ở PR thay vì hard-code trong security contract.

M3.4/#33 cung cấp authoritative device-session registry, duplicate-session policy, generation-aware cross-instance invalidation, heartbeat/liveness và online/offline state. M3.6/#35 owner-scope mọi lookup và từ chối route khi credential generation không còn active. M3.7 khóa expired/reused/concurrent pairing, sai device credential, routed MCP flow, reconnect và secret-redaction qua `bun run test:m3`.
