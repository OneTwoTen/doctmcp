# Quyết định: hoàn thiện Local MCP trước khi tích hợp ChatGPT

## Bối cảnh

Mục tiêu cuối cùng của `doctmcp` là để ChatGPT gọi capability trên máy local thông qua public server.

Nếu triển khai ChatGPT integration, pairing, public MCP endpoint và local tool cùng lúc, việc debug sẽ khó vì một lỗi có thể nằm ở nhiều lớp: ChatGPT, public endpoint, authentication, routing, transport, MCP runtime hoặc local tool.

Phần local MCP và server → local là hai lớp dễ kiểm thử độc lập nhất, ít phụ thuộc hạ tầng nhất và cung cấp bằng chứng kỹ thuật rõ ràng trước khi xây UX bên trên.

## Quyết định

Thứ tự triển khai được chốt:

1. Hoàn thiện local runtime thành MCP server thật.
2. Test trực tiếp `tools/list` và `tools/call` ở local.
3. Public server đóng vai MCP client và gọi local MCP qua custom WebSocket transport.
4. Sau khi server → local chạy ổn mới thêm device identity, pairing, authentication và routing.
5. Public MCP endpoint và ChatGPT integration được triển khai sau các lớp trên.

Ngoài ra, MCP sẽ là protocol thực thi tool. Dự án không duy trì `command.request/command.result` hoặc RPC tool-call riêng song song với MCP.

`packages/protocol` chỉ giữ control-plane contract nằm ngoài MCP, ví dụ handshake, device/session metadata, heartbeat, pairing và authentication metadata.

## Lý do

- M1 có thể test hoàn toàn local.
- M2 có acceptance test rõ: server gọi được `tools/list` và `tools/call` từ local.
- Tách lỗi transport khỏi lỗi ChatGPT/auth/pairing.
- Tránh tạo hai protocol thực hiện cùng một chức năng.
- Giảm số quyết định phải khóa sớm như database, HTTP framework, auth provider hoặc UX nhiều thiết bị.
- Local tool và permission có thể trưởng thành trước khi expose từ xa.

## Hệ quả

### Tích cực

- Test nhanh và deterministic hơn.
- Kiến trúc tool không phụ thuộc ChatGPT.
- Public server có thể thay client bên trên mà local MCP không đổi.
- Dễ dùng MCP Inspector/test harness hoặc MCP client nội bộ để kiểm chứng từng lớp.

### Trade-off

- `apps/agent` vẫn mang tên cũ dù vai trò mới rõ hơn là local MCP runtime.
- Custom WebSocket transport cần được viết/test đúng abstraction của SDK.
- Pairing và user/device persistence bị hoãn, nên M2 có thể phải dùng test identity/session đơn giản.

Các trade-off trên được chấp nhận vì giảm đáng kể độ phức tạp của giai đoạn đầu.

## Điều không quyết định trong tài liệu này

Decision này không khóa:

- framework HTTP của public server;
- database;
- auth provider;
- cách lưu credential production trên từng OS;
- public MCP transport cuối cùng;
- UX ChatGPT nhiều thiết bị.

Các quyết định đó được chốt ở milestone tương ứng.

## History

| Ngày | Thay đổi | Lý do | Trạng thái |
|---|---|---|---|
| 2026-09-14 | Chốt hướng Local MCP → server gọi local → device management → public MCP → ChatGPT | Giảm dependency và làm từng lớp dễ test độc lập | approved |
