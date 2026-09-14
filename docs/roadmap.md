# Roadmap doctmcp

Roadmap này mô tả thứ tự triển khai đã chốt. Mục tiêu là giảm rủi ro bằng cách hoàn thiện và kiểm thử từng lớp độc lập trước khi ghép ChatGPT vào toàn hệ thống.

## M1 — Local MCP

Mục tiêu: local runtime hoạt động như một MCP server hoàn chỉnh ở mức tối thiểu.

Phạm vi đầu tiên:

- khởi tạo MCP server;
- tool registry;
- `system.info`;
- `filesystem.list`;
- `filesystem.read`;
- `filesystem.write`;
- `shell.exec` ở mức an toàn đủ cho development;
- permission layer cơ bản;
- test `tools/list`;
- test `tools/call` cho từng nhóm tool quan trọng.

Acceptance criteria:

- test client kết nối được local MCP server;
- `tools/list` trả đúng tool/schema;
- `tools/call` thực thi được tool và trả structured result;
- invalid input trả lỗi có cấu trúc;
- filesystem denied path bị chặn tại local;
- shell có timeout và output limit tối thiểu trước khi bật rộng;
- test không cần public server hoặc ChatGPT.

## M2 — Public server gọi local MCP

Mục tiêu: chứng minh public server có thể dùng MCP client gọi một local runtime qua kết nối WebSocket do local chủ động tạo.

Phạm vi:

- WebSocket gateway tối thiểu;
- `BridgeClientTransport` phía public server;
- `BridgeServerTransport` phía local;
- MCP initialize qua transport này;
- `tools/list` từ server xuống local;
- `tools/call` từ server xuống local;
- disconnect/timeout/error cơ bản;
- integration test server ↔ local.

Acceptance criteria:

```text
server MCP client
    -> tools/list
    -> tools/call system.info
    -> nhận result từ local
```

Không cần pairing, database hoặc ChatGPT để hoàn tất M2.

## M3 — Device management và pairing

Mục tiêu: biến kết nối M2 thành kết nối thiết bị có identity, auth và lifecycle rõ ràng.

Phạm vi dự kiến:

- immutable `deviceId`;
- device name/metadata;
- pairing session + pairing code ngắn hạn;
- device credential dài hạn riêng;
- revoke/rotate credential;
- heartbeat và online state;
- reconnect/backoff;
- nhiều thiết bị trên cùng user;
- device routing.

Security test phải bao gồm expired/reused pairing code và credential bị revoke.

## M4 — Public MCP endpoint

Mục tiêu: public server expose MCP endpoint chuẩn cho MCP client bên ngoài.

Phạm vi dự kiến:

- MCP server/public endpoint;
- authentication/authorization của user;
- chọn device hoặc route device;
- ánh xạ public tool call sang MCP client session của local device;
- xử lý offline/timeout/error rõ ràng;
- audit metadata tối thiểu.

Ở milestone này mới cần chốt framework HTTP/MCP endpoint nếu chưa có quyết định trước đó.

## M5 — ChatGPT integration

Mục tiêu: sử dụng public MCP endpoint trong ChatGPT với UX đủ tốt cho dùng cá nhân.

Phạm vi dự kiến:

- kết nối plugin/app tới public endpoint;
- flow thêm thiết bị;
- list/chọn thiết bị;
- thông báo device offline;
- tool descriptions tối ưu cho model;
- approval UX cho operation nhạy cảm nếu cần;
- kiểm thử end-to-end ChatGPT → server → local.

## Giai đoạn sau

Chỉ cân nhắc sau khi M1–M5 ổn định:

- Git tools nâng cao;
- process management;
- Docker tools;
- database tools;
- local tool plugin system;
- desktop tray;
- auto-update;
- installer Windows/macOS/Linux;
- audit/history nâng cao;
- policy profile theo project/workspace;
- nhiều public server hoặc self-host distribution.

## Nguyên tắc roadmap

- Không kéo dependency của milestone sau vào milestone trước nếu chưa cần.
- Mỗi milestone phải có acceptance test độc lập.
- Ưu tiên vertical proof nhỏ nhưng chạy thật hơn scaffold lớn chưa có behavior.
- Khi thay đổi thứ tự hoặc ranh giới milestone, cập nhật decision note tương ứng nếu đó là thay đổi kiến trúc dài hạn.
