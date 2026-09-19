# M3.6 — Registry nhiều thiết bị và định tuyến theo `deviceId`

## Mục tiêu

Cho public server liệt kê thiết bị thuộc một owner và resolve đúng authenticated bridge session theo cặp `{ ownerId, deviceId }`. Mỗi request phải chọn đích bằng immutable `deviceId`; service không được dựa vào tên hiển thị hoặc tự chuyển sang thiết bị khác.

## Phạm vi

M3.6 bổ sung `DeviceRoutingService` trong `apps/server`. Service kết hợp `DeviceRepository`, `DeviceSessionRegistry` và trạng thái credential authoritative để trả snapshot an toàn, owner-scoped và resolve một session đang hoạt động.

Service không mở public MCP endpoint, không thực hiện OAuth/login, không thêm persistence adapter và không thay đổi MCP hoặc bridge wire protocol. Public endpoint ở M4 sẽ dùng API routing này cùng `BridgeClientTransport`.

## API và dữ liệu

`DeviceRoutingService` cung cấp:

```ts
listDevices(ownerId): Promise<readonly RoutedDeviceSnapshot[]>;
getDevice(ownerId, deviceId): Promise<RoutedDeviceSnapshot>;
resolve(ownerId, deviceId): Promise<ResolvedDeviceSession>;
```

`RoutedDeviceSnapshot` chỉ chứa `deviceId`, `deviceName`, `metadata`, `createdAt`, `updatedAt`, `status`, `connectedAt` và `lastSeenAt`. Không trả `ownerId`, credential, credential generation, session handle hoặc socket trong DTO.

`ResolvedDeviceSession` chứa snapshot của thiết bị và `BridgeGatewaySession` abstraction đã xác thực. Đây là bridge session contract của server, không phải native WebSocket. M4 có thể bọc session bằng `BridgeClientTransport` mà không import Bun socket implementation.

## Owner scope và route resolution

1. `listDevices(ownerId)` chỉ đọc record qua `DeviceRepository.listByOwnerId(ownerId)`.
2. `getDevice(ownerId, deviceId)` dùng `getForOwner`; device không tồn tại và device thuộc owner khác cùng trả `DEVICE_NOT_FOUND` để tránh lộ sự tồn tại chéo owner.
3. `resolve(ownerId, deviceId)` xác minh record thuộc owner trước, sau đó yêu cầu credential active.
4. Service lấy session hiện hành theo `deviceId` và kiểm tra `ownerId` cùng credential `{ credentialId, version }` phải khớp chính xác với generation trong session registry.
5. Chỉ khi mọi kiểm tra thành công service mới trả session. Mỗi lần resolve đọc lại registry hiện tại; không cache session reference qua lần gọi.

Credential không active hoặc generation không khớp trả `DEVICE_CREDENTIAL_UNAVAILABLE`. Credential active nhưng không có authenticated live session trả `DEVICE_OFFLINE`. Không tồn tại hoặc sai owner trả `DEVICE_NOT_FOUND`. Lỗi repository ngoài các trường hợp domain trên được chuẩn hóa thành `ROUTING_UNAVAILABLE` và không đưa lỗi nội bộ ra caller.

Status trong list/get là `online` khi registry báo session live và generation đó còn khớp credential active hiện tại. Nếu không, status là `offline`; các timestamp liveness chỉ được lấy từ registry và có thể `null`.

## Race và lifecycle

- Resolve luôn dùng snapshot session mới nhất của `DeviceSessionRegistry`; replacement M3.4 làm lần resolve kế tiếp chọn session mới.
- Disconnect ngay sau resolve được `BridgeClientTransport` báo thành lỗi session đóng cho request đang chờ; request mới resolve sẽ trả `DEVICE_OFFLINE`.
- Không tự retry request đang chạy, không chọn device khác và không route theo `deviceName`.
- Credential generation stale bị từ chối ngay cả khi invalidation event cross-instance chưa tới; router không xem heartbeat hoặc MCP traffic là bằng chứng thay thế cho credential check.

## Bảo mật

- Tất cả truy vấn và resolve đều owner-scoped.
- Sai owner và id không tồn tại không phân biệt bằng error code.
- DTO và error không chứa pairing code, credential secret, digest, session id hoặc socket object.
- Revoke/rotate không được route stale session trong thời gian chờ invalidation propagation.
- Permission của local MCP runtime tiếp tục là nguồn quyết định cuối cùng cho tool call.

## Kiểm thử và tiêu chí chấp nhận

- Owner có nhiều device, kể cả trùng `deviceName`, vẫn list/get/resolve đúng theo `deviceId`.
- Owner khác không đọc hoặc resolve được device.
- Unknown, offline, revoked credential và generation stale có error semantics riêng, deterministic.
- Rename metadata không đổi route target.
- Session replacement được lần resolve mới sử dụng; reference stale không được giữ trong router.
- DTO không chứa owner/credential/session internals.
- M2 acceptance vẫn xanh; `bun run check`, `bun run typecheck`, `bun test` và `bun run test:m2` được chạy trước khi hoàn tất.

## History

| Ngày | Thay đổi | Lý do | Trạng thái |
|---|---|---|---|
| 2026-09-17 | Khởi tạo thiết kế M3.6 | Chốt owner scope, error semantics và route theo `deviceId` dựa trên issue #35 | in-progress |
| 2026-09-17 | Hoàn tất implementation và target verification trong nhánh `codex/m3-multidevice-routing` | Runtime composition, unit/integration tests, owner/error behavior và review secret boundary đã chạy xanh | complete |
