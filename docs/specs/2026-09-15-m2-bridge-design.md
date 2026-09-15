# Thiết kế M2.1 — Bridge protocol và transport contract

## Trạng thái

**Hoàn tất M2.1.** Đây là contract tối thiểu cho các task #20–#23. WebSocket gateway và hai transport chưa được triển khai ở tài liệu này.

## Mục tiêu

Cho phép local agent chủ động mở một WebSocket tới public server, thực hiện handshake control-plane tối thiểu, sau đó chuyển MCP message hai chiều qua cùng session.

## Phạm vi

- Khóa hướng local-agent → public-server.
- Phân biệt control-plane message với MCP message.
- Validate message ở boundary bằng schema dùng chung.
- Định nghĩa lỗi handshake, version, message và lifecycle cơ bản.

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

### Lỗi và đóng phiên

Bridge dùng `bridge.error` cho lỗi control-plane với các code: `INVALID_MESSAGE`, `UNSUPPORTED_VERSION`, `HANDSHAKE_REQUIRED`, `UNEXPECTED_MESSAGE`, `SESSION_CLOSED`, `TIMEOUT`.

Đóng có chủ đích dùng `bridge.close` với `NORMAL`, `PROTOCOL_ERROR`, `TIMEOUT` hoặc `SERVER_SHUTDOWN`. WebSocket close/error native vẫn phải được transport ánh xạ thành lỗi lifecycle cho MCP SDK và reject các request đang chờ.

## Invariants cho transport

- Chỉ local được khởi tạo outbound connection trong flow M2.
- Không forward MCP message trước khi handshake hoàn tất.
- Không tự tạo hoặc đổi MCP request id.
- Giữ thứ tự message của một WebSocket session.
- Một message malformed không được làm process crash; transport gửi lỗi phù hợp rồi đóng hoặc từ chối session theo state.
- Disconnect phải cleanup listener, reject request pending và giải phóng session.
- Timeout là timeout của bridge/session hoặc request pending; không che timeout riêng của local tool.

## Acceptance criteria cho M2.1

- Có type/schema dùng chung cho handshake, MCP frame, error và close.
- Schema phân biệt đúng role và reject unknown/malformed message.
- MCP payload không bị biến thành RPC riêng.
- Có test cho valid path, invalid path và cấm `command.request`.
- Các task sau có thể import contract từ `@doctmcp/protocol` mà không import implementation của `apps/agent` hoặc `apps/server`.

## History

| Ngày | Thay đổi | Lý do | Trạng thái |
|---|---|---|---|
| 2026-09-15 | Khóa contract bridge M2.1 và schema validation dùng chung | Làm nền cho gateway và hai transport, giữ MCP là data plane duy nhất | complete |
