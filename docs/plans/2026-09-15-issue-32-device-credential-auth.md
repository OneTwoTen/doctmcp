# Issue #32 — Device credential lifecycle + authenticated bridge handshake

## Mục tiêu

Hoàn tất M3.3 trên foundation #30/#31: sau khi pairing đã tạo/bind `Device`, server cấp long-lived credential riêng cho đúng `deviceId`; local dùng credential đó để authenticate WebSocket bridge mà không pair lại.

## Trạng thái

**Implementation hoàn tất trên branch `codex/m3-3-device-credential-auth`, PR #39; toàn bộ finding review mới nhất đã được xử lý và đang chờ merge.**

## Scope triển khai

- [x] Shared credential/domain contract: credential id/version/state và auth identity.
- [x] Credential store/service tách khỏi `Device` record.
- [x] CSPRNG raw credential 256-bit; server chỉ persist SHA-256 digest có domain prefix, không persist raw secret.
- [x] `issue`, `verify`, `revoke`, `rotate` với CAS generation boundary deterministic.
- [x] `credentialId` unique giữa device/generation trong reference repository.
- [x] Pairing completion helper cấp credential đúng device đã claim và giữ `pairingSessionId`/`localCorrelationId` cho delivery channel.
- [x] Pairing completion owner-check trước cache lookup; `pairingSessionId` không phải bearer secret.
- [x] Completion repository tách raw secret khỏi durable state và khóa lifecycle `pending -> recovering -> pending(new generation) -> delivered`.
- [x] Recovery reservation persist trước rotate, chặn stale ACK trong cửa sổ rotate/finalize và cho phép resume an toàn sau crash.
- [x] Recovery rotation bound vào exact expected `credentialId + version`; process khác không thể rotate nhầm generation vừa được recovery tạo.
- [x] ACK owner/generation-aware; wrong/stale ACK không consume pending delivery; exact duplicate ACK của cùng delivered generation là success/no-op.
- [x] `delivered` là terminal qua restart/revoke.
- [x] Same-process pending-delivery retry idempotent, không issue generation thứ hai.
- [x] Crash-style recovery sau persist-before-delivery và sau rotate-before-finalize đều trả lại một generation deliverable mới mà không persist raw secret.
- [x] Authenticated bridge hello gửi `deviceId` + credential trong frame, không dùng URL/query string.
- [x] Gateway verify credential trước khi session chuyển `ready`/được expose qua `onSession`.
- [x] Gateway acquire ready lease và reverify credential lần cuối trước `bridge.hello.ack`.
- [x] Session authenticated resolve được `{ ownerId, deviceId }` tách khỏi bridge `sessionId`.
- [x] Production composition root luôn wire `DeviceCredentialService.verify()` vào gateway; không có accidental legacy bypass.
- [x] Runtime không expose `credentialService`/`credentialRepository` mutation để caller bypass active-session invalidation.
- [x] Revoke/rotate serialize với ready commit, drain verify in-flight và chặn handshake dùng credential stale.
- [x] Shutdown resolve drain waiter, không để credential mutation treo vô hạn.
- [x] Pre-auth MCP frame bị reject; invalid/unknown/revoked/mismatched credential bị reject generic, không echo secret.
- [x] `revoke`/`rotate` qua server runtime đóng active authenticated session của đúng device và chặn reconnect bằng generation cũ.
- [x] M2 legacy/test handshake explicit qua `allowLegacyUnauthenticated: true`, không là production fallback.
- [x] Authenticated MCP end-to-end và security regression tests.
- [x] Verification implementation CI #224: `check`, `typecheck`, full test xanh; 213/213 test, 878 assertions, 30 files; M2 acceptance 6/6; Windows regression xanh.

## Quyết định kỹ thuật

### Credential

- raw secret: 32 random bytes encode base64url, entropy 256 bit;
- credential id: UUID v4 riêng để rotate/audit mà không log secret;
- digest: SHA-256 trên domain prefix `doctmcp-device-credential:v1:` + raw secret;
- manual digest compare dùng constant-time loop;
- default không expiry ở M3.3; lifecycle dựa vào explicit revoke/rotate;
- mỗi device có tối đa một credential active;
- `rotate`/`revoke` dùng expected `credentialId + version` làm CAS generation boundary;
- `rotateExpected(deviceId, credentialId, version)` là primitive nội bộ cho crash recovery, chỉ rotate đúng generation đã reserve;
- concurrent rotate/rotate hoặc rotate/revoke chỉ một mutation của cùng generation được commit;
- credential id đã dùng không được reuse cho device/generation khác.

### Pairing completion

