# Security

`doctmcp` có khả năng đọc/ghi file và thực thi lệnh local nên security là yêu cầu kiến trúc, không phải tính năng bổ sung sau.

## Trust boundaries

- ChatGPT/plugin -> public server.
- Public server -> authenticated device session.
- Local agent -> local operating system.
- Local tool -> filesystem/process/network resources.

## Quy tắc nền

- Chỉ dùng TLS/WSS ngoài local development.
- Không expose local agent trực tiếp ra Internet.
- Không ghi log token hoặc credential đầy đủ.
- Validate mọi message nhận qua network trước khi sử dụng.
- Áp permission trên agent, không chỉ trên server.
- Normalize path trước khi kiểm tra filesystem policy.
- Command timeout, output limit và cancellation phải được thiết kế trước khi mở shell rộng rãi.
- Credential thiết bị phải revoke/rotate được.

## Server compromise assumption

Permission quan trọng phải được enforce lại ở local agent. Không giả định public server luôn đáng tin tuyệt đối đối với quyền của hệ điều hành local.

## Audit

Phase sau nên có audit metadata: user, device, tool, thời điểm, trạng thái và duration. Không mặc định lưu toàn bộ nội dung file, command output hoặc secret vào audit log.
