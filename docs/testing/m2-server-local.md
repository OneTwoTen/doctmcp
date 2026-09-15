# Acceptance test M2 — Public server ↔ Local MCP

## Mục tiêu

Suite này khóa Definition of Done của M2 bằng vertical flow chạy thật qua WebSocket:

```text
MCP Client phía public
    ↓
BridgeClientTransport
    ↓
Public WebSocket Gateway
    ↓
BridgeServerTransport
    ↓
Local MCP Runtime
```

Không dùng in-memory transport để thay thế bridge boundary cần chứng minh.

## Chạy test

```sh
bun run test:m2
```

Để chạy toàn repository:

```sh
bun run check
bun run typecheck
bun test
```

## Những behavior được khóa

### Success path

- MCP `initialize` chạy xuyên bridge thật.
- `tools/list` trả đúng catalog 6 tool của M1.
- `tools/call system/info` trả structured result từ local.
- `filesystem.write` và `filesystem.read` round-trip trên temp workspace thật.

### MCP error semantics

- unknown tool vẫn fail theo semantics MCP, bridge không đổi thành RPC riêng;
- domain error như `WORKSPACE_NOT_FOUND` vẫn giữ structured error code;
- sau domain error, session vẫn dùng được cho request hợp lệ tiếp theo.

### Lifecycle / disconnect

- local disconnect khi public MCP request đang pending làm request reject rõ ràng;
- public-side close propagate về local;
- close/cleanup idempotent;
- gateway giải phóng active session.

### Protocol boundary

Malformed và oversized frame được tạo bằng WebSocket thật đi trực tiếp vào production gateway, vì đây là boundary cần kiểm tra trước khi frame trở thành MCP message:

- malformed JSON → `INVALID_MESSAGE` + `PROTOCOL_ERROR`;
- frame vượt 1 MiB → `MESSAGE_TOO_LARGE` và native close protocol error;
- process không crash và không để lại active session.

## Temp workspace

Suite tự tạo workspace trong thư mục tạm của hệ điều hành và xoá sau mỗi test. Không đọc/ghi repository làm fixture cho filesystem acceptance.

## Không thuộc M2 acceptance

Suite không yêu cầu:

- user authentication;
- pairing code;
- `deviceId`/device credential;
- database;
- multi-device routing;
- public MCP endpoint cho external client;
- ChatGPT integration.

Các phần này thuộc milestone sau.
