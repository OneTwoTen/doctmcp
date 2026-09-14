# Permission model

Permission được enforce tại local agent trước khi tool chạy.

## Capability groups

Ban đầu chia thành:

- `read`: đọc metadata hoặc nội dung không thay đổi hệ thống.
- `write`: tạo, sửa, xóa dữ liệu.
- `execute`: chạy process/command hoặc hành động có side effect rộng.

## Filesystem

Policy nên hỗ trợ allow/deny root theo canonical path. Deny có ưu tiên cao hơn allow.

Ví dụ conceptual:

```yaml
filesystem:
  allow:
    - ~/Projects
  deny:
    - ~/.ssh
    - ~/.aws
```

## Shell

Không coi shell command là string an toàn chỉ vì prefix hợp lệ. Phase shell cần timeout, cwd policy, environment filtering, output limit và cơ chế approval/policy rõ ràng.

## Default

Capability chưa cấu hình phải mặc định deny khi có khả năng gây side effect đáng kể.
