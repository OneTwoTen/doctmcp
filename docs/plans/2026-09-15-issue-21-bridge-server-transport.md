# Kế hoạch issue #21 — BridgeServerTransport phía local

## Mục tiêu

Cho phép Local MCP Runtime chủ động mở WebSocket tới Public Gateway, hoàn tất
bridge handshake và chuyển MCP JSON-RPC message hai chiều qua envelope
`mcp.message`.

## Phạm vi

- Thêm `BridgeServerTransport` tương thích `Transport` của MCP SDK v2.
- Dùng WebSocket client native của Bun; local là phía chủ động kết nối.
- Validate envelope, wire-size và session/version trước khi giao payload cho MCP.
- Giữ FIFO queue bounded theo contract #19; tính cả native `bufferedAmount` và
  chỉ hoàn tất item khi native buffer đã drain để không vượt 256 message/
  4 MiB đang chờ gửi.
- Cleanup socket, queue và callback đúng một lần khi close/error/disconnect.
- Kiểm thử transport bằng WebSocket thật và tích hợp với
  `createLocalMcpRuntime()`.

## Không làm

- Pairing, authentication, device identity hoặc reconnect/backoff.
- `BridgeClientTransport` phía public server.
- Thay đổi catalog sáu MCP tool hoặc permission boundary của M1.
- Tạo RPC riêng thay thế MCP `initialize`, `tools/list` hoặc `tools/call`.

## Luồng chính

```text
createLocalMcpRuntime()
        │ connect(BridgeServerTransport)
        ▼
WebSocket connect → bridge.hello → bridge.hello.ack
        │
        ▼
MCP server nhận/gửi { kind: "mcp.message", payload }
```

Transport chỉ coi connection là `ready` sau khi ack đúng version và session.
Frame sai hoặc socket failure sẽ reject message đang chờ, gọi `onerror` khi có
lỗi và gọi `onclose` đúng một lần.

## Tiêu chí chấp nhận

- `start()` kết nối và handshake thành công một lần.
- MCP message outbound/inbound round-trip đúng envelope, không đổi payload.
- `send()` trước handshake và sau close bị reject với mã lỗi rõ ràng.
- Malformed/oversized frame không được giao cho MCP.
- Remote close, socket error và duplicate close không làm runtime treo/crash.
- Local MCP Runtime production assembly gọi được `initialize`, `tools/list` và
  `tools/call system` qua WebSocket thật.
- `bun run check`, `bun run typecheck` và `bun test` xanh.

## Kế hoạch kiểm thử

1. Unit/lifecycle: state, handshake, send boundary, close idempotency và lỗi.
2. Wire: envelope, UTF-8 size limit, malformed frame và ordering.
3. Backpressure: socket chậm, native `bufferedAmount`, FIFO và giới hạn 256
   message/4 MiB.
4. Integration: fake public peer qua Bun WebSocket thật gọi Local MCP Runtime
   được assembly bằng `createLocalMcpRuntime()`.

## History

| Ngày | Thay đổi | Lý do | Trạng thái |
|---|---|---|---|
| 2026-09-15 | Khởi tạo và hoàn tất kế hoạch cho #21 | Ánh xạ contract M2.1 vào `BridgeServerTransport`, test WebSocket thật và production runtime assembly | complete |
| 2026-09-15 | Bổ sung native backpressure và lifecycle regression | Giữ bound trên dữ liệu thực sự còn trong `WebSocket.bufferedAmount`, phân biệt close `TIMEOUT` với `PROTOCOL_ERROR` | complete |