`PairingCredentialCompletionService.claimAndIssue()` thực hiện:

```text
pairing code
  -> atomic one-time PairingService.claimPairingCode()
  -> Device đã bind owner
  -> DeviceCredentialService.issue(deviceId)
  -> pending delivery keyed by pairingSessionId
       pairingSessionId
       localCorrelationId?
       deviceId
       credentialId/version
       raw credential
```

Raw credential chỉ nằm trong transient cache. Authoritative completion state nằm trong `PairingCredentialCompletionRepository` và không chứa secret:

```text
pairingSessionId
deviceId
credentialId
credentialVersion
state: pending | recovering | delivered
```

Reference runtime giữ completion thành công **transient trong memory** cho tới khi local acknowledge đã lưu credential. Retry cùng `pairingSessionId` trong cùng process trả đúng completion/raw secret cũ, không issue generation mới.

`resumeClaimedPairing(pairingSessionId, ownerId)` luôn resolve claimed session và ownership từ server-side `DeviceRepository` trước khi đọc cache. Wrong owner nhận generic `PAIRING_COMPLETION_UNAVAILABLE` ngay cả khi pending raw secret còn trong memory.

Nếu pairing claim đã commit nhưng credential issue fail, resume retry issue trên đúng device mà không pair lại.

Crash recovery dùng durable reservation thay vì rotate rồi mới ghi state:

```text
pending(generation N)
  -> recovering(generation N)       // CAS reservation trước mutation
  -> rotateExpected(N -> N+1)
  -> pending(generation N+1)        // finalize
  -> delivered(generation N+1)
```

Trong state `recovering`, ACK bị reject. Nếu process crash sau rotate nhưng trước finalize, completion record vẫn giữ source generation cũ còn credential store đã ở generation mới. Lần resume sau đọc generation active, CAS advance reservation sang generation active, rotate đúng generation đó và chỉ trả raw secret sau khi `finishRecovery()` commit `pending` thành công. Vì vậy secret của một generation chưa finalize không bao giờ được coi là delivered.

Nếu nhiều worker cùng recovery, rotation luôn bound vào expected generation. Worker mất CAS/rotation không được trả raw secret; worker thắng chỉ trả secret sau khi completion repository finalize đúng generation.

ACK yêu cầu `pairingSessionId + ownerId + credentialId + credentialVersion`. Owner được resolve server-side và completion repository xử lý:

- `pending` + exact generation → CAS sang `delivered`;
- `delivered` + exact generation → success/no-op để retry ACK an toàn khi response trước bị mất;
- wrong owner, stale generation hoặc state `recovering` → reject;
- failed ACK không xóa transient pending secret;
- sau `delivered`, resume fail deterministic qua restart và kể cả sau khi credential active bị revoke.

Production persistence phải implement `PairingCredentialCompletionRepository` bằng durable store với atomic CAS cho `beginRecovery`, `advanceRecovery`, `finishRecovery` và `acknowledge`. Raw credential tuyệt đối không được persist trong completion record. Runtime hỗ trợ inject adapter này qua `pairingCredentialCompletionRepository`.

Nếu pairing/device/credential/completion cùng database, transaction/unit-of-work vẫn được khuyến nghị để giảm recovery work. Tuy nhiên correctness của delivery recovery không còn phụ thuộc vào một transaction bao trùm rotate + completion finalize: durable `recovering` reservation + expected-generation CAS cho phép resume an toàn qua crash giữa hai write.

### Authenticated bridge

Control-plane mở rộng `bridge.hello`:

```text
bridge.hello
  sessionId
  auth:
    mode: device
    deviceId
    credential
```

`BridgeServerTransport` chỉ đặt credential trong WebSocket control frame, không đưa vào URL/query. Gateway có `authenticateDevice(deviceId, credential)` callback/service.

Authenticated ready flow hiện là:

```text
initial authenticate
  -> acquire synchronous ready lease
  -> reverify credential dưới lease
  -> handshaking -> ready
  -> bridge.hello.ack
  -> onSession(session)
  -> release ready lease
```

Nếu ready guard hoặc final reverify fail, gateway trả generic `AUTH_FAILED` **trước** ACK và không tạo ready session.

Authenticator output được runtime-validate. Gateway re-check duplicate `sessionId` sau async authentication để hai handshake đồng thời không cùng vượt qua pre-auth check.

Nếu gateway trả `AUTH_REQUIRED`/`AUTH_FAILED` trong handshake, local transport giữ nguyên generic bridge error code. Native close cleanup chờ inbound control-frame chain để auth error không bị ghi đè thành `SESSION_CLOSED`.

