# Thiết kế M1 — Local MCP

## Trạng thái

**Hoàn tất.** M1 đã đủ 8/8 work item: workspace registry, path resolver, permission core, đủ 6 tool `workspace`, `system`, `filesystem.read`, `filesystem.write`, `filesystem.delete`, `shell.exec` và MCP acceptance suite toàn milestone. Issue #9 / PR #17 bổ sung catalog factory dùng chung và acceptance test bằng MCP client/server thật; quality gate gồm `bun run check`, `bun run typecheck`, `bun test` và Windows `shell.exec` regression đã xanh. Public server, custom WebSocket transport, device pairing và ChatGPT thuộc milestone sau.

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

`packages/protocol` chỉ được dùng về sau cho control plane ngoài MCP như device identity, authentication, pairing, heartbeat hoặc connection metadata. Scaffold `command.request` / `command.result` không được quay lại dưới vai trò tool-execution protocol khi M2 phát triển tiếp.

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

Với traversal read-only qua thư mục symlink nội bộ, implementation phải tiếp tục mang theo canonical path cho từng child để deny subtree không thể bị bypass bằng alias symlink. Với destructive operation trên symlink, chỉ được unlink chính symlink khi parent thực của final entry vẫn nằm trong workspace; intermediate symlink không được dùng để đưa thao tác ra ngoài workspace.

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
- `shell.exec`: `readOnlyHint: false`, `destructiveHint: true`, `openWorldHint: true`; annotation không thay thế local permission/policy.

`idempotentHint` chỉ bật cho operation thực sự có semantics idempotent rõ ràng.

## Shell M1

M1 chỉ cần execution đồng bộ có giới hạn:

- native executable dùng direct process spawn bằng `command` + `args`, không implicit raw shell string hoặc expose `shell:true` cho caller;
- Windows `.cmd`/`.bat` shim dùng constrained `cmd.exe` bridge nội bộ với validation chặt, không biến API thành raw shell mode;
- `cwd` phải resolve qua workspace với capability `execute`;
- timeout bắt buộc có default và max;
- stdout/stderr có output limit;
- timeout, cancel và output-limit phải terminate process tree best-effort, không chỉ direct child;
- environment child dùng local allowlist, không inherit toàn bộ `process.env` mặc định;
- executable phải được resolve trước spawn và command deny policy phải kiểm tra tên đã normalize/resolved, không chỉ prefix của raw command string;
- exit code khác `0` vẫn là structured process result.

Không tạo custom `job` trong M1. Long-running execution là scope sau; ưu tiên đánh giá MCP Tasks extension khi thực sự cần.

## Test strategy

Viết test đỏ trước implementation cho behavior mới khi khả thi. M1 có ba tầng:

1. **Schema/unit test**: valid/invalid action, path, limit, timeout.
2. **Tool integration test**: chạy trên temp workspace thật, không đụng home directory của developer.
3. **MCP contract/acceptance test**: MCP client thật gọi `tools/list` và `tools/call` vào local server.

Acceptance suite cuối nằm tại `apps/agent/src/m1-acceptance.test.ts` và dùng `createLocalToolCatalog()` làm nguồn đăng ký 6 tool. `bun test` tự discover suite này; `bun run test:local` chỉ là lệnh tiện để chạy riêng acceptance suite.

Không mock MCP layer cho acceptance test cuối M1. Regression process-tree/cancellation/Windows bridge của `shell.exec` tiếp tục được khóa trong các test chuyên biệt để acceptance test không duplicate platform matrix.

## Acceptance criteria M1

- Local MCP server initialize thành công với MCP client test.
- `tools/list` trả đúng 6 tool, schema/action và annotations tương ứng.
- Mỗi tool có ít nhất một success test qua `tools/call`.
- Unknown tool, invalid schema và domain error không làm server crash.
- Path traversal, symlink escape, deny subtree và denied capability bị chặn.
- `filesystem.delete` không xoá workspace root.
- `shell.exec` có timeout và output limit được kiểm thử qua MCP.
- Regression process-tree/cross-platform từ #8 tiếp tục xanh.
- Destructive test chỉ dùng temp workspace và cleanup ổn định.
- Không cần database, public server, network Internet, pairing hoặc ChatGPT.
- `bun run check`, `bun run typecheck`, `bun test` đều xanh.
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
| 2026-09-14 | Hoàn tất issue #4 với tool `system` (`info`, `which`) qua PR #12 | Bổ sung capability read-only tiếp theo trên Local MCP foundation | complete |
| 2026-09-14 | Hoàn tất issue #5 với tool `filesystem.read` qua PR #13 | Bổ sung read/list/stat/search có output limits, UTF-8 boundary và symlink/deny hardening | complete |
| 2026-09-14 | Hoàn tất issue #6 với tool `filesystem.write` qua PR #14 | Bổ sung capability thay đổi filesystem với no-clobber, permission boundary và MCP contract coverage | complete |
| 2026-09-14 | Hoàn tất issue #7 với tool `filesystem.delete` qua PR #15 | Tách destructive capability và khóa root/recursive/symlink/deny boundary | complete |
| 2026-09-14 | Hoàn tất issue #8 với `shell.exec` qua PR #16 | Bổ sung bounded execution, execute permission, cross-platform process-tree termination, constrained Windows batch bridge và CI Windows | complete |
| 2026-09-15 | Hoàn tất issue #9 qua PR #17 với catalog factory dùng chung và MCP acceptance suite đủ 6 tool | Khóa contract/schema/annotations, vertical flow, security regression và quality gate trước M2 | complete |
