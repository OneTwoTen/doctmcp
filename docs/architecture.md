# Kiến trúc doctmcp

## Trạng thái foundation hiện tại

Repository hiện đã có:

- Bun 1.4.2 + TypeScript 7 strict.
- Bun workspaces cho `apps/*` và `packages/*`.
- Biome, TypeScript typecheck, Bun test và GitHub Actions CI.
- `apps/server` và `apps/agent` ở mức scaffold.
- `packages/protocol` và `packages/schemas` ở mức foundation ban đầu.

MCP server local, custom WebSocket transport, device pairing và public MCP endpoint **chưa được coi là đã triển khai** cho tới khi có code + test tương ứng.

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
│ Permission engine            │
│ Tool registry                │
│ ├─ system.*                  │
│ ├─ filesystem.*              │
│ ├─ shell.*                   │
│ └─ git.*                     │
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
- enforce permission tại local;
- thực thi filesystem/process/system/git capability;
- kết nối custom transport tới public server ở M2;
- lưu device credential ở các milestone sau.

Tool implementation không được phụ thuộc vào public server hoặc ChatGPT. Một tool phải có thể test local bằng MCP client test harness mà không cần network public.

### Public server (`apps/server`)

Ở M2, server trước hết chỉ cần chứng minh được:

- nhận kết nối WebSocket từ local runtime;
- bind kết nối đó vào một custom MCP client transport;
- thực hiện `tools/list`;
- thực hiện `tools/call`;
- nhận MCP result/error đúng correlation của protocol MCP.

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

## Luồng M1 — Local MCP

```text
MCP test client
      │
      │ MCP transport dùng trong test/local
      ▼
Local MCP server
      │
      ├─ tools/list
      └─ tools/call
             │
             ▼
        local tool
```

Acceptance tối thiểu của M1 là test được discovery và call tool thật mà không phụ thuộc public server.

## Luồng M2 — Server gọi local

```text
Public server
  MCP client
      │
      │ BridgeClientTransport
      ▼
WebSocket session
      │
      ▼
BridgeServerTransport
      │
      ▼
Local MCP server
      │
      ▼
local tool
```

Custom WebSocket transport chỉ chịu trách nhiệm chuyển MCP message qua kết nối đã có. Nó không định nghĩa lại `tools/list`, `tools/call` hoặc result format.

## Nguyên tắc mở rộng

- Tách tool implementation khỏi transport.
- Tách MCP semantics khỏi device/session control plane.
- Không thêm database, queue, Redis hoặc service riêng trước khi M1/M2 chứng minh nhu cầu thật.
- Không khóa framework HTTP public server ở M1 khi chưa cần HTTP endpoint production.
- Security boundary quan trọng phải được enforce tại local ngay cả khi public server đã validate.
- Breaking change của custom bridge/control plane phải có version/compatibility strategy riêng; không trộn version này với MCP protocol version.

## Phần chưa chốt

Các quyết định sau chưa cần khóa ở M1:

- framework HTTP cuối cùng của public server;
- database cho user/device registry;
- cơ chế user authentication của public endpoint;
- persistence/audit log;
- installer/tray/auto-update cho local runtime;
- UX chọn nhiều thiết bị trong ChatGPT.

Chỉ chốt khi milestone tương ứng cần tới để tránh over-design.
