# Kiến trúc doctmcp

## Tổng quan

```text
ChatGPT
   │ MCP over HTTPS
   ▼
Public Server
   │
   ├─ Authentication
   ├─ Pairing
   ├─ Device registry
   ├─ Command dispatcher
   └─ WebSocket gateway
            │
            │ WSS outbound connection từ local
            ▼
       Local Agent
            │
            ├─ Permission engine
            ├─ Filesystem tools
            ├─ Shell tools
            ├─ Git tools
            └─ System tools
```

Local agent luôn là phía chủ động mở kết nối ra public server. Kiến trúc không yêu cầu port forwarding, public IP hay tunnel trực tiếp vào máy người dùng.

## Ranh giới trách nhiệm

### Public server

Server xác thực ChatGPT/plugin, quản lý user/device, pairing, online session và chuyển command tới đúng thiết bị. Server không chứa implementation của filesystem hoặc shell local.

### Local agent

Agent lưu credential của thiết bị, duy trì WebSocket, validate command, kiểm tra permission rồi mới gọi local tool. Agent trả structured result thay vì log thô.

### Shared protocol

`packages/protocol` là wire contract duy nhất giữa server và agent. Mọi breaking change phải tăng protocol version hoặc có chiến lược backward compatibility.

## Luồng command

```text
MCP tool call
  -> server validate/auth
  -> resolve device
  -> create command id
  -> send command.request
  -> agent validate
  -> permission check
  -> execute local tool
  -> command.result
  -> server resolve pending request
  -> MCP result
```

## Nguyên tắc mở rộng

Public MCP tools có thể là API thân thiện với model, còn protocol nội bộ dùng `tool + arguments` để không phải thay wire protocol mỗi lần thêm local capability.
