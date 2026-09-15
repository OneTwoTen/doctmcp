# Kiến trúc doctmcp

## Trạng thái foundation hiện tại

Repository hiện đã có:

- Bun 1.4.2 + TypeScript 7 strict.
- Bun workspaces cho `apps/*` và `packages/*`.
- Biome, TypeScript typecheck, Bun test và GitHub Actions CI.
- `apps/agent` đã có local MCP runtime và `BridgeServerTransport` của M2.3; `apps/server` đã có WebSocket gateway M2.2 và `BridgeClientTransport` M2.4 bind vào active ready session để MCP Client gọi local runtime.
- `packages/protocol` và `packages/schemas` ở mức foundation ban đầu.

MCP server local và custom WebSocket bridge M2 đã có implementation theo từng lớp; device pairing và public MCP endpoint vẫn **chưa được coi là đã triển khai** cho tới milestone tương ứng.

## Kiến trúc mục tiêu

```text
ChatGPT / MCP client
        │
        │ MCP
        ▼
┌──────────────────────────────┐
│        Public Server         │
│                              │
│ Public MCP endpoint          │
│ Authentication               │
│ Device router                │
│ MCP client per device/session│
└──────────────┬───────────────┘
               │
               │ custom WebSocket transport
               │ local chủ động kết nối ra ngoài
               ▼
┌──────────────────────────────┐
│       Local MCP Runtime      │
│                              │
│ MCP server                   │
│ Workspace/Permission engine  │
│ Tool registry                │
│ ├─ workspace                 │
│ ├─ system                    │
│ ├─ filesystem.read           │
│ ├─ filesystem.write          │
│ ├─ filesystem.delete         │
│ └─ shell.exec                │
└──────────────────────────────┘
```

Local luôn là phía chủ động mở kết nối ra public server. Kiến trúc không yêu cầu port forwarding, public IP hoặc expose HTTP/MCP endpoint của máy local ra Internet.

## Ranh giới trách nhiệm

### Local MCP runtime (`apps/agent`)

`apps/agent` hiện giữ tên từ scaffold, nhưng vai trò kiến trúc là **local MCP runtime**.

Thành phần này chịu trách nhiệm:

- chạy MCP server;
- đăng ký local tools;
- validate input của tool;
- quản lý workspace registry/path resolver;
- enforce permission tại local;
- thực thi filesystem/process/system capability;
- kết nối custom transport tới public server ở M2;
- lưu device credential ở các milestone sau.

Tool implementation không được phụ thuộc vào public server hoặc ChatGPT. Một tool phải có thể test local bằng MCP client test harness mà không cần network public.

### Public server (`apps/server`)

Ở M2, server chứng minh được:

- nhận kết nối WebSocket từ local runtime;
- bind kết nối đó vào `BridgeClientTransport` theo MCP client role;
- thực hiện MCP initialize;
- thực hiện `tools/list`;
- thực hiện `tools/call`;
- nhận MCP result/error đúng correlation của protocol MCP;
- propagate disconnect/session failure để request đang pending không treo.

`BridgeClientTransport` không mở WebSocket và không thực hiện bridge handshake. Nó chỉ bind vào một `BridgeGatewaySession` đã `ready`; Gateway sở hữu socket/session lifecycle. Bridge session identity được expose riêng (`bridgeSessionId`), không dùng MCP SDK `Transport.sessionId`, vì field MCP đó có semantics reconnect và có thể khiến `Client.connect()` bỏ qua initialize.

Device router, pairing/auth và public MCP endpoint được bổ sung sau khi luồng này ổn định.

### MCP data plane

MCP sở hữu semantics cho:

- initialization/capability negotiation;
- tool discovery;
- tool call;
- tool result;
- MCP error;
- cancellation và các lifecycle message tương ứng khi được dùng.

Dự án không tự tạo thêm `command.request`, `command.result` hoặc RPC tương đương chỉ để bọc lại `tools/call`.

### doctmcp control plane

`packages/protocol` chỉ dành cho dữ liệu nằm ngoài MCP, ví dụ:

- bridge/device handshake;
- device/session identity;
- authentication metadata;
- heartbeat/online state;
- reconnect metadata;
- pairing lifecycle;
- bridge protocol version nếu cần tương thích transport riêng.

Control plane không được trở thành protocol thực thi tool song song với MCP.

## M1 — Local MCP

M1 đã hoàn tất và là foundation cho bridge M2.

```text
MCP test client
      │
      │ initialize / tools/list / tools/call
      ▼
Local MCP server
      │
      ├─ Tool registry
      ├─ Schema validation
      ├─ Workspace/path resolver
      ├─ Permission engine
      └─ Tool handlers
```

Catalog M1 cố ý chỉ có 6 tool. Tool là capability/risk boundary; action chỉ nhóm thao tác cùng bản chất.

Chi tiết contract nằm tại [`specs/2026-09-14-m1-local-mcp-design.md`](specs/2026-09-14-m1-local-mcp-design.md) và [`tools/`](tools/README.md).

### Không thuộc local catalog M1

`device` là control/public concern ở milestone sau. `job`, `process`, `git.*`, `docker.*` chưa cần để chứng minh Local MCP. Long-running execution sau này ưu tiên đánh giá MCP Tasks thay vì tự tạo RPC/job protocol riêng.

## M2 — Server gọi local

```text
Public MCP Client
      │
      ▼
BridgeClientTransport
      │ bind ready session
      ▼
Public Gateway
      │ WebSocket
      ▼
BridgeServerTransport
      │
      ▼
Local MCP server
      │
      ▼
local tool
```

Custom WebSocket bridge chỉ chịu trách nhiệm chuyển MCP message qua kết nối đã có. Nó không định nghĩa lại `tools/list`, `tools/call` hoặc result format.

## Security boundary

- Workspace root là boundary đầu tiên cho filesystem/cwd.
- Path resolver phải chống traversal, symlink escape và sibling-prefix bug.
- Permission được enforce tại local, không tin public server tuyệt đối.
- `delete` là capability destructive riêng.
- `shell.exec` dùng direct spawn trong M1, có timeout/output limit và command policy.
- MCP tool annotations hỗ trợ mô tả risk nhưng không phải authorization.

## Nguyên tắc mở rộng

- Tách tool implementation khỏi transport.
- Tách MCP semantics khỏi device/session control plane.
- Không thêm database, queue, Redis hoặc service riêng trước khi M1/M2 chứng minh nhu cầu thật.
- Không khóa framework HTTP public server trước khi public endpoint production thực sự cần.
- Breaking change của custom bridge/control plane phải có version/compatibility strategy riêng; không trộn version này với MCP protocol version.
- Thêm tool mới dựa trên semantic/permission boundary, không dựa trên mục tiêu làm `tools/list` ngắn bằng mọi giá.

## Phần chưa chốt

Các quyết định sau chưa cần khóa trong M2:

- framework HTTP cuối cùng của public server;
- database cho user/device registry;
- cơ chế user authentication của public endpoint;
- persistence/audit log;
- installer/tray/auto-update cho local runtime;
- UX chọn nhiều thiết bị trong ChatGPT;
- shell mode/PTY/streaming;
- MCP Tasks integration cho long-running command.

Chỉ chốt khi milestone tương ứng cần tới để tránh over-design.
