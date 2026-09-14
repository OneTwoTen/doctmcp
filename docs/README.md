# Tài liệu doctmcp

Thư mục này là nguồn tài liệu chính của dự án. Tài liệu mặc định viết bằng **tiếng Việt**; chỉ giữ tiếng Anh cho code, command, API identifier, protocol field và thuật ngữ kỹ thuật cần tương thích.

## Bắt đầu từ đâu

- [architecture.md](architecture.md): kiến trúc mục tiêu, ranh giới module và trạng thái đã/dự kiến.
- [roadmap.md](roadmap.md): thứ tự milestone và tiêu chí hoàn tất từng giai đoạn.
- [development.md](development.md): chuẩn bị máy, lệnh local, test và quy ước phát triển.
- [agent-workflow.md](agent-workflow.md): quy trình làm việc cho feature nhiều bước hoặc thay đổi kiến trúc.

## Contract và vận hành

- [protocol.md](protocol.md): ranh giới giữa MCP và protocol control plane riêng của doctmcp.
- [security.md](security.md): trust boundary và yêu cầu bảo mật.
- [permissions.md](permissions.md): permission model được enforce tại local.
- [pairing.md](pairing.md): thiết kế pairing thiết bị cho giai đoạn sau.

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
- Công việc nhiều bước: nên có plan ánh xạ acceptance criteria sang task/test.
- Thay đổi kiến trúc dài hạn: tạo decision note.
- Khi task kéo dài qua nhiều phiên/PR: thêm history note hoặc `History` trong spec/plan/decision.

Các thư mục `specs/`, `plans/` hoặc `history/` chỉ cần tạo khi có artifact thật; không tạo placeholder rỗng chỉ để hoàn thiện cây thư mục.
