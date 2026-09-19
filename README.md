# doctmcp

`doctmcp` là dự án kết nối ChatGPT và các MCP client với máy cục bộ của người dùng mà không cần mở cổng public trên máy local.

Mục tiêu cuối cùng là để ChatGPT gọi các capability trên Windows, macOS hoặc Linux thông qua một public server. Thứ tự triển khai cố ý đi từ phần dễ kiểm thử nhất: **hoàn thiện MCP ở local, chứng minh public server gọi MCP local thành công, sau đó mới thêm device management và tích hợp ChatGPT**.

## Trạng thái hiện tại

M1 — Local MCP đã hoàn tất **8/8 work item** và đủ **6/6 tool**: `workspace`, `system`, `filesystem.read`, `filesystem.write`, `filesystem.delete`, `shell.exec`.

M2 — Public server gọi Local MCP cũng đã hoàn tất **5/5 work item**. Public MCP Client hiện có thể chạy `initialize → tools/list → tools/call system/info` qua `BridgeClientTransport → Public Gateway → BridgeServerTransport → Local MCP Runtime` trên WebSocket thật. Acceptance suite #23 còn khóa filesystem round-trip, structured MCP/domain error, pending disconnect, public close, malformed/oversized frame và cleanup idempotent.

**M3 — implementation 7/7 work item đã có trong nhánh hiện tại; CI/cross-platform gate #36 đã xanh.** `bun run test:m3` (127 test), M1/M2 acceptance, `bun run check` và `bun run typecheck` xanh local. Full `bun test` trên Windows có 32 fixture symlink `EPERM`; GitHub Linux full suite và Windows target suites đều xanh trong [CI run](https://github.com/OneTwoTen/doctmcp/actions/runs/35359769097).

**M4 — implementation và local acceptance đã hoàn tất trong nhánh hiện tại.** Public `/mcp` dùng Streamable HTTP trên Bun, OIDC JWT auth từ provider bên ngoài, tool routing theo `deviceId` và MCP Client persistent theo bridge session. `bun run test:m4` và cross-platform CI xanh. OIDC tenant/domain và durable production persistence vẫn cần cấu hình triển khai; chưa coi là production-ready.

**M5 — CLI local và pairing ChatGPT đã triển khai trong nhánh hiện tại.** `bun run test:m5` (37 test) bao phủ start pairing, kênh WebSocket outbound, lưu credential trước ACK, `devices_pair` OAuth, reconnect bridge và gọi tool local với permission đã cấu hình. Pairing session có capacity bound, secret cache được dọn khi channel kết thúc, và TLS proxy chỉ được tin theo IP peer cấu hình chính xác. Linux và Windows CI xanh; đăng nhập ChatGPT thật vẫn cần OIDC provider, HTTPS domain và OAuth registration của deployment.

Thứ tự phát triển đã chốt:

1. **M1 — Local MCP**: local runtime chạy MCP server thật và expose các tool cơ bản. ✅
2. **M2 — Server → Local**: public server đóng vai MCP client, giao tiếp với MCP server local qua custom WebSocket transport. ✅
3. **M3 — Device management**: device identity, session, pairing, auth, reconnect và heartbeat. ✅ Implementation và CI M1–M5 xanh.
4. **M4 — Public MCP endpoint**: ✅ implementation, acceptance và CI; 🔎 còn cấu hình triển khai production.
5. **M5 — ChatGPT integration**: ✅ code, local end-to-end acceptance và CI; 🔎 còn cấu hình OIDC/ChatGPT thực tế.

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

Gateway và public endpoint dùng `Bun.serve`; `/mcp` dùng Streamable HTTP SDK chính thức. Quyết định OIDC resource-server và cấu hình external provider nằm trong [decision M4](docs/decisions/2026-09-17-public-mcp-endpoint.md).

## Cấu trúc repository

```text
apps/
  server/        Public server; chứa gateway, device router, MCP client bridge và public MCP endpoint
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

## Bắt đầu nhanh

Nếu bạn mới clone repository, đọc [Getting started](docs/getting-started.md) trước. Tài liệu này bao phủ từ `bun install`, chạy local MCP, cấu hình public server/OIDC, tạo `doctmcp.json`, pairing device và flow ChatGPT end-to-end.

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

Kiểm tra M4 public endpoint:

```sh
bun run test:m4
```

Kiểm tra M5 pairing và CLI:

```sh
bun run test:m5
```

### Kết nối local CLI

Tạo file cấu hình JSON, ví dụ `doctmcp.json`:

```json
{
  "serverUrl": "https://api.example.com",
  "deviceName": "Máy làm việc",
  "credentialPath": "./.doctmcp/device-credential.json",
  "workspaces": [
    {
      "id": "project",
      "name": "Project",
      "root": "./project",
      "capabilities": {
        "read": true
      },
      "deny": [".env"]
    }
  ]
}
```

Đường dẫn `credentialPath` và workspace tương đối tính từ thư mục chứa file cấu hình. Mọi capability mặc định tắt; chỉ bật quyền cần dùng. Nếu bỏ `credentialPath`, CLI dùng `~/.doctmcp/device-credential.json`.

```sh
bun run connect:agent -- --config ./doctmcp.json
```

CLI mở pairing lần đầu, chỉ hiển thị code sau khi `/pairing` xác nhận attach, lưu credential local trước ACK, rồi mở authenticated bridge và reconnect. Khi credential đã lưu, lần chạy sau bỏ qua pairing. Nhập code vào MCP tool `devices_pair` trong ChatGPT đã đăng nhập; public endpoint là `https://<domain>/mcp` và cần OAuth Authorization Code + PKCE `S256`, scope `mcp`. Hướng dẫn cấu hình và giới hạn hiện tại ở [M5 acceptance](docs/testing/m5-chatgpt.md).

Để bật endpoint khi chạy server, cấu hình `apps/server/.env.example` với public HTTPS URL và OIDC issuer/audience. `BIND_HOST` mặc định là loopback để server đi sau TLS reverse proxy; nếu proxy ở container/mạng khác, cấu hình chính xác IP của proxy trong `TRUSTED_PROXY_ADDRESSES` và yêu cầu proxy ghi đè `X-Forwarded-Proto=https`. Endpoint đóng fail-closed ở HTTP 503 nếu chưa có OIDC config.

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
- [M3 acceptance](docs/testing/m3-acceptance.md)
- [M4 acceptance](docs/testing/m4-public-mcp.md)
- [M5 CLI/pairing acceptance](docs/testing/m5-chatgpt.md)
- [Bảo mật](docs/security.md)
- [Permission](docs/permissions.md)
- [Pairing thiết bị](docs/pairing.md)
- [Phát triển local](docs/development.md)
- [Quy trình làm việc với AI agent](docs/agent-workflow.md)
- [Project playbook](docs/project-playbook.md) — hướng dẫn thực hành chi tiết cho task, test, review PR, security và Definition of Done

Ngôn ngữ mặc định của tài liệu dự án là **tiếng Việt**. Tên kỹ thuật, code, command, API identifier và thuật ngữ cần tương thích có thể giữ tiếng Anh.

## License

MIT License. Xem [LICENSE](LICENSE).
