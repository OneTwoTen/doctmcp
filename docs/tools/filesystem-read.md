# `filesystem.read`

## Mục đích

Nhóm mọi thao tác filesystem **read-only** có cùng permission/risk boundary. Tool luôn resolve path qua workspace và không được đọc ngoài root đã cho phép.

Tool có bốn action: `read`, `list`, `stat`, `search`. Tất cả đều cần capability `read`.

## `read`

Input:

```json
{
  "action": "read",
  "workspace": "doctmcp",
  "path": "package.json",
  "offset": 0,
  "limit": 65536
}
```

Semantics M1:

- `path` là path tương đối theo workspace;
- `offset` và `limit` dùng **byte semantics**;
- `offset` mặc định `0`;
- `limit` mặc định `65536` byte (64 KiB), tối đa `1048576` byte (1 MiB) mỗi call;
- file binary có NUL byte trong vùng kiểm tra hoặc text không phải UTF-8 hợp lệ bị từ chối với `INVALID_INPUT`;
- nếu chunk kết thúc giữa một sequence UTF-8 multi-byte, tool lùi boundary về ký tự hoàn chỉnh gần nhất thay vì trả UTF-8 lỗi;
- caller dùng `nextOffset` cho lần đọc tiếp theo, không tự tính `offset + limit`.

Output:

```json
{
  "action": "read",
  "path": "package.json",
  "content": "...",
  "size": 1234,
  "offset": 0,
  "limit": 65536,
  "bytesRead": 1234,
  "nextOffset": 1234,
  "truncated": false
}
```

`size` là kích thước file theo byte. `bytesRead` là số byte UTF-8 hoàn chỉnh thực sự trả về.

## `list`

Input:

```json
{
  "action": "list",
  "workspace": "doctmcp",
  "path": "apps",
  "recursive": false,
  "limit": 200,
  "maxDepth": 5
}
```

- `path` mặc định `.`;
- non-recursive là mặc định;
- `limit` mặc định `200`, tối đa `1000` entry;
- `maxDepth` mặc định `5`, tối đa `10`, chỉ có ý nghĩa khi `recursive: true`;
- kết quả được sort ổn định theo tên trong từng thư mục;
- khi đạt `limit`, `truncated: true`;
- deny subtree bị loại khỏi kết quả;
- symlink ra ngoài workspace hoặc trỏ vào deny subtree không được expose như một đường đọc hợp lệ.

Mỗi entry:

```json
{
  "name": "server",
  "path": "apps/server",
  "type": "directory"
}
```

`type` là `file | directory | symlink | other`; file có thể kèm `size`.

## `stat`

Input:

```json
{
  "action": "stat",
  "workspace": "doctmcp",
  "path": "README.md"
}
```

`path` mặc định `.`. Output chỉ chứa metadata portable cần thiết:

- `type`;
- `size`;
- `mtimeMs`;
- `birthtimeMs`;
- `isSymbolicLink`.

`stat` dùng metadata của final entry để phân biệt symlink với target, nhưng resolver vẫn kiểm tra canonical target để enforce workspace/deny boundary.

## `search`

Input:

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

- literal case-sensitive substring search; chưa hỗ trợ regex/glob;
- `path` mặc định `.`;
- `maxResults` mặc định `50`, tối đa `200`;
- tối đa `1000` file được scan trong một call;
- bỏ qua file lớn hơn `2 MiB`;
- tổng byte nội dung được scan tối đa `20 MiB`;
- binary/invalid UTF-8 bị bỏ qua;
- preview mỗi dòng match tối đa `200` ký tự;
- đạt giới hạn result/file/bytes thì trả `truncated: true`;
- search có kiểm tra cancellation và map sang `TIMEOUT`.

Mỗi match gồm:

```json
{
  "path": "apps/agent/src/server.ts",
  "lineNumber": 12,
  "line": "const server = new McpServer(...)"
}
```

Internal symlink file có thể được search nếu canonical target vẫn nằm trong workspace và không bị deny. Khi root traversal là một symlink directory nội bộ, queue giữ cả lexical `operationPath` và `canonicalPath`; deny được kiểm tra trên canonical child để alias symlink không thể bypass deny subtree.

## Path resolution và security

Mọi action bắt đầu bằng cùng resolver:

```text
workspace root
 + relative path
 -> normalize
 -> canonicalize existing ancestor/target
 -> workspace containment
 -> deny policy
 -> capability read
 -> operation
```

Các boundary bắt buộc:

- từ chối `../` traversal;
- từ chối absolute path;
- từ chối symlink escape ra ngoài workspace;
- từ chối direct access vào deny subtree;
- traversal qua symlink directory phải tiếp tục enforce deny bằng canonical path;
- path không tồn tại trả `PATH_NOT_FOUND`;
- `read` trên directory và `list` trên regular file trả `INVALID_INPUT`.

## Permission và annotations

```text
readOnlyHint: true
destructiveHint: false
idempotentHint: true
openWorldHint: false
```

Permission cần capability `read` của workspace/path. Annotations chỉ là MCP metadata; resolver/capability local mới là enforcement.

## Error

Các code chính:

- `WORKSPACE_NOT_FOUND`;
- `PATH_NOT_FOUND`;
- `PATH_OUTSIDE_WORKSPACE`;
- `PERMISSION_DENIED`;
- `INVALID_INPUT`;
- `TIMEOUT`.

## Test coverage M1

Test suite cần bao phủ:

- success cho cả 4 action trên temp workspace;
- MCP contract call cho cả `read`, `list`, `stat`, `search`;
- traversal, absolute path và symlink escape;
- nested deny subtree và symlink-directory deny bypass;
- binary + invalid UTF-8;
- UTF-8 multi-byte chunk boundary;
- read max input limit;
- recursive list depth/result truncation;
- search result/file/byte limits và cancellation;
- workspace không có capability `read`.

## Acceptance criteria

Không action nào thay đổi filesystem; mọi operation đi qua workspace resolver/permission dùng chung; output/traversal có giới hạn rõ; symlink không thể dùng để thoát workspace hoặc bypass deny policy.
