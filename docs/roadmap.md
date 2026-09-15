# Roadmap doctmcp

Roadmap này mô tả thứ tự triển khai đã chốt. Mục tiêu là giảm rủi ro bằng cách hoàn thiện và kiểm thử từng lớp độc lập trước khi ghép ChatGPT vào toàn hệ thống.

## M1 — Local MCP

**M1 hoàn tất 8/8 work item.** Local runtime đã có đủ catalog 6 tool và acceptance suite MCP thật để khóa contract, permission/security boundary và vertical flow offline. M2 là milestone phát triển tiếp theo.

Các work item M1:

- ✅ M1.1 / #2 — Local MCP server, tool registry và protocol scaffold cleanup qua PR #10.
- ✅ M1.2 / #3 — Workspace registry, path resolver và permission core qua PR #11.
- ✅ M1.3 / #4 — Tool `system` (`info`, `which`) qua PR #12.
- ✅ M1.4 / #5 — Tool `filesystem.read` (`read`, `list`, `stat`, `search`) qua PR #13.
- ✅ M1.5 / #6 — Tool `filesystem.write` (`write`, `patch`, `mkdir`, `move`) qua PR #14.
- ✅ M1.6 / #7 — Tool destructive `filesystem.delete` qua PR #15.
- ✅ M1.7 / #8 — Tool `shell.exec` với direct spawn, timeout, output limit, execute permission, process-tree hardening và Windows regression coverage qua PR #16.
- ✅ M1.8 / #9 — MCP contract/acceptance suite toàn M1 qua PR #17.

Catalog M1 chốt 6 tool theo capability/risk boundary:

```text
workspace
  ├─ list
  └─ get

system
  ├─ info
  └─ which

filesystem.read
  ├─ read
  ├─ list
  ├─ stat
  └─ search

filesystem.write
  ├─ write
  ├─ patch
  ├─ mkdir
  └─ move

filesystem.delete

shell.exec
```

Phạm vi nền:

- MCP server + tool registry;
- schema/action validation;
- workspace registry + path resolver;
- permission layer local;
- structured tool result/error;
- timeout/output limit cho shell;
- temp-workspace integration test;
- MCP `tools/list` + `tools/call` acceptance test;
- loại bỏ `command.request` / `command.result` khỏi vai trò tool-execution protocol trong scaffold.

Không thuộc M1:

- `device` tool;
- custom `job` manager;
- process manager;
- Git/Docker/database tools;
- WebSocket bridge;
- pairing/database/public server/ChatGPT.

Tài liệu chi tiết: [`specs/2026-09-14-m1-local-mcp-design.md`](specs/2026-09-14-m1-local-mcp-design.md), [`tools/`](tools/README.md), [`testing/m1-local-mcp.md`](testing/m1-local-mcp.md).

Acceptance criteria đã được khóa bằng test:

- test client initialize được local MCP server;
- `tools/list` trả đúng 6 tool/schema/annotations;
- mỗi tool có success call qua MCP protocol thật;
- invalid input trả lỗi có cấu trúc mà server không crash;
- path traversal + symlink escape bị chặn;
- denied path/capability bị chặn tại local;
- delete không thể xoá workspace root;
- shell có timeout/output limit và không dùng implicit raw shell string;
- process-tree/cross-platform regression từ #8 tiếp tục xanh;
- test không cần public server, Internet hoặc ChatGPT;
- `bun run check`, `bun run typecheck`, `bun test` xanh.

## M2 — Public server gọi local MCP

**Đang triển khai — M2.4/#22 hoàn tất trong PR #27; task tiếp theo là M2.5/#23.** Mục tiêu: chứng minh public server có thể dùng MCP client gọi một local runtime qua kết nối WebSocket do local chủ động tạo.

M2.1/#19 đã khóa bridge protocol/transport contract. M2.2/#20 có gateway WebSocket tối thiểu; M2.3/#21 có `BridgeServerTransport` phía local; M2.4/#22 có `BridgeClientTransport` phía public bind vào active gateway session. Vertical test hiện đã chạy MCP Client thật xuyên gateway/WebSocket tới production Local MCP Runtime với `initialize → tools/list → tools/call system/info`. M2.5/#23 sẽ khóa toàn bộ milestone bằng acceptance/integration suite và các failure boundary cuối.

Các work item M2:

- ✅ M2.1 / #19 — Thiết kế Bridge protocol và transport contract.
- ✅ M2.2 / #20 — WebSocket gateway tối thiểu trên public server qua PR #25.
- ✅ M2.3 / #21 — `BridgeServerTransport` phía local agent qua PR #26.
- ✅ M2.4 / #22 — `BridgeClientTransport` phía public server qua PR #27.
- 🚧 M2.5 / #23 — Acceptance/integration suite server ↔ local.

Phạm vi:

- WebSocket gateway tối thiểu;
- `BridgeClientTransport` phía public server;
- `BridgeServerTransport` phía local;
- MCP initialize qua transport này;
- `tools/list` từ server xuống local;
- `tools/call` từ server xuống local;
- disconnect/timeout/error cơ bản;
- integration test server ↔ local.

Đã triển khai tới M2.4:

- local chủ động mở WebSocket và hoàn tất bridge handshake;
- gateway quản lý active bridge session và lifecycle/cleanup;
- local `BridgeServerTransport` tương thích MCP server role;
- public `BridgeClientTransport` tương thích MCP client role và bind độc quyền ready session;
- wire-size 1 MiB, FIFO queue 256 message / 4 MiB và backpressure deterministic;
- remote disconnect làm MCP request pending fail thay vì treo;
- bridge session identity được tách khỏi MCP SDK `Transport.sessionId` để không làm `Client.connect()` bỏ qua initialize;
- production local runtime được gọi qua MCP Client thật trên WebSocket thật.

Acceptance criteria:

```text
server MCP client
    -> tools/list
    -> tools/call system/info
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

`device.list/get/ping` nếu cần expose cho model/client thuộc public/control-plane surface ở milestone sau, không phải local M1 tool catalog.

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

- Git tools nâng cao (`git.read`, `git.write`);
- process management;
- Docker tools;
- database tools;
- shell mode/PTY/streaming;
- long-running execution; ưu tiên đánh giá MCP Tasks trước khi tự tạo `job` protocol;
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
- Tool catalog tối ưu semantic/permission boundary, không tối ưu số lượng tool một cách máy móc.
- Ưu tiên vertical proof nhỏ nhưng chạy thật hơn scaffold lớn chưa có behavior.
- Khi thay đổi thứ tự hoặc ranh giới milestone, cập nhật decision/spec tương ứng nếu đó là thay đổi kiến trúc dài hạn.
