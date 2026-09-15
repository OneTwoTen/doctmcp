# Issue #32 — Device credential lifecycle + authenticated bridge handshake

## Mục tiêu

Hoàn tất M3.3 trên foundation #30/#31: sau khi pairing đã tạo/bind `Device`, server cấp long-lived credential riêng cho đúng `deviceId`; local dùng credential đó để authenticate WebSocket bridge mà không pair lại.

## Trạng thái

**Đang triển khai trên branch `codex/m3-3-device-credential-auth`.**

## Scope triển khai

- [ ] Shared credential/domain contract: credential id/version/state, issue result và auth identity.
- [ ] Credential store/service tách khỏi `Device` record.
- [ ] CSPRNG raw credential; server chỉ persist digest/hash, không persist raw secret.
- [ ] `issue`, `verify`, `revoke`, `rotate` với behavior deterministic.
- [ ] Pairing completion helper cấp credential đúng device đã claim.
- [ ] Authenticated bridge hello gửi `deviceId` + credential trong frame, không dùng URL/query string.
- [ ] Gateway verify credential trước khi session chuyển `ready`/được expose qua `onSession`.
- [ ] Session authenticated resolve được `{ ownerId, deviceId }` tách khỏi bridge `sessionId`.
- [ ] Pre-auth MCP frame bị reject; invalid/unknown/revoked/mismatched credential bị reject generic, không echo secret.
- [ ] Active session policy khi revoke/rotate: M3.3 chỉ đảm bảo reconnect mới bị reject; đóng active session tức thì sẽ được wire nếu gateway có registry hook đủ an toàn, nếu không sẽ document bounded scope cho #33.
- [ ] M2 legacy/test handshake vẫn explicit và chỉ bật qua option test/compatibility, không là default production auth bypass.
- [ ] Security/integration tests và docs.

## Quyết định kỹ thuật ban đầu

### Credential

- raw secret: opaque random bytes encode base64url;
- entropy mục tiêu: tối thiểu 256 bit;
- credential id: opaque UUID v4 riêng để rotate/audit mà không log secret;
- digest lookup/verify: SHA-256 với domain prefix, so sánh byte constant-time khi có manual compare;
- default không expiry ở M3.3; lifecycle dựa vào explicit revoke/rotate. Expiry có thể thêm sau mà không đổi identity model;
- mỗi device có tối đa một credential active trong in-memory reference adapter; rotate atomically thay active credential.

### Authenticated bridge

Control-plane mở rộng `bridge.hello` bằng auth mode rõ ràng:

```text
bridge.hello
  sessionId
  auth:
    mode: device
    deviceId
    credential
```

Gateway có `authenticateDevice(deviceId, credential)` callback/service. Chỉ khi callback trả server-side identity `{ ownerId, deviceId }` thì mới:

```text
handshaking -> ready
create session
onSession(session)
allow mcp.message
```

M2 compatibility không được là fallback tự động khi auth fail. Legacy hello chỉ được chấp nhận khi gateway được tạo với explicit compatibility/test option.

### Revoke / rotate

- revoke: credential active chuyển revoked; verify/reconnect sau đó fail;
- rotate: tạo secret/id mới và atomically thay credential active; credential cũ fail ngay sau commit;
- lỗi trước commit không làm mất credential cũ;
- raw secret mới chỉ trả về cho caller khi rotate thành công.

## Test bắt buộc

- issue credential đúng device + owner identity lấy từ `DeviceRepository`;
- raw secret không nằm trong persisted snapshot/log/error;
- valid credential verify pass;
- wrong secret, unknown device, token của device A dùng cho B fail generic;
- revoke làm verify/reconnect fail;
- rotate: new pass, old fail;
- concurrent rotate/revoke deterministic;
- invalid credential không tạo ready gateway session;
- MCP trước auth bị reject;
- authenticated bridge chạy MCP initialize/tools flow thật;
- M2 acceptance giữ nguyên semantics trong explicit legacy/test mode;
- `bun run check`, `bun run typecheck`, `bun test`, `bun run test:m2` xanh.

## Out of scope

- heartbeat/online state (#33);
- reconnect/backoff loop (#34);
- multi-device routing (#35);
- public MCP endpoint/user OAuth (M4);
- OS keychain packaging.