`createDoctmcpServerRuntime()` là composition root của server M3: gateway ở đường chạy chính luôn dùng đúng `DeviceCredentialService.verify()` trên cùng repository instance với pairing/credential lifecycle. Credential service/repository mutation không được expose trên runtime public surface; persistence adapters được inject qua creation options.

M2 compatibility không fallback tự động khi auth fail. Legacy hello chỉ được chấp nhận khi gateway được tạo trực tiếp với `allowLegacyUnauthenticated: true` trong M2 acceptance/test.

### Revoke / rotate và active-session race

- revoke: credential active chuyển revoked; active authenticated session của device bị close qua runtime lifecycle API; reconnect bằng credential cũ fail;
- rotate: secret/id mới atomically thay generation active; active session của device bị close; credential cũ fail và credential mới reconnect được;
- credential mutation đánh dấu device đang mutate trước khi repository operation bắt đầu;
- auth mới của cùng device bị reject trong mutation window;
- auth đã bắt đầu trước mutation được track/drain; nếu verify trả snapshot cũ trong lúc mutation active, authenticator trả generic auth failure;
- handshake đã acquire ready lease được phép commit khi credential còn valid; mutation đến sau phải chờ ready lease drain rồi mới revoke/rotate;
- gateway reverify credential dưới lease ngay trước `ready`/ACK, nên mutation đã hoàn tất giữa initial auth và ready commit làm handshake fail trước ACK;
- correctness không còn dựa vào `setTimeout(0)`, event-loop turn, post-ACK `onSession` guard hoặc final sweep;
- `stop()` resolve auth/ready drain waiters trước gateway shutdown để revoke/rotate đang chờ không treo vô hạn;
- failure CAS không làm mất generation hiện tại;
- #33 vẫn chịu trách nhiệm thay tracking tối thiểu bằng authoritative device-session registry, duplicate-session policy, heartbeat và online/offline state.

## Test coverage

Đã thêm coverage cho:

- issue credential đúng device + owner từ `DeviceRepository`;
- raw secret không nằm trong persisted credential snapshot;
- valid, wrong, unknown, mismatched device/secret;
- revoke và rotate;
- concurrent rotate/revoke và rotate/rotate;
- global credential-id reuse rejection;
- production gateway yêu cầu auth mặc định;
- production composition root wire verifier thật, không phải test-only callback;
- runtime không expose credential service/repository mutation;
- invalid credential không expose ready session và không echo secret;
- MCP trước auth bị reject;
- local transport gửi auth trong `bridge.hello`, không trong URL;
- local giữ `AUTH_FAILED` generic từ gateway;
- authenticated gateway + local runtime + MCP Client chạy flow thật;
- revoke đóng active session và credential cũ không reconnect được;
- revoke thắng handshake đang verify snapshot credential cũ trước khi upper layer nhận session;
- credential thay đổi giữa initial auth và ready revalidation bị reject trước ACK/session;
- rotate đóng active session, old secret fail và new generation reconnect được;
- pairing completion giữ đúng correlation/device;
- duplicate claim không issue credential thứ hai;
- successful completion retry trả cùng pending delivery;
- cached pending delivery vẫn owner-check trước raw secret;
- issue fail sau claimed pairing recover được bằng `pairingSessionId`;
- restart sau persist-before-delivery rotate credential thất lạc và trả secret mới;
- crash sau rotate nhưng trước completion finalize giữ `recovering`, chặn ACK cũ và resume sang generation deliverable mới;
- wrong/stale ACK không consume pending delivery;
- exact duplicate ACK cùng delivered generation là idempotent success;
- correct ACK làm `delivered` terminal qua restart và sau revoke;
- recovery không tin owner do caller tự khai báo;
- shutdown resolve credential mutation drain waiter;
- M2 acceptance dùng explicit legacy/test mode.

## Verification cuối

CI #224 trên implementation head `aa47545b`:

- `bun run check`: pass;
- `bun run typecheck`: pass;
- `bun test`: **213 pass / 0 fail**, 878 expects, 30 files;
- M2 acceptance: **6/6 pass**;
- M3 authenticated acceptance: pass;
- recovery reservation crash-window regression: pass;
- exact duplicate terminal ACK regression: pass;
- Windows `shell.exec` regression step: pass.

Script `bun run test:m2` trỏ trực tiếp tới `apps/server/src/m2-acceptance.test.ts`; cùng file này đã chạy 6/6 trong full test của CI #224.

## Out of scope

- authoritative device session registry, duplicate connection policy, heartbeat/online state (#33);
- reconnect/backoff loop (#34);
- multi-device routing (#35);
- public MCP endpoint/user OAuth (M4);
- OS keychain packaging.
