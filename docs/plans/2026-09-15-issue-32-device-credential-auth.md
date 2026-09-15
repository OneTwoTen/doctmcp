# Issue #32 — Device credential lifecycle + authenticated bridge handshake

## Mục tiêu

Hoàn tất M3.3 trên foundation #30/#31: sau khi pairing đã tạo/bind `Device`, server cấp long-lived credential riêng cho đúng `deviceId`; local dùng credential đó để authenticate WebSocket bridge mà không pair lại.

## Trạng thái

**Implementation hoàn tất trên branch `codex/m3-3-device-credential-auth`, PR #39; đang chờ review/merge.**

## Scope triển khai

- [x] Shared credential/domain contract: credential id/version/state và auth identity.
- [x] Credential store/service tách khỏi `Device` record.
- [x] CSPRNG raw credential 256-bit; server chỉ persist SHA-256 digest có domain prefix, không persist raw secret.
- [x] `issue`, `verify`, `revoke`, `rotate` với CAS generation boundary deterministic.
- [x] `credentialId` unique giữa device/generation trong reference repository.
- [x] Pairing completion helper cấp credential đúng device đã claim và giữ `pairingSessionId`/`localCorrelationId` cho delivery channel.
- [x] Authenticated bridge hello gửi `deviceId` + credential trong frame, không dùng URL/query string.
- [x] Gateway verify credential trước khi session chuyển `ready`/được expose qua `onSession`.
- [x] Session authenticated resolve được `{ ownerId, deviceId }` tách khỏi bridge `sessionId`.
- [x] Pre-auth MCP frame bị reject; invalid/unknown/revoked/mismatched credential bị reject generic, không echo secret.
- [x] Active session policy M3.3: revoke/rotate vô hiệu credential cho reconnect mới; đóng active session theo registry sẽ thuộc #33 để tránh tạo registry song song trong #32.
- [x] M2 legacy/test handshake explicit qua `allowLegacyUnauthenticated: true`, không là production fallback.
- [x] Authenticated MCP end-to-end và security regression tests.
- [x] Final verification trên CI #176: `check`, `typecheck`, full test xanh; 198/198 test, M2 acceptance 6/6, Windows regression xanh.

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
  -> one-time delivery payload
       pairingSessionId
       localCorrelationId?
       deviceId
       credentialId/version
       raw credential
```

Duplicate/replay pairing code dừng ở pairing boundary nên không thể issue credential thứ hai.

Reference in-memory implementation **không giả vờ cung cấp distributed transaction** giữa pairing repository và credential repository. Khi production persistence dùng chung database, adapter phải đặt pairing claim + device creation + credential persistence trong cùng transaction. Raw credential chỉ được trả sau credential issue thành công và không được persist/log ở server.

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

M2 compatibility không fallback tự động khi auth fail. Legacy hello chỉ được chấp nhận khi gateway được tạo với `allowLegacyUnauthenticated: true` trong M2 acceptance/test.

### Revoke / rotate

- revoke: credential active chuyển revoked; verify/reconnect sau đó fail;
- rotate: secret/id mới atomically thay generation active; secret cũ fail sau commit;
- failure CAS không làm mất generation hiện tại;
- active WebSocket đã authenticated không bị force-close trong #32 vì chưa có authoritative device-session registry; #33 sẽ dùng registry để chốt immediate/bounded propagation.

## Test coverage

Đã thêm coverage cho:

- issue credential đúng device + owner từ `DeviceRepository`;
- raw secret không nằm trong persisted credential snapshot;
- valid, wrong, unknown, mismatched device/secret;
- revoke và rotate;
- concurrent rotate/revoke và rotate/rotate;
- global credential-id reuse rejection;
- production gateway yêu cầu auth mặc định;
- invalid credential không expose ready session và không echo secret;
- MCP trước auth bị reject;
- local transport gửi auth trong `bridge.hello`, không trong URL;
- local giữ `AUTH_FAILED` generic từ gateway;
- authenticated gateway + local runtime + MCP Client chạy flow thật;
- revoked credential không tạo ready authenticated session;
- pairing completion giữ đúng correlation/device và duplicate claim không issue credential thứ hai;
- M2 acceptance dùng explicit legacy/test mode.

## Verification cuối

CI #176 trên implementation head `33263127`:

- `bun run check`: pass;
- `bun run typecheck`: pass;
- `bun test`: **198 pass / 0 fail**, 822 expects, 26 files;
- M2 acceptance: **6/6 pass**;
- M3 authenticated acceptance: **2/2 pass**;
- Windows `shell.exec` regression: pass.

Script `bun run test:m2` trỏ trực tiếp tới `apps/server/src/m2-acceptance.test.ts`; cùng file này đã chạy 6/6 trong full test của CI #176.

Docs-only commits sau verification phải tiếp tục giữ CI xanh trước khi PR chuyển ready.

## Out of scope

- heartbeat/online state và active-session registry (#33);
- reconnect/backoff loop (#34);
- multi-device routing (#35);
- public MCP endpoint/user OAuth (M4);
- OS keychain packaging.
