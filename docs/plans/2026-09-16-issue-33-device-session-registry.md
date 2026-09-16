# Issue #33 — Device session registry, heartbeat và online/offline state

## Mục tiêu

Hoàn tất M3.4 bằng một runtime registry đáng tin cậy cho authenticated device session, có generation boundary rõ ràng, heartbeat/liveness riêng với MCP traffic và shared invalidation abstraction cho revoke/rotate cross-instance.

## Quyết định chính

### Registry key và generation

- Registry key duy nhất là immutable `deviceId`; không dùng `deviceName`.
- Mỗi active entry giữ `{ ownerId, deviceId, credentialId, credentialVersion }` cùng runtime session handle.
- Runtime session handle chỉ tồn tại trong memory registry; không persist vào `DeviceRepository`.
- Status/public snapshot chỉ expose `deviceId`, `status`, `connectedAt`, `lastSeenAt`; không expose credential generation, raw credential hoặc WebSocket object.

### Duplicate connection

Policy M3.4 là **new authenticated session replaces old session**.

Replacement được commit đồng bộ vào registry trước khi đóng session cũ. Cleanup của session cũ phải match exact runtime registration/session reference nên không thể xoá session mới vừa replace.

Session cũ được đóng với native reason `SESSION_REPLACED` và có structured runtime log tương ứng.

### Heartbeat/liveness

Heartbeat dùng native WebSocket ping/pong control frame, tách khỏi MCP JSON-RPC và bridge MCP payload.

Default production runtime:

- ping interval: **1 giây**;
- liveness timeout: **4 giây**;
- credential invalidation propagation target: tối đa **5 giây**.

Pong chỉ được chấp nhận khi echo đúng nonce của ping thuộc chính connection. Unsolicited/malformed pong không cập nhật `lastSeenAt`.

**MCP traffic không cập nhật device `lastSeenAt`.** Existing bridge `idleTimeoutMs` của M2 vẫn là transport-idle policy riêng và có thể được reset bởi MCP traffic; nó không phải source of truth cho device online state.

Native disconnect chuyển registry entry offline ngay qua exact-session cleanup. Status cũng tự derive offline nếu `lastSeenAt` vượt heartbeat timeout, kể cả trước khi socket cleanup hoàn tất.

### Credential invalidation cross-instance

`DeviceCredentialInvalidationBus` là abstraction shared pub/sub. Event chỉ chứa metadata:

- `eventId`;
- `kind` (`revoked` / `rotated`);
- `deviceId`;
- invalidated `credentialId + credentialVersion`;
- `publishedAt`.

Event tuyệt đối không chứa raw credential.

Sau successful revoke/rotate/recovery rotation:

1. instance thực hiện mutation evict exact generation local;
2. publish invalidation event;
3. các instance subscriber chỉ evict session nếu exact generation còn match;
4. duplicate hoặc delayed event của generation cũ trở thành no-op với session generation mới.

`InMemoryDeviceCredentialInvalidationBus` chỉ là reference implementation cho test/single-process. Production multi-instance phải inject shared backend có delivery bound phù hợp target <= 5 giây.

### Degraded mode

Credential mutation là authoritative và không rollback chỉ vì pub/sub tạm lỗi.

Khi publish/delivery degraded, native heartbeat vẫn chạy. Mỗi authenticated pong được revalidate với authoritative credential repository bằng `credentialId + version`; session stale không được refresh `lastSeenAt` và bị evict/close. Với default interval 1 giây và timeout 4 giây, fallback vẫn giữ bounded cleanup trong target 5 giây khi shared credential store còn khả dụng.

Nếu cả invalidation backend và authoritative credential store đều unavailable, heartbeat không được coi là credential proof: `lastSeenAt` không được refresh sau lỗi revalidation và session sẽ timeout thay vì được giữ online vô hạn.

## Implementation tasks

- [x] Thêm `DeviceSessionRegistry` generation-aware, owner index, exact-session cleanup và derived status.
- [x] Thêm shared `DeviceCredentialInvalidationBus` abstraction + in-memory reference adapter.
- [ ] Tích hợp native ping/pong heartbeat vào public gateway.
- [ ] Truyền credential generation từ final ready validation sang runtime registry.
- [ ] Thay `trackedSessions Set` M3.3 bằng registry chính thức.
- [ ] Tích hợp local + cross-instance generation invalidation cho revoke/rotate/recovery rotation.
- [ ] Thêm heartbeat credential revalidation degraded fallback.
- [ ] Expose device status/active session registry cho routing/control-plane phía sau.
- [ ] Thêm deterministic integration tests duplicate replacement, heartbeat, disconnect, multi-instance revoke/rotate và delayed event.
- [ ] Chạy full verification + review diff/security/regression.

## Test strategy

Tối thiểu cover:

- register/lookup/list owner;
- duplicate replace và old cleanup race;
- heartbeat A không mutate B;
- stale heartbeat -> offline/close;
- native close -> offline ngay;
- repeated close/heartbeat-after-close idempotent;
- revoked/rejected handshake không xuất hiện online;
- two runtime instances dùng chung invalidation bus: mutation A đóng stale session B;
- delayed/duplicate old-generation event không đóng session generation mới;
- dropped/failed invalidation delivery vẫn bị heartbeat generation revalidation cleanup;
- M2 bridge acceptance vẫn xanh.

## Verification bắt buộc

```sh
bun run check
bun run typecheck
bun test
bun run test:m2
```

## History

| Ngày | Thay đổi | Lý do | Trạng thái |
|---|---|---|---|
| 2026-09-16 | Khởi tạo design/plan M3.4 | Khóa duplicate policy, heartbeat semantics và cross-instance generation invalidation trước implementation | in-progress |
