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
- [x] Same-process pending-delivery retry idempotent, không issue generation thứ hai.
- [x] Crash-style recovery sau persist-before-delivery: nếu active credential đã tồn tại nhưng raw secret mất, rotate sang generation mới và trả secret mới.
- [x] Authenticated bridge hello gửi `deviceId` + credential trong frame, không dùng URL/query string.
- [x] Gateway verify credential trước khi session chuyển `ready`/được expose qua `onSession`.
- [x] Session authenticated resolve được `{ ownerId, deviceId }` tách khỏi bridge `sessionId`.
- [x] Production composition root luôn wire `DeviceCredentialService.verify()` vào gateway; không có accidental legacy bypass.
- [x] Runtime không expose `credentialService`/`credentialRepository` mutation để caller bypass active-session invalidation.
- [x] Revoke/rotate đóng auth boundary theo device, drain verify in-flight và chặn handshake dùng snapshot credential cũ.
- [x] Pre-auth MCP frame bị reject; invalid/unknown/revoked/mismatched credential bị reject generic, không echo secret.
- [x] `revoke`/`rotate` qua server runtime đóng active authenticated session của đúng device và chặn reconnect bằng generation cũ.
- [x] M2 legacy/test handshake explicit qua `allowLegacyUnauthenticated: true`, không là production fallback.
- [x] Authenticated MCP end-to-end và security regression tests.
- [x] Verification implementation CI #199: `check`, `typecheck`, full test xanh; 208/208 test, M2 acceptance 6/6, Windows regression xanh.

## Quyết định kỹ thuật

### Credential

- raw secret: 32 random bytes encode base64url, entropy 256 bit;
- credential id: UUID v4 riêng để rotate/audit mà không log secret;
- digest: SHA-256 trên domain prefix `doctmcp-device-credential:v1:` + raw secret;
- manual digest compare dùng constant-time loop;
- default không expiry ở M3.3; lifecycle dựa vào explicit revoke/rotate;
- mỗi device có tối đa một credential active;
- `rotate`/`revoke` dùng expected `credentialId + version` làm CAS generation boundary;
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

Reference runtime giữ completion thành công **transient trong memory** cho tới khi local acknowledge đã lưu credential. Retry cùng `pairingSessionId` trong cùng process trả đúng completion/raw secret cũ, không issue generation mới.

`resumeClaimedPairing(pairingSessionId, ownerId)` luôn resolve claimed session và ownership từ server-side `DeviceRepository` trước khi đọc cache. Wrong owner nhận generic `PAIRING_COMPLETION_UNAVAILABLE` ngay cả khi pending raw secret còn trong memory.

Nếu pairing claim đã commit nhưng credential issue fail, resume retry issue trên đúng device mà không pair lại.

Nếu process restart sau khi credential digest đã persist nhưng trước delivery/ack, raw secret cũ không thể phục hồi từ hash. Resume phát hiện active credential đã tồn tại và dùng recovery hook để rotate generation đó, trả secret mới cho local; generation thất lạc cũ bị vô hiệu. Production runtime nối recovery hook vào cùng credential-mutation/session-invalidation boundary với explicit rotate.

Sau khi local persist credential thành công, control-plane gọi `acknowledgeDelivery(pairingSessionId)` để xóa raw credential pending khỏi memory.

Production persistence dùng chung database vẫn nên đặt pairing claim + device creation + credential persistence trong cùng transaction/unit-of-work. Raw credential pending delivery không được persist/log; recovery-by-rotation chỉ là safety net cho cửa sổ persist-before-delivery.

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

`BridgeServerTransport` chỉ đặt credential trong WebSocket control frame, không đưa vào URL/query. Gateway có `authenticateDevice(deviceId, credential)` callback/service. Chỉ khi callback trả server-side identity `{ ownerId, deviceId }` hợp lệ và khớp request thì mới:

```text
handshaking -> ready
create session
onSession(session)
allow mcp.message
```

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
- nếu auth vừa return ngay trước mutation, mutation giữ boundary qua một event-loop turn; `onSession` mutation guard + final sweep ngăn session stale được expose lâu dài;
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
- rotate đóng active session, old secret fail và new generation reconnect được;
- pairing completion giữ đúng correlation/device;
- duplicate claim không issue credential thứ hai;
- successful completion retry trả cùng pending delivery;
- cached pending delivery vẫn owner-check trước raw secret;
- issue fail sau claimed pairing recover được bằng `pairingSessionId`;
- restart sau persist-before-delivery rotate credential thất lạc và trả secret mới;
- recovery không tin owner do caller tự khai báo;
- M2 acceptance dùng explicit legacy/test mode.

## Verification cuối

CI #199 trên implementation head `b30d4b2e`:

- `bun run check`: pass;
- `bun run typecheck`: pass;
- `bun test`: **208 pass / 0 fail**, 849 expects, 27 files;
- M2 acceptance: **6/6 pass**;
- M3 authenticated acceptance: pass;
- server runtime auth/invalidation regression: **5/5 pass**;
- pairing completion/recovery regression: **7/7 pass**;
- Windows `shell.exec` regression step: pass.

Script `bun run test:m2` trỏ trực tiếp tới `apps/server/src/m2-acceptance.test.ts`; cùng file này đã chạy 6/6 trong full test của CI #199.

## Out of scope

- authoritative device session registry, duplicate connection policy, heartbeat/online state (#33);
- reconnect/backoff loop (#34);
- multi-device routing (#35);
- public MCP endpoint/user OAuth (M4);
- OS keychain packaging.
