# Roadmap doctmcp

Roadmap này mô tả thứ tự triển khai đã chốt. Mục tiêu là giảm rủi ro bằng cách hoàn thiện và kiểm thử từng lớp độc lập trước khi ghép ChatGPT vào toàn hệ thống.

## M1 — Local MCP

**M1 hoàn tất 8/8 work item.** Local runtime đã có đủ catalog 6 tool và acceptance suite MCP thật để khóa contract, permission/security boundary và vertical flow offline. M2 cũng đã hoàn tất; M3 là milestone phát triển tiếp theo.

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

**M2 hoàn tất 5/5 work item.** Public server đã dùng MCP Client chuẩn gọi production Local MCP Runtime qua WebSocket do local chủ động mở; acceptance suite #23 khóa cả success flow, MCP error semantics, disconnect/close và malformed/oversized boundary.

Các work item M2:

- ✅ M2.1 / #19 — Thiết kế Bridge protocol và transport contract qua PR #24.
- ✅ M2.2 / #20 — WebSocket gateway tối thiểu trên public server qua PR #25.
- ✅ M2.3 / #21 — `BridgeServerTransport` phía local agent qua PR #26.
- ✅ M2.4 / #22 — `BridgeClientTransport` phía public server qua PR #27.
- ✅ M2.5 / #23 — Acceptance/integration suite server ↔ local qua PR #28.

Implementation đã khóa:

- local chủ động mở WebSocket và hoàn tất bridge handshake;
- gateway quản lý active bridge session và lifecycle/cleanup;
- local `BridgeServerTransport` tương thích MCP server role;
- public `BridgeClientTransport` tương thích MCP client role và bind độc quyền ready session;
- MCP `initialize`, `tools/list`, `tools/call system/info` chạy xuyên bridge thật;
- `filesystem.write` + `filesystem.read` round-trip trên temp workspace thật;
- structured domain error và unknown tool giữ nguyên MCP semantics;
- local disconnect khi request pending làm public MCP request reject rõ ràng;
- public close propagate về local và cleanup idempotent;
- malformed JSON và frame UTF-8 vượt 1 MiB bị production gateway reject deterministic;
- wire-size 1 MiB, FIFO queue 256 message / 4 MiB và backpressure deterministic;
- bridge session identity được tách khỏi MCP SDK `Transport.sessionId` để fresh `Client.connect()` luôn initialize đúng.

Acceptance flow đã chứng minh:

```text
Public MCP Client
    -> BridgeClientTransport
    -> Public WebSocket Gateway
    -> BridgeServerTransport
    -> Local MCP Runtime
    -> tools/list
    -> tools/call system/info
    -> filesystem round-trip
    -> result quay về public client
```

Chạy riêng suite M2:

```sh
bun run test:m2
```

Chi tiết: [`testing/m2-server-local.md`](testing/m2-server-local.md).

Pairing, database, device identity/routing, public MCP endpoint và ChatGPT integration không thuộc M2.

## M3 — Device management và pairing

**M3 đang triển khai — 2/7 work item đã hoàn tất.** M3.1/#30 hoàn tất qua PR #37, M3.2/#31 hoàn tất qua PR #38; task active hiện tại là M3.3/#32. Mục tiêu: biến kết nối M2 thành kết nối thiết bị có identity, auth và lifecycle rõ ràng.

Các work item M3:

- ✅ M3.1 / #30 — Device identity/domain model + persistence contract qua PR #37.
- ✅ M3.2 / #31 — Pairing session/code lifecycle và atomic claim flow qua PR #38.
- ⏳ M3.3 / #32 — Device credential lifecycle + authenticated bridge handshake.
- ⬜ M3.4 / #33 — Device session registry, heartbeat và online/offline state.
- ⬜ M3.5 / #34 — Local reconnect/backoff + credential resume.
- ⬜ M3.6 / #35 — Multi-device registry + routing theo `deviceId`.
- ⬜ M3.7 / #36 — Acceptance/security suite pairing → reconnect → routing.

M3.1 đã khóa:

- immutable UUID v4 `deviceId`, canonical lowercase;
- opaque immutable `ownerId`;
- mutable device name/metadata;
- `DeviceRepository` không leak database-specific type;
- deterministic `InMemoryDeviceRepository` cho test;
- owner-scoped lookup/list/update/check;
- defensive snapshot và atomic/monotonic update;
- raw credential, live session và authoritative online state không nằm trong `Device` record.

M3.2 đã khóa:

- opaque UUID v4 `pairingSessionId`, tách khỏi `deviceId` và bridge session id;
- pairing code human-readable 12 symbol / 60-bit entropy, CSPRNG, TTL mặc định 5 phút;
- canonical normalization + SHA-256 digest lookup, không persist raw code;
- state one-time `pending → claimed|expired|cancelled`;
- atomic claim bao trọn expiry validation + `DeviceRepository.create()` + mark claimed;
- authoritative claim time được đọc trong repository atomic boundary;
- malformed/non-string/unknown/expired/reused/cancelled code cùng map `PAIRING_CODE_UNAVAILABLE`;
- anti-bruteforce hook chỉ nhận digest/context, không nhận raw pairing code;
- final CI #144: 184/184 test, M2 acceptance 6/6 và Windows regression xanh.

Phạm vi còn lại của M3:

- device credential dài hạn riêng;
- revoke/rotate credential;
- authenticated bridge handshake bind đúng owner/device;
- heartbeat và online state;
- reconnect/backoff;
- nhiều thiết bị trên cùng user;
- device routing.

`device.list/get/ping` nếu cần expose cho model/client thuộc public/control-plane surface ở milestone sau, không phải local M1 tool catalog.

Security test phải bao gồm expired/reused pairing code và credential bị revoke. M2 regression phải tiếp tục xanh trong toàn M3.

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
