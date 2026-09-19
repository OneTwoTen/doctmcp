# Tài liệu doctmcp

Thư mục này là nguồn tài liệu chính của dự án. Tài liệu mặc định viết bằng **tiếng Việt**; chỉ giữ tiếng Anh cho code, command, API identifier, protocol field và thuật ngữ kỹ thuật cần tương thích.

## Bắt đầu từ đâu

- [Getting started](getting-started.md): cài đặt từ đầu, chạy local, cấu hình public server/OIDC, pairing và sử dụng với ChatGPT.
- [architecture.md](architecture.md): kiến trúc mục tiêu, ranh giới module và trạng thái đã/dự kiến.
- [roadmap.md](roadmap.md): thứ tự milestone và tiêu chí hoàn tất từng giai đoạn.
- [development.md](development.md): chuẩn bị máy, lệnh local, test và quy ước phát triển.
- [agent-workflow.md](agent-workflow.md): quy trình làm việc cho feature nhiều bước hoặc thay đổi kiến trúc.
- [project-playbook.md](project-playbook.md): playbook thực hành cho contributor/AI agent: bắt đầu task, chọn module, test matrix, review PR, security checklist, Git/PR và Definition of Done.

## M1 — Local MCP

Tài liệu chi tiết cho milestone nền:

- [spec M1 Local MCP](specs/2026-09-14-m1-local-mcp-design.md): catalog 6 tool, boundary, schema, error và acceptance criteria.
- [tool catalog](tools/README.md): mục lục contract từng MCP tool.
- [workspace](tools/workspace.md)
- [system](tools/system.md)
- [filesystem.read](tools/filesystem-read.md)
- [filesystem.write](tools/filesystem-write.md)
- [filesystem.delete](tools/filesystem-delete.md)
- [shell.exec](tools/shell-exec.md)
- [test strategy M1](testing/m1-local-mcp.md): schema/unit, integration và MCP contract test.

## M2 — Server gọi local

- [spec M2 bridge](specs/2026-09-15-m2-bridge-design.md): contract handshake, MCP frame và lifecycle cho WebSocket bridge.
- [test M2 server ↔ local](testing/m2-server-local.md): acceptance flow production boundary.

## M4 — Public MCP endpoint

- [quyết định public MCP/OIDC](decisions/2026-09-17-public-mcp-endpoint.md): Streamable HTTP, OIDC resource server, owner derivation và tool routing.
- [spec M4 public MCP](specs/2026-09-17-m4-public-mcp-design.md) và [plan](plans/2026-09-17-m4-public-mcp-endpoint.md).
- [test M4](testing/m4-public-mcp.md): JWT/OIDC, public MCP, routing, offline và audit acceptance.

## M5 — CLI local và pairing ChatGPT

- [spec M5](specs/2026-09-18-m5-chatgpt-pairing-design.md) và [implementation plan](plans/2026-09-18-m5-chatgpt-pairing.md).
- [test M5](testing/m5-chatgpt.md): CLI config, outbound pairing, credential ACK, authenticated MCP tool và local permission.

## M3 — Device management và pairing

- [spec M3.1 Device identity](specs/2026-09-15-m3-device-identity-design.md): immutable `deviceId`, ownership và persistence contract.
- [plan issue #30](plans/2026-09-15-issue-30-device-identity-store.md): task/verification của foundation M3.1.
- [pairing.md](pairing.md): pairing/authentication M3.2–M3.3 cùng trạng thái session, reconnect và routing M3.4–M3.6.
- [plan issue #32](plans/2026-09-15-issue-32-device-credential-auth.md): implementation/verification đã hoàn tất qua PR #39.
- [spec M3.5 reconnect](specs/2026-09-17-m3-local-reconnect-design.md) và [plan #34](plans/2026-09-17-issue-34-local-reconnect.md): đã triển khai qua PR #41.
- [spec M3.6 device routing](specs/2026-09-17-m3-multidevice-routing-design.md) và [plan #35](plans/2026-09-17-issue-35-multidevice-routing.md): implementation và target verification đã hoàn tất trong nhánh hiện tại.
- [spec M3.7 vertical acceptance](specs/2026-09-17-m3-vertical-acceptance-design.md), [plan #36](plans/2026-09-17-issue-36-m3-acceptance.md) và [test strategy](testing/m3-acceptance.md): `test:m3` xanh local; CI/cross-platform verification xanh trong [run 35359769097](https://github.com/OneTwoTen/doctmcp/actions/runs/35359769097).

## M6 — SQLite production persistence

- [Persistence boundary M6](decisions/2026-09-19-m6-persistence-boundary.md): repository interfaces, atomic pairing/credential recovery và runtime boundary.
- [M6 SQLite acceptance](testing/m6-sqlite-bootstrap.md): migrations, contract/reopen và authenticated reconnect tests.
- [Coolify SQLite](deployment/coolify-sqlite.md): /data persistent volume, production config, restart/recreate checklist và giới hạn kiểm chứng VPS thật.

## Contract và vận hành

- [protocol.md](protocol.md): ranh giới giữa MCP data plane và protocol control plane riêng của doctmcp.
- [security.md](security.md): trust boundary và yêu cầu bảo mật.
- [permissions.md](permissions.md): permission model được enforce tại local.

## Quyết định kiến trúc

Decision note nằm trong `docs/decisions/` và dùng để lưu **lý do** của quyết định dài hạn, không chỉ trạng thái hiện tại.

Decision hiện có:

- [2026-09-14-local-mcp-first.md](decisions/2026-09-14-local-mcp-first.md): hoàn thiện local MCP và server → local trước khi tích hợp ChatGPT.

## Quy ước nguồn sự thật

Khi tài liệu có vẻ mâu thuẫn, ưu tiên theo thứ tự:

1. Yêu cầu trực tiếp mới nhất của người dùng.
2. Decision/spec đã được duyệt gần nhất.
3. `architecture.md` và tài liệu domain tương ứng.
4. `roadmap.md`.
5. README hoặc mô tả tổng quan.

Tài liệu phải phân biệt rõ ba trạng thái:

- **Đã triển khai**: có code và bằng chứng kiểm tra trong repository.
- **Đang triển khai**: scope đã chốt nhưng chưa hoàn tất acceptance criteria.
- **Dự kiến**: định hướng/roadmap, chưa được coi là capability hiện có.

Không được mô tả tính năng roadmap như đã tồn tại chỉ vì tài liệu kiến trúc có đề cập.

## Khi nào tạo spec, plan và history

Không cần tạo artifact nặng cho mọi thay đổi nhỏ.

- Thay đổi nhỏ, cục bộ: issue/task + test + tài liệu liên quan là đủ.
- Feature mới hoặc subsystem mới: nên có spec trước implementation.
- Công việc nhiều bước: issue breakdown hoặc plan phải ánh xạ acceptance criteria sang task/test.
- Thay đổi kiến trúc dài hạn: tạo decision note.
- Khi task kéo dài qua nhiều phiên/PR: thêm history note hoặc `History` trong spec/plan/decision.

Các thư mục `specs/`, `plans/` hoặc `history/` chỉ cần tạo khi có artifact thật; không tạo placeholder rỗng chỉ để hoàn thiện cây thư mục.
