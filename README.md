# doctmcp

`doctmcp` là dự án kết nối ChatGPT và các MCP client với máy cục bộ của người dùng mà không cần mở cổng public trên máy local.

Mục tiêu cuối cùng là để ChatGPT gọi các capability trên Windows, macOS hoặc Linux thông qua một public server. Thứ tự triển khai cố ý đi từ phần dễ kiểm thử nhất: **hoàn thiện MCP ở local, chứng minh public server gọi MCP local thành công, sau đó mới thêm device management và tích hợp ChatGPT**.

## Trạng thái hiện tại

M1 — Local MCP đã hoàn tất **8/8 work item** và đủ **6/6 tool**: `workspace`, `system`, `filesystem.read`, `filesystem.write`, `filesystem.delete`, `shell.exec`.

M2 — Public server gọi Local MCP cũng đã hoàn tất **5/5 work item**. Public MCP Client hiện có thể chạy `initialize → tools/list → tools/call system/info` qua `BridgeClientTransport → Public Gateway → BridgeServerTransport → Local MCP Runtime` trên WebSocket thật. Acceptance suite #23 còn khóa filesystem round-trip, structured MCP/domain error, pending disconnect, public close, malformed/oversized frame và cleanup idempotent.

**Milestone active tiếp theo là M3 — Device management và pairing.** Public MCP endpoint và ChatGPT integration vẫn thuộc M4/M5.

Thứ tự phát triển đã chốt:

1. **M1 — Local MCP**: local runtime chạy MCP server thật và expose các tool cơ bản. ✅
2. **M2 — Server → Local**: public server đóng vai MCP client, giao tiếp với MCP server local qua custom WebSocket transport. ✅
3. **M3 — Device management**: device identity, session, pairing, auth, reconnect và heartbeat. 🚧 tiếp theo
4. **M4 — Public MCP endpoint**: public server expose MCP endpoint cho client bên ngoài.
5. **M5 — ChatGPT integration**: kết nối plugin/app của ChatGPT và hoàn thiện UX nhiều thiết bị.

Xem chi tiết tại [roadmap](docs/roadmap.md).

## Kiến trúc mục tiêu

```text
ChatGPT / MCP client
        │
        │ MCP
        ▼
┌────────────────────────┐
│     Public Server      │
│                        │
│ Public MCP endpoint    │
│ Device router          │
│ MCP client             │
└───────────┬────────────┘
            │
            │ custom WebSocket transport
            │ local chủ động kết nối ra ngoài
            ▼
┌────────────────────────┐
│      Local Runtime     │
│                        │
│ MCP server             │
│ Permission engine      │
│ ├─ system.*            │
│ ├─ filesystem.*        │
│ ├─ shell.*             │
│ └─ git.*               │
└────────────────────────┘
```

`tools/list`, `tools/call`, kết quả tool, lỗi MCP và cancellation phải đi theo semantics của MCP. Dự án không tạo thêm một RPC `command.request/command.result` song song chỉ để thực hiện lại chức năng của MCP.

Protocol riêng của `doctmcp` chỉ dành cho phần nằm ngoài MCP, ví dụ device handshake, authentication, pairing, heartbeat và metadata session.

## Tech stack

- Runtime: **Bun 1.4.2**.
- Ngôn ngữ: **TypeScript 7**, strict mode.
- Monorepo: Bun workspaces.
- Validation: shared schema trong `packages/schemas`.
- Device/control-plane contract: `packages/protocol`.
- Lint/format: **Biome 2.5.x**.
- Test: `bun test`.
- CI: GitHub Actions.
- MCP: SDK TypeScript chính thức.

Gateway M2.2 dùng `Bun.serve` và WebSocket native; framework HTTP/public MCP endpoint production vẫn chưa được chốt.

## Cấu trúc repository

```text
apps/
  server/        Public server; chứa gateway + MCP client bridge, về sau thêm device router/public MCP endpoint
  agent/         Local runtime; chứa MCP server, permission engine, local tools và outbound bridge transport
packages/
  protocol/      Contract control-plane ngoài MCP
  schemas/       Runtime validation dùng chung
  config/        Cấu hình dùng chung khi thực sự cần
  test-utils/    Helper dùng chung cho test
docs/            Kiến trúc, roadmap, security, workflow và decision notes
.github/         GitHub Actions
AGENTS.md        Quy tắc chung cho contributor và AI agent
```

Tên thư mục `apps/agent` được giữ để tránh thay đổi scaffold không cần thiết. Về mặt kiến trúc, thành phần này là **local MCP runtime**, không phải một RPC agent tự định nghĩa protocol riêng.

## Chuẩn bị máy

Yêu cầu:

- Bun 1.4.2.
- Git.

Cài dependencies:

```sh
bun install
```

Kiểm tra repository:

```sh
bun run check
bun run typecheck
bun test
```

Chạy riêng acceptance suite của Local MCP:

```sh
bun run test:local
```

Chạy riêng acceptance suite M2 server ↔ local:

```sh
bun run test:m2
```

Entrypoint phát triển:

```sh
bun run dev:agent
bun run dev:server
```

Xem hướng dẫn chi tiết tại [development.md](docs/development.md).

## Nguyên tắc kiến trúc

- Không expose local runtime trực tiếp ra Internet.
- Local là phía chủ động tạo kết nối tới public server.
- MCP là protocol cho tool discovery/call/result; không duplicate semantics này trong protocol riêng.
- Permission quan trọng phải được enforce tại local trước khi tool chạy.
- `packages/protocol` không được biến thành một RPC framework song song với MCP.
- Tool có side effect phải có test cho permission, error và giới hạn an toàn tương ứng.
- Ưu tiên test đỏ trước implementation khi behavior có thể kiểm thử độc lập.

## Tài liệu

Bắt đầu từ [docs/README.md](docs/README.md).

Các tài liệu chính:

- [Kiến trúc](docs/architecture.md)
- [Roadmap](docs/roadmap.md)
- [Protocol và transport](docs/protocol.md)
- [M2 acceptance](docs/testing/m2-server-local.md)
- [Bảo mật](docs/security.md)
- [Permission](docs/permissions.md)
- [Pairing thiết bị](docs/pairing.md)
- [Phát triển local](docs/development.md)
- [Quy trình làm việc với AI agent](docs/agent-workflow.md)

Ngôn ngữ mặc định của tài liệu dự án là **tiếng Việt**. Tên kỹ thuật, code, command, API identifier và thuật ngữ cần tương thích có thể giữ tiếng Anh.

## License

MIT License. Xem [LICENSE](LICENSE).
