# Bảo mật

`doctmcp` có thể đọc/ghi file và thực thi lệnh trên máy local, vì vậy security là yêu cầu kiến trúc từ đầu, không phải phần bổ sung sau.

## Trust boundary

Các ranh giới chính:

- MCP client/ChatGPT → public server;
- public server → authenticated device/session;
- custom transport → local MCP runtime;
- local MCP runtime → permission engine;
- local tool → filesystem/process/network/resource của hệ điều hành.

Mỗi boundary phải validate dữ liệu ở mức phù hợp. Không dựa vào việc lớp trước đã validate để bỏ kiểm tra ở lớp sau nếu hậu quả có thể ảnh hưởng máy local.

## Nguyên tắc nền

- Không expose local MCP runtime trực tiếp ra Internet chỉ để public server kết nối vào.
- Local chủ động mở outbound connection tới public server.
- Ngoài local development, dùng TLS/WSS cho kết nối remote.
- Không ghi log token, raw pairing code, private key hoặc credential đầy đủ.
- Permission quan trọng phải được enforce tại local runtime.
- Path filesystem phải normalize/canonicalize trước khi áp allow/deny policy.
- Tool có side effect phải có timeout/cancellation hoặc giới hạn tương ứng khi khả thi.
- Device credential phải hỗ trợ revoke/rotate trước khi production use.

## MCP không thay thế permission

MCP mô tả capability/tool call, nhưng tool xuất hiện trong `tools/list` không đồng nghĩa mọi request đều được phép thực thi.

```text
tools/call filesystem.read
        -> validate input
        -> canonicalize path
        -> permission check
             deny  -> structured error
             allow -> implementation thật
```

Public server không được coi là boundary duy nhất bảo vệ hệ điều hành local. Nếu public server bị compromise, permission local vẫn phải giới hạn capability theo policy đã cấu hình.

## Filesystem và shell

Filesystem cần tối thiểu:

- canonical path check;
- deny ưu tiên hơn allow;
- chống traversal;
- symlink/canonical-target validation;
- read/write size limits khi cần;
- không expose secret directory mặc định.

`shell.exec` cần tối thiểu:

- timeout/cancellation;
- output size limit;
- cwd policy;
- environment filtering;
- permission/approval policy;
- structured exit status;
- không mặc định log toàn bộ command output.

Không dựa vào blacklist vài command nguy hiểm như lớp bảo vệ duy nhất.

## Device identity và ownership — M3.1

Các invariant:

- `deviceId` là immutable routing identity; `deviceName` không phải authorization key;
- `ownerId` là opaque principal server-side và không đổi qua metadata update;
- owner-scoped APIs phải chặn cross-owner lookup/update;
- UUID `deviceId` được coi là opaque;
- `Device` không chứa raw credential, authoritative online state, bridge session object hoặc MCP session id.

Authenticated identity ở server vẫn không bypass local permission engine.

## Pairing security — M3.2

Pairing code là credential ngắn hạn, dùng một lần:

- TTL mặc định 5 phút;
- 12 symbols trên alphabet 32 = 60 bit entropy;
- generator dùng `crypto.getRandomValues()`;
- store chỉ persist SHA-256 digest có domain prefix, không raw code;
- claim tại `expiresAt` hoặc muộn hơn bị reject;
- claim thành công invalidate code ngay;
- cancelled/expired/reused/unknown/malformed đều map generic `PAIRING_CODE_UNAVAILABLE`;
- production log/error không chứa raw code.

### Atomic claim

Pairing claim và device creation phải nằm trong transaction/lock/CAS boundary tương đương. Không triển khai production theo kiểu:

```text
check pending -> await create device -> mark claimed
```

với ba write/check rời rạc.

`InMemoryPairingSessionRepository` là reference adapter và serialize toàn bộ mutation bằng critical section. Production adapter phải giữ atomic invariant tương đương.

### Anti-bruteforce boundary

`PairingClaimAttemptGuard` chỉ nhận trusted `ownerId`, code digest hoặc `null`, và optional remote address. Raw pairing code không được truyền vào observability/rate-limit hook.

## Device credential và bridge authentication — M3.3

Long-lived credential tách khỏi `Device` record:

- raw secret = 32 CSPRNG bytes, 256 bit entropy;
- server persist SHA-256 digest của domain-prefixed secret;
- raw secret chỉ xuất hiện lúc issue/rotate/delivery;
- `credentialId` riêng, không reuse giữa device/generation;
- mỗi device tối đa một credential active;
- owner luôn resolve từ `DeviceRepository`;
- verify failure generic `CREDENTIAL_UNAVAILABLE`;
- manual digest compare constant-time;
- pairing code không được promote thành long-lived credential.

## Pairing → credential completion

Delivery payload gồm:

```text
pairingSessionId
localCorrelationId?
deviceId
credentialId
credentialVersion
raw credential
```

Raw secret chỉ tồn tại transient. Authoritative completion record tuyệt đối không chứa secret:

```text
pairingSessionId
deviceId
credentialId
credentialVersion
state: pending | recovering | delivered
```

Owner được verify server-side trước khi đọc pending-secret cache, vì vậy `pairingSessionId` không phải bearer credential.

