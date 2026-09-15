# Thiết kế M2.1 — Bridge protocol và transport contract

## Trạng thái

**Hoàn tất M2.1.** Đây là contract cho các task #20–#23. WebSocket gateway và hai transport chưa được triển khai ở tài liệu này.

## Mục tiêu

Cho phép local agent chủ động mở một WebSocket tới public server, thực hiện handshake control-plane tối thiểu, sau đó chuyển MCP message hai chiều qua cùng session.

## Phạm vi

- Khóa hướng local-agent → public-server.
- Phân biệt control-plane message với MCP message.
- Validate message ở boundary bằng schema dùng chung.
- Định nghĩa lỗi handshake, version, message và lifecycle cơ bản.
- Khóa kích thước message, hàng đợi và backpressure.
- Khóa transport surface tương thích MCP TypeScript SDK v2.

Không bao gồm authentication, pairing, `deviceId`, persistence, routing nhiều thiết bị hoặc public MCP endpoint.

## Contract

`packages/protocol` là API contract mà bridge sử dụng; runtime validation nằm trong `packages/schemas`.

### Handshake

Local phải gửi trước:

```json
{
  "kind": "bridge.hello",
  "bridgeProtocolVersion": "1",
  "role": "local-agent",
  "sessionId": "session-1"
}
```

Public server trả:

```json
{
  "kind": "bridge.hello.ack",
  "bridgeProtocolVersion": "1",
  "role": "public-server",
  "sessionId": "session-1"
}
```

Trong M2, `sessionId` là metadata phiên test/runtime; nó chưa phải immutable `deviceId` hay credential. Hai phía phải reject version không hỗ trợ bằng `UNSUPPORTED_VERSION`.

### MCP data plane

Sau handshake, MCP JSON-RPC message được truyền trong:

```json
{
  "kind": "mcp.message",
  "payload": { "jsonrpc": "2.0", "id": 1, "method": "tools/list" }
}
```

`payload` được giữ opaque ở bridge. MCP SDK vẫn sở hữu `initialize`, `tools/list`, `tools/call`, result, error, id và cancellation; bridge không tạo `command.request`, `command.result` hoặc contract tool tương đương.

### Kích thước và backpressure

- `BRIDGE_MAX_MESSAGE_BYTES = 1,048,576` bytes (1 MiB).
- Kích thước tính trên chuỗi wire UTF-8 của toàn bộ envelope trước khi gửi và trước khi parse; không tính số ký tự JavaScript hoặc object sau parse.
- Frame vượt giới hạn bị reject, gửi `bridge.error` với code `MESSAGE_TOO_LARGE`, sau đó đóng session bằng `PROTOCOL_ERROR`. Không truncate hoặc retry tự động.
- Mỗi transport giữ FIFO queue tối đa `256` message và `4,194,304` bytes đang chờ gửi. `send()` reject với `BACKPRESSURE` khi một trong hai giới hạn queue bị vượt.
- Không drop hoặc reorder message. Caller chịu trách nhiệm retry/backoff; transport không buffer MCP message trước trạng thái `ready`.

### Lỗi và đóng phiên

Bridge dùng `bridge.error` cho lỗi control-plane với các code: `INVALID_MESSAGE`, `MESSAGE_TOO_LARGE`, `UNSUPPORTED_VERSION`, `HANDSHAKE_REQUIRED`, `UNEXPECTED_MESSAGE`, `SESSION_CLOSED`, `TIMEOUT`, `BACKPRESSURE`.

Đóng có chủ đích dùng `bridge.close` với `NORMAL`, `PROTOCOL_ERROR`, `TIMEOUT` hoặc `SERVER_SHUTDOWN`. WebSocket close/error native vẫn phải được transport ánh xạ thành lỗi lifecycle cho MCP SDK và reject các request đang chờ.

## Transport interface và lifecycle

`BridgeClientTransport` và `BridgeServerTransport` implement `BridgeTransportContract` trong `@doctmcp/protocol`, tương thích MCP SDK v2 (`start/send/close` và callbacks `onmessage/onerror/onclose`). Contract cũng expose `state`, các limit message/queue và hướng bridge.

Lifecycle rules:

- `start()` chỉ hợp lệ ở `idle`, cài listener trước khi kết nối, chuyển `connecting → handshaking → ready`; gọi lại hoặc gọi sau `closed` thì reject.
- Local `BridgeClientTransport` tạo outbound WebSocket; server `BridgeServerTransport` nhận socket đã được gateway accept.
- `send()` ở `idle/connecting/handshaking` reject `HANDSHAKE_REQUIRED` và không buffer; ở `ready` giữ FIFO; ở `closing/closed/failed` reject `SESSION_CLOSED`.
- `close()` idempotent, chuyển qua `closing`, dừng nhận/gửi, reject send pending, đóng socket và gọi `onclose` đúng một lần.
- Native WebSocket `error` gọi `onerror`; `close` gọi `onclose` và reject request pending qua MCP transport failure. `onerror` không thay thế `onclose`.
- Transport dùng shared channel nên `hasPerRequestStream` để `undefined`; cancellation do MCP SDK xử lý qua message cancellation.

