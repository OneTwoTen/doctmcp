# `filesystem.read`

## Mục đích

Nhóm mọi thao tác filesystem **read-only** có cùng permission/risk boundary. Tool luôn resolve path qua workspace và không được đọc ngoài root đã cho phép.

## Actions

### `read`

Input conceptual:

```json
{
  "action": "read",
  "workspace": "doctmcp",
  "path": "package.json",
  "offset": 0,
  "limit": 65536
}
```

- `path` là path tương đối theo workspace.
- `offset`/`limit` là byte hoặc semantic unit phải được implementation chốt nhất quán; M1 ưu tiên byte để dễ giới hạn output.
- Có max read size cấu hình được; không đọc file không giới hạn vào memory/result.
- Binary file phải được từ chối rõ hoặc trả metadata thay vì decode ngầm thành UTF-8 lỗi.

Output conceptual:

```json
{
  "path": "package.json",
  "content": "...",
  "size": 1234,
  "truncated": false
}
```

### `list`

Input:

```json
{
  "action": "list",
  "workspace": "doctmcp",
  "path": "apps",
  "recursive": false,
  "limit": 200
}
```

M1 mặc định không recursive. Nếu `recursive: true`, phải có depth/result limit.

Mỗi entry tối thiểu:

```json
{
  "name": "server",
  "path": "apps/server",
  "type": "directory"
}
```

Không follow symlink ra ngoài workspace.

### `stat`

Input:

```json
{
  "action": "stat",
  "workspace": "doctmcp",
  "path": "README.md"
}
```

Output chỉ chứa metadata portable cần thiết: type, size, timestamps nếu có, symlink flag. Không cố chuẩn hoá toàn bộ permission bits giữa mọi OS trong M1.

### `search`

M1 search nội dung text trong một workspace/path cho trước, có giới hạn rõ.

```json
{
  "action": "search",
  "workspace": "doctmcp",
  "path": "apps",
  "query": "McpServer",
  "maxResults": 50
}
```

Scope M1:

- literal text search trước; regex/glob nâng cao có thể để sau;
- bỏ qua binary và file quá lớn theo policy;
- không follow symlink escape;
- giới hạn số file/result và tổng bytes đọc;
- result gồm path + line/preview ngắn đủ để định vị, không trả toàn bộ file.

## Path resolution bắt buộc

Mọi action phải dùng cùng một resolver:

```text
workspace root
 + relative path
 -> normalize
 -> canonicalize existing ancestor/target phù hợp
 -> đảm bảo vẫn nằm trong workspace root
 -> deny policy
 -> operation
```

Phải có test cho:

- `../` traversal;
- absolute path khi contract không cho phép;
- symlink trong workspace trỏ ra ngoài;
- path không tồn tại;
- directory được truyền cho `read`;
- file được truyền cho `list`.

## Permission và annotations

```text
readOnlyHint: true
destructiveHint: false
openWorldHint: false
```

Permission cần capability `read` của workspace/path.

## Error

Dùng các code phù hợp: `WORKSPACE_NOT_FOUND`, `PATH_NOT_FOUND`, `PATH_OUTSIDE_WORKSPACE`, `PERMISSION_DENIED`, `INVALID_INPUT`, `OUTPUT_LIMIT_EXCEEDED`.

## Test bắt buộc

Ngoài path security test, mỗi action cần success test trên temp workspace thật. `search` cần test limit/truncation. `read` cần test file vượt max size và UTF-8 invalid/binary policy.

## Acceptance criteria

Không có action nào trong tool này làm thay đổi filesystem; mọi path đều đi qua resolver/permission dùng chung và result có giới hạn kích thước.
