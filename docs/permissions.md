# Permission model

Permission được enforce tại **local MCP runtime** trước khi tool implementation thật được thực thi.

## Mục tiêu

Permission layer phải bảo vệ máy local ngay cả khi:

- public server gửi request sai;
- một MCP client gọi tool ngoài ý định;
- public server bị compromise;
- tool input cố vượt ra ngoài workspace/path được phép.

## Capability groups

Ban đầu chia capability theo mức tác động:

- `read`: đọc metadata hoặc nội dung, không thay đổi hệ thống.
- `write`: tạo/sửa/xóa dữ liệu.
- `execute`: chạy process/command hoặc hành động có side effect rộng.

Capability chưa cấu hình mà có side effect đáng kể phải mặc định **deny**.

## Filesystem

Policy nên hỗ trợ allow/deny root theo canonical path.

Ví dụ conceptual:

```yaml
filesystem:
  allow:
    - ~/Projects
    - ~/Documents
  deny:
    - ~/.ssh
    - ~/.aws
    - ~/.gnupg
```

Quy tắc:

- normalize/canonicalize path trước khi so policy;
- deny có ưu tiên cao hơn allow;
- không chỉ kiểm tra string prefix;
- phải xem xét symlink khi target thật có thể nằm ngoài allow root;
- read/write/delete có thể có policy riêng nếu cần.

## Shell

Không coi shell command là an toàn chỉ vì command bắt đầu bằng một prefix được allow.

`shell.exec` cần thiết kế tối thiểu cho:

- enabled/disabled rõ ràng;
- cwd được phép;
- timeout;
- output limit;
- environment allow/filter;
- structured exit code;
- policy hoặc approval cho command nhạy cảm.

Blacklist command nguy hiểm chỉ có thể là defense-in-depth, không phải security model chính.

## Tool discovery và permission

Có hai chiến lược khả thi:

1. Tool vẫn xuất hiện trong `tools/list`, nhưng `tools/call` có thể bị deny theo input/policy.
2. Tool/capability bị ẩn khỏi discovery khi device policy tắt hoàn toàn capability đó.

M1 ưu tiên behavior đơn giản, dễ test. Quyết định dynamic discovery chỉ cần khóa khi có use case rõ ràng.

## Structured denial

Permission denial phải trả structured tool error đủ để caller hiểu nguyên nhân ở mức an toàn, ví dụ:

```text
permission_denied
path_not_allowed
shell_disabled
timeout
```

Không trả policy nội bộ chi tiết đến mức làm lộ secret/path nhạy cảm nếu không cần.

## Test bắt buộc

Mỗi capability nhạy cảm phải có test denial tương ứng.

Filesystem tối thiểu:

- path trong allow root;
- path ngoài allow root;
- path trong deny root;
- traversal/symlink case quan trọng.

Shell tối thiểu:

- shell disabled;
- cwd không được phép;
- timeout;
- output limit.