### Crash-safe recovery reservation

Persist-before-delivery recovery không được làm theo thứ tự nguy hiểm:

```text
rotate credential
-> sau đó mới update completion generation
```

vì crash/race giữa hai write có thể làm mất raw secret mới và để completion trỏ generation cũ.

Contract hiện tại dùng durable reservation:

```text
pending(N)
  -> recovering(N)          // persist/CAS trước mutation
  -> rotateExpected(N,N+1) // exact generation CAS
  -> pending(N+1)           // finalize
  -> delivered(N+1)
```

Security invariant:

- ACK bị reject trong `recovering`;
- stale generation không thể trở thành `delivered` trong recovery window;
- nếu crash sau rotate nhưng trước finalize, next resume nhận thấy active generation đã advance, CAS reservation sang generation active rồi rotate lại từ **đúng expected generation**;
- raw secret chỉ được trả sau khi `finishRecovery()` đã commit `pending` cho generation đó;
- concurrent worker mất CAS không được trả raw secret;
- completion repository không persist raw secret.

Production adapter phải implement atomic CAS semantics cho:

- `beginRecovery`;
- `advanceRecovery`;
- `finishRecovery`;
- `acknowledge`.

Nếu các store cùng database, transaction/unit-of-work vẫn được khuyến nghị để giảm recovery work, nhưng correctness của rotate/finalize crash window dựa trên durable reservation + generation CAS, không dựa vào timing hoặc raw-secret persistence.

### ACK security contract

`acknowledgeDelivery()` yêu cầu `pairingSessionId + ownerId + credentialId + credentialVersion`.

- pending + exact owner/generation → delivered;
- delivered + exact owner/generation → success/no-op, hỗ trợ retry sau lost response;
- wrong owner → reject;
- stale/wrong generation → reject;
- recovering → reject;
- failed ACK không xóa transient pending secret;
- delivered là terminal qua restart và cả khi credential hiện tại sau đó bị revoke.

## Authenticated bridge handshake

Credential chỉ đi trong `bridge.hello` control frame:

```text
bridge.hello
  sessionId
  auth:
    mode: device
    deviceId
    credential
```

Không đưa credential vào URL/query.

Production runtime luôn wire `DeviceCredentialService.verify()` vào gateway. Legacy unauthenticated mode không được expose từ `createDoctmcpServerRuntime()`; chỉ direct test/M2 compatibility path có thể bật `allowLegacyUnauthenticated: true`.

Session authenticated giữ riêng:

```text
bridge sessionId
+
identity { ownerId, deviceId }
```

Trước auth complete:

- `mcp.message` bị reject;
- invalid/unknown/revoked/mismatched credential không tạo ready session;
- error generic, không echo credential.

## Ready boundary và revoke/rotate race

Initial verify một mình chưa đủ vì credential có thể thay đổi trước ACK. Production runtime dùng ready lease:

```text
initial authenticate
  -> acquire ready lease
  -> reverify credential
  -> ready
  -> bridge.hello.ack
  -> onSession
  -> release lease
```

Revoke/rotate:

- đánh dấu credential mutation boundary theo device;
- chặn auth mới trong mutation window;
- drain auth in-flight;
- chờ ready lease đã acquire hoàn tất trước mutation;
- close active authenticated session sau mutation;
- old secret reconnect fail;
- recovery rotation cũng đi qua cùng mutation/session-invalidation boundary.

Correctness không dựa vào event-loop delay, `setTimeout(0)`, post-ACK guard hay final sweep.

`stop()` resolve auth/ready drain waiters trước gateway shutdown để mutation đang chờ không treo vô hạn.

#33 vẫn chịu trách nhiệm authoritative device-session registry, duplicate connection policy, heartbeat/liveness và online/offline state.

## Audit

Audit mặc định chỉ nên lưu metadata cần thiết như user/session/device/tool/timestamp/duration/result/error code. Không mặc định lưu file content, command output hoặc argument có thể chứa secret.

## Security regression coverage

Các boundary security-sensitive hiện có test cho:

- traversal/symlink/deny/root delete;
- pairing expiry/reuse/cancel/concurrent claim;
- malformed pairing input và no-secret error;
- wrong/mismatched/revoked device credential;
- concurrent rotate/revoke và rotate/rotate;
- cached pairing completion vẫn owner-check;
- restart persist-before-delivery recovery;
- **crash sau rotate trước completion finalize**;
- `recovering` chặn ACK generation cũ;
- wrong/stale ACK không consume pending delivery;
- exact duplicate delivered ACK idempotent;
- delivered terminal qua restart/revoke;
- raw credential không xuất hiện trong URL/error/log snapshot;
- MCP trước authenticated handshake;
- credential thay đổi giữa auth và ready revalidation bị reject trước ACK/session;
- revoke/rotate đóng active authenticated session;
- shutdown không để mutation drain waiter treo;
- runtime không expose credential mutation service/repository.

CI #224 trên implementation head `aa47545b`: Biome ✅, typecheck ✅, **213/213 tests**, 878 assertions, 30 files; M2 acceptance 6/6 và Windows regression ✅.
