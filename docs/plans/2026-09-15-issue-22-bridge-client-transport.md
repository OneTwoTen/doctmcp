# Kế hoạch issue #22 — BridgeClientTransport phía public server

## Mục tiêu

Cho phép public server tạo MCP `Client` chuẩn, bind vào một bridge session đã `ready` do `BridgeGateway` quản lý và gọi Local MCP Runtime xuyên WebSocket mà không tạo thêm RPC tool protocol riêng.

## Ranh giới trách nhiệm

`BridgeClientTransport` được đặt tên theo **MCP role** (`client`), không theo WebSocket role. Transport này không mở WebSocket và không thực hiện `bridge.hello`; hai việc đó thuộc local `BridgeServerTransport` và Public Gateway.

```text
Public MCP Client
      │
      ▼
BridgeClientTransport
      │ bind active ready session
      ▼
BridgeGatewaySession
      │
      ▼
Public Gateway ⇄ WebSocket ⇄ BridgeServerTransport
                              │
                              ▼
                        Local MCP Runtime
```

## Phạm vi triển khai

- Bind độc quyền một transport instance vào một `BridgeGatewaySession` đang `ready`.
- Implement `start`, `send`, `close`, `onmessage`, `onerror`, `onclose` theo MCP SDK v2.
- Wrap outbound JSON-RPC trong `mcp.message`, validate schema và giới hạn wire-size 1 MiB.
- FIFO queue tối đa 256 message / 4 MiB; reject `BACKPRESSURE` khi vượt giới hạn.
- Revalidate message nhận từ gateway trước khi giao payload cho MCP Client.
- Propagate remote close/session failure để MCP SDK reject request đang pending.
- Cleanup callback/session binding idempotent và không reuse session đã đóng.
- Export transport từ `apps/server`.
- Dùng `@modelcontextprotocol/client` v2 trực tiếp ở public server.

## Test bắt buộc

- bind/start thành công với ready session;
- send trước start và sau close;
- duplicate session binding bị reject;
- FIFO + queue overflow;
- malformed inbound không vào MCP Client;
- remote disconnect làm MCP request pending reject;
- vertical integration dùng gateway thật + local `BridgeServerTransport` + `createLocalMcpRuntime()` + MCP `Client` thật;
- `initialize`, `tools/list`, `tools/call system/info` và invalid tool đi xuyên bridge.

## Không thuộc issue này

- pairing/auth/device identity;
- multi-device routing;
- public MCP endpoint cho external client;
- reconnect/backoff production-grade;
- M2 acceptance suite tổng hợp của #23.

## Definition of Done

- #22 acceptance chạy bằng MCP Client chuẩn và production bridge/local assembly path.
- Không có custom command RPC song song MCP.
- `bun run check`, `bun run typecheck`, `bun test` xanh trên CI.
- Sau merge, Epic #18 chuyển task active sang #23.
