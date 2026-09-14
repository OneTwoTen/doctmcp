# `workspace`

## Mục đích

`workspace` cung cấp danh sách root local đã được người dùng cho phép và metadata cần thiết để các tool khác resolve path. Tool này **không** cho phép duyệt toàn bộ filesystem của máy.

## Actions

### `list`

Trả các workspace mà local runtime hiện expose.

Input:

```json
{ "action": "list" }
```

Output conceptual:

```json
{
  "workspaces": [
    {
      "id": "doctmcp",
      "name": "doctmcp",
      "path": "/Users/user/Projects/doctmcp",
      "read": true,
      "write": true,
      "execute": true
    }
  ]
}
```

Đường dẫn tuyệt đối có thể được trả trong local-only M1 để debug, nhưng sau này public surface có thể cần giảm metadata này.

### `get`

Input:

```json
{
  "action": "get",
  "workspace": "doctmcp"
}
```

Trả metadata của đúng workspace hoặc `WORKSPACE_NOT_FOUND`.

## Workspace identity

- `id` là định danh ổn định trong config local, không dùng path làm id.
- `name` là display metadata.
- `root`/`path` phải được normalize khi load config.
- Workspace không được overlap theo cách tạo permission ambiguity nếu policy chưa có rule ưu tiên rõ.

## Permission

Tool này read-only. Nó chỉ mô tả capability đã cấu hình, không thay đổi policy.

MCP annotations dự kiến:

```text
readOnlyHint: true
destructiveHint: false
openWorldHint: false
```

## Security

- Không tự động thêm current directory/home làm workspace nếu chưa cấu hình.
- Không expose secret/token trong workspace metadata.
- Symlink root cần resolve/canonicalize trước khi dùng làm security boundary.

## Test bắt buộc

- `list` trả đúng workspace đã cấu hình.
- `get` trả workspace hợp lệ.
- `get` với id không tồn tại trả `WORKSPACE_NOT_FOUND`.
- schema từ chối action không hợp lệ và field thừa nếu dự án chọn strict schema.
- root được normalize nhất quán trên Windows/macOS/Linux.

## Acceptance criteria

`workspace` đủ hoàn tất khi filesystem/shell có thể dựa vào workspace id để resolve root mà không cần tự đọc config hoặc duplicate permission logic.
