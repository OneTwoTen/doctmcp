# doctmcp

`doctmcp` là dự án kết nối ChatGPT và các MCP client với máy cục bộ của người dùng mà không cần mở cổng public trên máy local.

Mục tiêu cuối cùng là để ChatGPT gọi các capability trên Windows, macOS hoặc Linux thông qua một public server. Tuy nhiên, thứ tự triển khai hiện tại cố ý đi từ phần dễ kiểm thử nhất: **hoàn thiện MCP ở local trước, sau đó chứng minh public server gọi MCP local thành công, rồi mới tích hợp ChatGPT**.

## Trạng thái hiện tại

Repository đã có monorepo Bun, TypeScript strict, Biome, CI và các package nền. M1 hiện hoàn thành **4/8 work item**: Local MCP server/tool registry (#2), workspace/path/permission core (#3), tool `system` (#4) và `filesystem.write` (#6). Các tool `workspace`, `system` và `filesystem.write` đã hoạt động qua MCP; resolver đã có traversal/symlink/deny/capability boundary dùng chung cho các filesystem/shell tool tiếp theo. **Bước tiếp theo là #5 — tool `filesystem.read`**, sau đó tiếp tục `filesystem.delete`, `shell.exec` và acceptance test toàn M1. Networking/public server chưa được triển khai.

Thứ tự phát triển đã chốt:

1. **M1 — Local MCP**: local runtime chạy MCP server thật và expose các tool cơ bản.
2. **M2 — Server → Local**: public server đóng vai MCP client, giao tiếp với MCP server local qua custom WebSocket transport.
3. **M3 — Device management**: device identity, session, pairing, auth, reconnect và heartbeat.
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
- MCP: ưu tiên SDK TypeScript chính thức khi bắt đầu M1.

Framework HTTP cho public server chưa phải quyết định cần khóa ở M1; chỉ thêm khi M2/M4 thực sự cần.

## Cấu trúc repository

```text
apps/
  server/        Public server; về sau chứa MCP client, device router và public MCP endpoint
  agent/         Local runtime; sẽ chứa MCP server, permission engine và local tools
packages/
  protocol/      Contract control-plane ngoài MCP
  schemas/       Runtime validation dùng chung
  config/        Cấu hình dùng chung khi thực sự cần
  test-utils/    Helper dùng chung cho test
docs/            Kiến trúc, roadmap, security, workflow và decision notes
.github/         GitHub Actions
AGENTS.md        Quy tắc chung cho contributor và AI agent
```

Tên thư mục `apps/agent` hiện được giữ để tránh thay đổi scaffold không cần thiết. Về mặt kiến trúc, thành phần này là **local MCP runtime**, không phải một RPC agent tự định nghĩa protocol riêng.

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

Khi có implementation runtime:

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
- [Bảo mật](docs/security.md)
- [Permission](docs/permissions.md)
- [Pairing thiết bị](docs/pairing.md)
- [Phát triển local](docs/development.md)
- [Quy trình làm việc với AI agent](docs/agent-workflow.md)

Ngôn ngữ mặc định của tài liệu dự án là **tiếng Việt**. Tên kỹ thuật, code, command, API identifier và thuật ngữ cần tương thích có thể giữ tiếng Anh.

## License

MIT License. Xem [LICENSE](LICENSE).
