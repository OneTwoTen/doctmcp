# Permission model

Permission được enforce tại **local MCP runtime trước khi operation chạm filesystem hoặc spawn process**. Permission của public server/MCP client không thay thế boundary này.

## Nguyên tắc

- MCP annotations chỉ là metadata/risk hint cho client.
- Local policy là nguồn quyết định cuối cùng.
- Deny ưu tiên cao hơn allow.
- Path phải normalize/canonicalize trước khi so policy.
- Symlink không được dùng để thoát workspace/root đã cho phép.
- Capability chưa cấu hình phải mặc định deny nếu có side effect đáng kể.

## Workspace

Workspace là root local đã cấu hình với capability riêng:

```yaml
workspaces:
  doctmcp:
    path: ~/Projects/doctmcp
    permissions:
      read: true
      write: true
      delete: false
      execute: true
```

Các tool filesystem/shell nhận workspace id và path/cwd tương đối thay vì tự chọn arbitrary root.

## Capability M1

### `read`

Cho phép:

- `workspace.list/get` chỉ đọc registry metadata;
- `filesystem.read` read/list/stat/search trên workspace được phép.

`system` là capability read-only riêng của runtime và không cho phép đọc environment secret.

### `write`

Cho phép `filesystem.write` với guard của từng action. `overwrite` vẫn mặc định false dù workspace có write permission.

### `delete`

Nên là capability riêng, không suy ra tự động từ `write`. `filesystem.delete` luôn phải qua destructive guard; workspace root không được xoá trong mọi trường hợp M1.

### `execute`

Cho phép `shell.exec` trong workspace. Execute permission không có nghĩa mọi executable/argument đều được phép; command policy có thể deny thêm.

## Path allow/deny

Ngoài workspace root, policy có thể có deny subtree:

```yaml
workspaces:
  home-projects:
    path: ~/Projects
    permissions:
      read: true
      write: true
      delete: false
      execute: true
    deny:
      - secret-project
      - shared/credentials
```

Resolver chuẩn:

```text
workspace id
 -> workspace root
 -> join relative path
 -> normalize/canonicalize
 -> containment check
 -> deny rules
 -> capability check
 -> operation
```

Không kiểm tra policy bằng string prefix đơn giản vì dễ lỗi với sibling prefix, separator và symlink.

## Filesystem safety defaults

- `filesystem.write/write`: `overwrite: false` mặc định.
- `filesystem.write/move`: `overwrite: false` mặc định.
- `filesystem.delete`: `recursive: false` mặc định.
- Không có `force` trong M1.
- Không implicit create parent directory.
- Đọc/search có byte/result/depth limit.

## Shell policy

M1 dùng direct process execution:

```json
{
  "command": "git",
  "args": ["status", "--short"]
}
```

Không tạo command string bằng concat/eval. Command policy có thể cấu hình:

```yaml
shell:
  enabled: true
  denyCommands:
    - sudo
    - shutdown
    - reboot
  timeoutMs: 30000
  maxTimeoutMs: 120000
  maxOutputBytes: 1048576
```

Policy phải kiểm tra executable đã resolve, không chỉ prefix của một chuỗi command. Các lệnh có network/side effect rộng vẫn có thể chạy nếu user chủ động cấp execute permission; dự án không giả định mọi shell command là an toàn.

## Error và logging

Denied operation trả `PERMISSION_DENIED` hoặc error domain tương ứng. Không log token, environment secret, file content đầy đủ hoặc command arguments nhạy cảm theo mặc định.

## Test boundary bắt buộc

- traversal `..`;
- absolute-path escape;
- symlink escape;
- sibling-prefix trap;
- deny subtree;
- write khi chỉ có read;
- delete khi delete=false;
- execute khi execute=false;
- denied command không được spawn;
- workspace root delete luôn bị chặn.

Xem chi tiết test tại [`testing/m1-local-mcp.md`](testing/m1-local-mcp.md).
