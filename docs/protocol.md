# Protocol và transport

Tài liệu này xác định ranh giới giữa **MCP** và protocol riêng của `doctmcp`.

## Nguyên tắc chính

`doctmcp` không tạo một RPC protocol thứ hai để thực thi tool.

Các hành vi sau thuộc MCP:

- initialization/capability negotiation;
- `tools/list`;
- `tools/call`;
- tool result;
- MCP error;
- cancellation/lifecycle message tương ứng khi được dùng.

Các hành vi trên phải đi qua MCP message và semantics chuẩn, kể cả khi transport bên dưới là custom WebSocket bridge.

## Custom WebSocket transport

M2 sử dụng transport tùy biến để truyền MCP message giữa public server và local runtime.

```text
Public Server                       Local Runtime

MCP Client                          MCP Server
    │                                   ▲
    ▼                                   │
BridgeClientTransport             BridgeServerTransport
    │                                   ▲
    └──────── WebSocket ────────────────┘
```

Transport có trách nhiệm:

- nhận MCP message từ SDK;
- serialize/forward qua WebSocket;
- deserialize message nhận được;
- đưa message trở lại MCP SDK;
- phát hiện close/error;
- hỗ trợ lifecycle cần thiết của transport.

Transport **không** định nghĩa lại tool name, tool arguments, command id hoặc result schema riêng khi MCP đã sở hữu các khái niệm đó.

## Control plane của doctmcp

Protocol riêng chỉ dùng cho dữ liệu nằm ngoài MCP session, ví dụ:

- bridge hello/handshake;
- device/session identity;
- authentication metadata;
- heartbeat/online state;
- reconnect metadata;
- pairing lifecycle;
- bridge protocol version.

Tên message cụ thể chưa cần khóa trước M2/M3. Khi triển khai, schema phải nằm trong `packages/protocol` và có runtime validation tương ứng nếu message đi qua network boundary.

## Versioning

Phải phân biệt:

- **MCP protocol version**: do MCP specification/SDK quản lý.
- **doctmcp bridge protocol version**: chỉ dành cho control plane/custom transport của dự án nếu thật sự cần.

Không dùng bridge version để giả lập hoặc thay thế MCP version.

Breaking change của bridge protocol phải có một trong các chiến lược:

- reject rõ ràng version không hỗ trợ;
- hỗ trợ song song một khoảng version;
- migration/rollout strategy khi local runtime có thể chưa update cùng lúc public server.

## Error boundary

MCP tool error nên đi theo MCP result/error phù hợp.

Bridge/control-plane error chỉ dùng cho lỗi transport/session, ví dụ:

- unauthorized device;
- unsupported bridge version;
- invalid handshake;
- session replaced;
- transport closed.

Không trả stack trace, secret hoặc credential đầy đủ qua bridge mặc định.

## Điều không được làm

Không thêm protocol kiểu sau chỉ để thực hiện lại `tools/call`:

```text
command.request
execute_tool
tool.execute
command.result
```

Nếu một message mới chứa `tool + arguments + result` thì trước tiên phải chứng minh vì sao MCP hiện tại không giải quyết được use case đó.
