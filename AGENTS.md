# Hướng dẫn repository doctmcp

## Phạm vi và cách làm việc

`doctmcp` là monorepo Bun/TypeScript dùng để kết nối MCP client với máy local thông qua public server và local MCP runtime.

Ngôn ngữ mặc định của repository là **tiếng Việt**. Tài liệu, kế hoạch, decision note, history note, skill và hướng dẫn mới do dự án viết phải dùng tiếng Việt. Chỉ giữ tiếng Anh cho tên kỹ thuật, code, lệnh, đường dẫn, URL, API identifier, protocol field, trích dẫn nguyên văn hoặc nội dung do công cụ bên thứ ba sinh ra. Phần giải thích xung quanh vẫn phải viết bằng tiếng Việt.

Không thay đổi nguyên tắc kiến trúc đã chốt nếu chưa có quyết định rõ ràng trong yêu cầu người dùng, spec hoặc decision note.

Đọc các tài liệu sau khi phù hợp:

- `docs/README.md`: mục lục tài liệu và trạng thái nguồn sự thật.
- `docs/architecture.md`: ranh giới public server, local runtime và MCP.
- `docs/roadmap.md`: thứ tự milestone hiện tại.
- `docs/protocol.md`: ranh giới giữa MCP data plane và protocol control plane riêng.
- `docs/security.md`: trust boundary và yêu cầu bảo mật.
- `docs/permissions.md`: permission ở local.
- `docs/agent-workflow.md`: workflow chung cho công việc nhiều bước/kiến trúc.

## Hướng kiến trúc hiện tại

Thứ tự triển khai bắt buộc ở giai đoạn hiện tại:

1. Hoàn thiện MCP server chạy local.
2. Test trực tiếp `tools/list` và `tools/call` ở local.
3. Tạo custom WebSocket transport để public server làm MCP client gọi local MCP.
4. Sau khi đường server → local ổn định mới thêm device management, pairing/auth và public MCP endpoint.
5. ChatGPT integration là lớp cuối, không phải dependency để chứng minh local MCP hoạt động.

Không đảo thứ tự này nếu không có lý do kỹ thuật rõ ràng và quyết định mới.

## Quy tắc MCP và protocol

- Local runtime phải là MCP server thật; local tool không biết gì về ChatGPT.
- Public server về sau chứa MCP client cho từng device/session.
- `tools/list`, `tools/call`, tool result, MCP error và cancellation thuộc MCP; không tạo RPC song song như `command.request`/`command.result` để lặp lại chức năng này.
- `packages/protocol` chỉ chứa control-plane contract ngoài MCP, ví dụ handshake, device/session metadata, authentication, heartbeat, pairing và version metadata của bridge.
- Không để `apps/server` import implementation nội bộ của `apps/agent` và ngược lại.
- Tool implementation phải tách khỏi transport để test local không cần public server.

## Stack bắt buộc

- Bun 1.4.2.
- TypeScript 7 strict.
- Bun workspaces.
- Biome cho lint/format.
- `bun test` cho test TypeScript.
- Shared runtime validation trong `packages/schemas` khi schema được dùng qua boundary.

Không thêm dependency chỉ vì tiện nếu Bun API hoặc dependency đã có giải quyết tốt cùng bài toán. Với MCP, ưu tiên SDK TypeScript chính thức thay vì tự viết protocol parser.

## Quy tắc phát triển

1. Ưu tiên test đỏ trước implementation khi behavior có thể mô tả độc lập.
2. Thay đổi MCP tool phải test ít nhất success path và input/error quan trọng.
3. Thay đổi filesystem/shell/permission phải test denied path, không chỉ happy path.
4. Không duplicate contract qua nhiều package; xác định rõ contract thuộc MCP hay control plane trước khi thêm type.
5. Không commit secret, token thiết bị, pairing code thực, private key hoặc `.env`.
6. File path phải normalize/canonicalize trước khi áp permission policy.
7. Shell execution phải có timeout, output limit, cwd policy và environment policy trước khi coi là production-ready.
8. Giữ thay đổi theo scope; không tạo module trống cho feature chưa triển khai.
9. Tài liệu phải phân biệt rõ **đã triển khai**, **đang làm** và **dự kiến**; không mô tả roadmap như tính năng đã có.

## Quy trình agent

Công việc nhỏ, cục bộ và rõ ràng có thể triển khai trực tiếp kèm test tương ứng.

Feature mới, subsystem mới, thay đổi protocol/transport/security hoặc thay đổi nhiều module phải theo `docs/agent-workflow.md`:

- đọc context và history liên quan;
- mô tả design/acceptance criteria;
- tạo spec/plan khi phạm vi đủ lớn;
- triển khai theo task nhỏ;
- chạy verification mới;
- review diff so với quyết định đã chốt;
- cập nhật decision/history khi thay đổi kiến trúc.

Chat context không phải nguồn sự thật dài hạn cho quyết định kiến trúc. Quyết định quan trọng cần được ghi vào repository.

## Lệnh từ root

```sh
bun install
bun run check
bun run typecheck
bun test
bun run dev:agent
bun run dev:server
```

`dev:agent` và `dev:server` hiện chỉ phản ánh entrypoint scaffold cho đến khi runtime thật được triển khai. Không tuyên bố networking/MCP runtime đã hoạt động chỉ vì entrypoint chạy được.

## Security rules

- Local runtime không expose cổng public chỉ để server/ChatGPT gọi vào.
- Kết nối remote phải do local chủ động mở ra public server.
- Permission quan trọng phải enforce tại local, không chỉ trên public server.
- Không log credential đầy đủ hoặc nội dung nhạy cảm theo mặc định.
- Credential thiết bị phải có đường revoke/rotate trước khi dùng production.
- Server compromise không được mặc nhiên đồng nghĩa có toàn quyền hệ điều hành local.

## Definition of done

Một thay đổi chỉ được coi là hoàn tất khi:

- behavior đúng với architecture/spec/decision hiện hành;
- test tương xứng đã chạy thành công;
- `bun run check` và `bun run typecheck` không bị bỏ qua nếu thay đổi liên quan;
- tài liệu liên quan được cập nhật;
- không che lỗi bằng cách tắt rule hoặc bỏ validation mà không có lý do được ghi lại.
