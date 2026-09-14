# doctmcp

`doctmcp` là cầu nối giữa ChatGPT và các máy cục bộ của người dùng thông qua một MCP server công khai và một local agent chạy trên Windows, macOS hoặc Linux.

## Mục tiêu

Kiến trúc cốt lõi:

```text
ChatGPT
   │ MCP
   ▼
Public Server
   │ WebSocket/TLS
   ▼
Local Agent
   │
   ├─ filesystem
   ├─ shell
   ├─ git
   └─ system
```

Public server chịu trách nhiệm xác thực, pairing, định tuyến lệnh và quản lý phiên thiết bị. Local agent chủ động kết nối ra server nên không cần expose cổng của máy local ra Internet.

## Tech stack

- Runtime: Bun 1.4.2
- Language: TypeScript
- Monorepo: Bun workspaces
- Public server: Bun, dự kiến dùng Elysia cho HTTP/MCP API
- Local transport: WebSocket over TLS
- Validation: shared schemas trong `packages/schemas`
- Shared wire contract: `packages/protocol`
- Lint/format: Biome
- CI/CD: GitHub Actions

## Cấu trúc

```text
apps/
  server/        Public MCP/relay server
  agent/         Local agent
packages/
  protocol/      Message contract giữa server và agent
  schemas/       Shared validation/schema
  config/        Shared project config
  test-utils/    Shared test helpers
docs/            Tài liệu kiến trúc và phát triển
```

Xem thêm `docs/architecture.md`, `docs/protocol.md`, `docs/security.md` và `AGENTS.md`.

## Nguyên tắc ban đầu

- Không expose local agent trực tiếp ra Internet.
- Pairing code chỉ dùng một lần và có thời hạn; không dùng làm credential dài hạn.
- Mọi thao tác local phải đi qua permission policy.
- Server và agent dùng chung một protocol contract.
- Tool MCP bên ngoài không cần ánh xạ 1:1 với implementation tool bên local.
- Ưu tiên test trước khi triển khai behavior mới.

## Trạng thái

Dự án đang ở giai đoạn bootstrap kiến trúc. Phase đầu tập trung vào luồng tối thiểu `agent ↔ server ↔ ChatGPT`, pairing thiết bị và các tool local cơ bản.