## State/failure matrix

| State/event | Behavior | MCP/bridge result |
|---|---|---|
| `idle → start` | Mở/kết nối socket và gửi hello | `connecting → handshaking` |
| Nhận `hello.ack` đúng version/session | Cho phép MCP frame | `ready` |
| Hello sai version | Không forward MCP | `UNSUPPORTED_VERSION`, `PROTOCOL_ERROR`, close |
| MCP frame trước ready | Không forward | `HANDSHAKE_REQUIRED`, reject/close protocol |
| JSON/schema malformed | Không forward | `INVALID_MESSAGE`, `PROTOCOL_ERROR`, close |
| Frame vượt 1 MiB | Không parse/forward | `MESSAGE_TOO_LARGE`, `PROTOCOL_ERROR`, close |
| Queue đầy | Không drop frame | `BACKPRESSURE`, reject `send()` |
| Native socket error | Báo lỗi, cleanup | `onerror`, sau đó close/pending reject |
| Native socket close/timeout | Cleanup và giải phóng session | `onclose`, pending reject |
| `close()` chủ động | Đóng sạch, idempotent | `bridge.close` nếu còn gửi được, `onclose` |

## Sequence chính

```text
Local BridgeClient       Public gateway/Server       Local MCP Server
       |                         |                         |
       |--- WebSocket connect --->|                         |
       |--- bridge.hello -------->|                         |
       |<-- bridge.hello.ack -----|                         |
       |<========= mcp.message (initialize) ===============>|
       |<========= mcp.message (initialize result) =========|
       |<========= mcp.message (tools/list) ===============>|
       |<========= mcp.message (tools/list result) =========|
       |<========= mcp.message (tools/call system/info) ===>|
       |<========= mcp.message (structured result) =========|
```

Disconnect: socket close/error → stop queue → reject pending sends/requests → gọi `onerror` (nếu có) và `onclose` đúng một lần → MCP client/server nhận transport failure.

## Test plan cho #20–#23

- Schema: valid/invalid envelope, wrong role/version, unknown kind, oversized serialized UTF-8 frame.
- Lifecycle: start once, hello ordering, ready transition, send-before-ready/after-close, close idempotency, callback gọi đúng một lần.
- Flow: MCP `initialize → tools/list → tools/call system/info → result` qua socket thật.
- Failure: malformed frame, unsupported version, native error/close, timeout, pending request rejection.
- Queue: FIFO, giới hạn 256 message/4 MiB, reject khi đầy, không drop/reorder.
- Boundary: test server và local import contract từ `@doctmcp/protocol`, không import implementation của nhau.

## Invariants cho transport

- Chỉ local được khởi tạo outbound connection trong flow M2.
- Không forward MCP message trước khi handshake hoàn tất.
- Không tự tạo hoặc đổi MCP request id.
- Giữ thứ tự message của một WebSocket session.
- Một message malformed không được làm process crash; transport gửi `INVALID_MESSAGE` rồi đóng `PROTOCOL_ERROR`.
- Disconnect phải cleanup listener, reject request pending và giải phóng session.
- Timeout là timeout của bridge/session hoặc request pending; không che timeout riêng của local tool.

## Acceptance criteria cho M2.1

- Có type/schema dùng chung cho handshake, MCP frame, error và close.
- Có constant/type dùng chung cho max message size, queue và backpressure.
- Có interface contract tương thích MCP SDK v2 cho `BridgeClientTransport`/`BridgeServerTransport`.
- Có state machine, sequence flow, failure matrix và test plan deterministic.
- Schema phân biệt đúng role và reject unknown/malformed message.
- MCP payload không bị biến thành RPC riêng.
- Có test cho valid path, invalid path và cấm `command.request`.
- Các task sau có thể import contract từ `@doctmcp/protocol` mà không import implementation của `apps/agent` hoặc `apps/server`.

## History

| Ngày | Thay đổi | Lý do | Trạng thái |
|---|---|---|---|
| 2026-09-15 | Khóa contract bridge M2.1 và schema validation dùng chung | Làm nền cho gateway và hai transport, giữ MCP là data plane duy nhất | complete |
| 2026-09-15 | Bổ sung size/backpressure, transport surface, state/failure matrix và test plan theo review PR #24 | Đảm bảo #20–#23 có contract deterministic trước khi implement | complete |
