# M3.7 — Acceptance dọc và regression bảo mật

## Mục tiêu

Khóa M3 bằng một flow production assembly từ pairing tới MCP call qua đúng authenticated device, đồng thời gom các regression bảo mật M3 thành lệnh `bun run test:m3` riêng.

## Phạm vi

Acceptance chính chạy trên `createDoctmcpServerRuntime`, hai local MCP runtime, `LocalBridgeReconnectController`, WebSocket thật, `DeviceRoutingService` và `BridgeClientTransport`. Hai thiết bị cùng owner được đặt cùng tên để chứng minh route theo `deviceId`; workspace riêng giúp xác nhận MCP response tới đúng local runtime.

Suite tổng hợp chạy thêm các test M3 hiện có cho pairing expiry/reuse/concurrent claim, authentication/credential lifecycle, heartbeat/session registry, reconnect, owner scope và secret redaction. Không sao chép các implementation test này vào suite mới.

## Luồng thành công

1. Local A và B tạo pairing session, owner claim từng code và nhận device/credential riêng.
2. Hai local runtime mở bridge bằng reconnect controller và trở thành authenticated/online.
3. Router resolve từng `{ ownerId, deviceId }`; duplicate `deviceName` không ảnh hưởng target.
4. MCP client kết nối qua `BridgeClientTransport` bọc session đã resolve; `initialize`, `tools/list`, `tools/call system/info` và `workspace/list` chạy qua WebSocket.
5. Kết quả workspace của A chỉ chứa workspace A; kết quả B chỉ chứa workspace B.
6. Ngắt session A theo transient timeout; controller reconnect bằng credential hiện tại, giữ nguyên `deviceId`, thay session id và route MCP thành công lần nữa.

## Bất biến bảo mật

- Pairing code expired, reused hoặc concurrent claim không tạo thêm device/credential ngoài một claim thắng.
- Sai owner/unknown device không tiết lộ sự tồn tại; offline báo lỗi tường minh.
- Authentication phải hoàn tất trước MCP traffic; credential của A không xác thực được cho B.
- Revoke/rotate, stale heartbeat, duplicate session và duplicate close giữ đúng policy đã khóa ở M3.3–M3.5.
- Routing không fallback theo tên; DTO/log/error/snapshot không chứa raw secret.
- Test chờ trên trạng thái có timeout hữu hạn và đóng clients, transports, runtimes, gateway, workspace/temp resource.

## Acceptance

- `bun run test:m3` chạy suite dọc và regression/security test M3.
- MCP routed call đi qua WebSocket production boundary tới đúng local runtime.
- M1/M2 cùng `bun run check`, `bun run typecheck` và `bun test` được chạy; lỗi môi trường được ghi nhận riêng, không che bằng cách bỏ test.
- README, roadmap, pairing/security, architecture, test strategy và history phản ánh đúng trạng thái đã kiểm chứng.

## Ngoài phạm vi

Public MCP endpoint, OAuth/login, ChatGPT integration, production device picker và installer/keychain packaging thuộc các milestone sau.

## History

| Ngày | Thay đổi | Lý do | Trạng thái |
|---|---|---|---|
| 2026-09-17 | Khởi tạo acceptance M3.7 theo issue #36 | Khóa vertical flow và gom regression bảo mật hiện có thành lệnh riêng | in-progress |
| 2026-09-17 | Hoàn tất suite `test:m3` và chạy full verification local | 123 test M3, M1/M2, check/typecheck xanh; ghi riêng 32 lỗi symlink `EPERM` của full suite trên Windows | in-progress |
