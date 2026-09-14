# Thiết kế M1 — Local MCP

## Trạng thái

**Approved direction, đang triển khai.** Tài liệu này chốt phạm vi kỹ thuật cho milestone M1. M1.1 (#2), M1.2 (#3), M1.3 (#4) và M1.5 (#6) đã hoàn tất; workspace registry, path resolver, permission core, tool `workspace`, tool `system` và tool `filesystem.write` đã có trên `main` sau khi các PR tương ứng được merge. Các filesystem/shell tool còn lại, public server, device pairing và ChatGPT chưa có.

## Mục tiêu

M1 phải chứng minh local runtime là một MCP server thực sự, có tool catalog nhỏ, permission boundary rõ và test được hoàn toàn offline.

```text
MCP test client
      │
      │ initialize / tools/list / tools/call
      ▼
Local MCP Server
      │
      ├─ workspace
      ├─ system
      ├─ filesystem.read
      ├─ filesystem.write
      ├─ filesystem.delete
      └─ shell.exec
```

## Nguyên tắc thiết kế tool

Dự án dùng nguyên tắc:

> **Tool = capability / permission boundary. Action = thao tác con có cùng domain, schema, mức quyền và mức rủi ro.**

Không tạo một tool cho mỗi thao tác nhỏ, nhưng cũng không tạo mega-tool kiểu `local(action=...)` chứa cả đọc file, xoá file và thực thi lệnh.

M1 chốt **6 tool**:

| Tool | Action | Tính chất |
|---|---|---|
| `workspace` | `list`, `get` | read-only |
| `system` | `info`, `which` | read-only |
| `filesystem.read` | `read`, `list`, `stat`, `search` | read-only |
| `filesystem.write` | `write`, `patch`, `mkdir`, `move` | thay đổi local |
| `filesystem.delete` | không cần action | destructive |
| `shell.exec` | không cần action | execute / side effect rộng |

Các tool `device`, `job`, `process`, `git.*`, `docker.*` **không thuộc M1**.

## MCP là data plane

Không tạo RPC song song cho tool execution. Các thao tác sau phải dùng semantics MCP trực tiếp:

```text
tools/list
tools/call
CallToolResult
JSON-RPC error/cancellation tương ứng
```

`packages/protocol` chỉ được dùng về sau cho control plane ngoài MCP như device identity, authentication, pairing, heartbeat hoặc connection metadata. Scaffold `command.request` / `command.result` hiện tại phải được loại bỏ hoặc thu hẹp trước khi M2 phát triển tiếp.

## Schema

Tool có nhiều action phải dùng schema phân biệt theo `action`, không dùng một object lớn với nhiều field optional không liên quan.

Ví dụ conceptual:

```ts
z.discriminatedUnion("action", [
  z.object({ action: z.literal("read"), workspace: z.string(), path: z.string() }),
  z.object({ action: z.literal("list"), workspace: z.string(), path: z.string().optional() }),
]);
```

Mỗi action phải reject field/combination không hợp lệ ở validation layer trước khi chạm filesystem/process.

## Workspace và đường dẫn

Tool filesystem không nhận quyền truy cập toàn máy theo mặc định. Input dùng `workspace` + `path` tương đối khi có thể.

Luồng chuẩn:

```text
workspace id
  -> resolve workspace root
  -> normalize/canonicalize path
  -> kiểm tra path nằm trong root
  -> kiểm tra deny rules
  -> thực thi
```

Không cho phép `..`, symlink hoặc path normalization thoát khỏi root được cấp quyền. Permission được enforce ở local runtime; MCP annotations chỉ là metadata hỗ trợ client.

Sau M1.2, resolver giữ riêng:

- `operationPath`: path lexical tuyệt đối mà filesystem operation thực sự dùng;
- `canonicalPath`: path canonical dùng cho containment/deny/permission.

Với destructive operation trên symlink, chỉ được unlink chính symlink khi parent thực của final entry vẫn nằm trong workspace; intermediate symlink không được dùng để đưa thao tác ra ngoài workspace.

## Result và error

Tool trả structured content ổn định, không phụ thuộc vào log text. Error domain tối thiểu cần phân biệt:

- `INVALID_INPUT`;
- `WORKSPACE_NOT_FOUND`;
- `PATH_NOT_FOUND`;
- `PATH_OUTSIDE_WORKSPACE`;
- `PERMISSION_DENIED`;
- `ALREADY_EXISTS`;
- `TIMEOUT`;
- `OUTPUT_LIMIT_EXCEEDED`;
- `PROCESS_FAILED`;
- `INTERNAL_ERROR`.

Không gửi stack trace, credential, environment secret hoặc nội dung nhạy cảm vào MCP result mặc định.

## Tool annotations

Khai báo annotations từ đầu khi SDK hỗ trợ:

- `workspace`, `system`, `filesystem.read`: `readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: false`;
- `filesystem.write`: `readOnlyHint: false`, `destructiveHint: true`, `openWorldHint: false`;
- `filesystem.delete`: `readOnlyHint: false`, `destructiveHint: true`, `openWorldHint: false`;
- `shell.exec`: không được coi annotations là security enforcement; hành vi phụ thuộc command nên permission local vẫn là nguồn quyết định.

`idempotentHint` chỉ bật cho operation thực sự có semantics idempotent rõ ràng.

## Shell M1

M1 chỉ cần execution đồng bộ có giới hạn:

- `cwd` phải resolve qua workspace;
- timeout bắt buộc có default và max;
- stdout/stderr có output limit;
- process phải được terminate khi timeout/cancel;
- environment truyền vào phải có policy rõ, không dump toàn bộ environment ra result;
- shell execution phải đi qua permission layer.

Không tạo custom `job` trong M1. Long-running execution là scope sau; ưu tiên đánh giá MCP Tasks extension khi thực sự cần.

## Test strategy

Viết test đỏ trước implementation cho behavior mới khi khả thi. M1 cần ba tầng:

1. **Schema/unit test**: valid/invalid action, path, limit, timeout.
2. **Tool integration test**: chạy trên temp workspace thật, không đụng home directory của developer.
3. **MCP contract test**: MCP client thật gọi `tools/list` và `tools/call` vào local server.

Không mock MCP layer cho acceptance test cuối M1.

## Acceptance criteria M1

- Local MCP server initialize thành công với MCP client test.
- `tools/list` trả đúng 6 tool và schema tương ứng.
- Mỗi tool có ít nhất một success test qua `tools/call`.
- Mỗi boundary quan trọng có denied/error test.
- Path traversal và symlink escape bị chặn.
- `filesystem.delete` không xoá ngoài workspace.
- `shell.exec` có timeout và output limit được kiểm thử.
- Không cần database, public server, network Internet, pairing hoặc ChatGPT.
- `bun run check`, typecheck và test đều xanh.
- Tài liệu tool khớp implementation thực tế.

## Ngoài phạm vi M1

- device list/get/ping;
- pairing và credential;
- WebSocket bridge;
- public MCP endpoint;
- ChatGPT integration;
- async job manager;
- process manager;
- Git/Docker/database/browser tools;
- policy UI hoặc approval UI.

## History

| Ngày | Thay đổi | Lý do | Trạng thái |
|---|---|---|---|
| 2026-09-14 | Chốt Local MCP-first và catalog 6 tool theo capability/risk boundary | Giảm scope, dễ test trước khi thêm transport và ChatGPT | approved |
| 2026-09-14 | Hoàn tất issue #3 ở lớp workspace/permission foundation qua PR #11 | Tạo boundary dùng chung trước khi triển khai filesystem và shell tool | complete |
| 2026-09-14 | Hoàn tất issue #6 với tool `filesystem.write` qua PR #14 | Bổ sung capability thay đổi filesystem với no-clobber, permission boundary và MCP contract coverage | complete |
| 2026-09-14 | Hoàn tất issue #4 với tool `system` (`info`, `which`) | Bổ sung capability read-only tiếp theo trên Local MCP foundation | complete |
