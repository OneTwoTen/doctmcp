# Plan issue #5 — Implement tool `filesystem.read` (`read`, `list`, `stat`, `search`)

## Mục tiêu

Triển khai capability read-only filesystem cho Local MCP Runtime (`apps/agent`) với 4 action (`read`, `list`, `stat`, `search`), tích hợp chặt chẽ với Workspace Path Resolver và Permission Core đã chốt tại M1.2.

## Phạm vi

- Schema discriminated union theo `action`: `read`, `list`, `stat`, `search`.
- `read`: Hỗ trợ `offset` và `limit` theo byte semantics, `bytesRead`/`nextOffset`, chặn binary/invalid UTF-8, xử lý an toàn UTF-8 multi-byte chunk boundary và giới hạn tối đa 1 MiB mỗi call.
- `list`: Mặc định non-recursive, hỗ trợ `recursive: true` có `maxDepth` và `limit`, sắp xếp ổn định, lọc deny subtree và symlink escape bằng cả lexical/canonical path.
- `stat`: Metadata portable (`type`, `size`, `mtimeMs`, `birthtimeMs`, `isSymbolicLink`), phân biệt symlink và regular targets.
- `search`: Literal text search, giới hạn result/file/bytes, bỏ qua binary/file quá lớn, hỗ trợ cancellation và bảo vệ deny subtree khi traversal qua symlink directory.
- Annotations: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`.
- Tầng MCP integration: đăng ký tool và test đủ cả 4 action qua MCP protocol.
- Local smoke test: đăng ký `workspace`, `system`, `filesystem.read`, `filesystem.write` và kiểm tra round-trip write → read sau khi đồng bộ `main`.

## Tiêu chí nghiệm thu

- Tất cả action đi qua `WorkspacePathResolver.resolve(workspace, path, "read")`.
- Path traversal (`../`), absolute path, symlink escape và deny subtree đều bị chặn với mã lỗi domain thích hợp (`PATH_OUTSIDE_WORKSPACE`, `PERMISSION_DENIED`).
- Symlink directory nội bộ không thể dùng để bypass deny subtree.
- Target không tồn tại trả `PATH_NOT_FOUND`. Target sai loại (ví dụ `read` directory, `list` regular file) trả `INVALID_INPUT`.
- Không action nào thay đổi filesystem.
- Read chunk không làm hỏng UTF-8 multi-byte; caller có `bytesRead`/`nextOffset` để paging an toàn.
- Search có giới hạn số file, tổng bytes, result và hỗ trợ cancellation.
- `scripts/test-local-mcp.ts` kiểm tra thành công các tool đã triển khai cùng nhau.
- `bun run check`, `bun run typecheck`, `bun test` xanh 100%.

## History

| Ngày | Thay đổi | Lý do | Trạng thái |
|---|---|---|---|
| 2026-09-14 | Hoàn thiện implementation và test suite cho issue #5 | Đáp ứng tiêu chí nghiệm thu chính của M1.4 | complete |
| 2026-09-14 | Harden UTF-8 boundary, search limits, cancellation, nested deny và internal symlink search | Xử lý review về correctness, resource bounds và security | complete |
| 2026-09-14 | Chặn deny bypass qua symlink directory bằng lexical + canonical traversal state | Giữ deny policy đúng khi path alias trỏ tới directory nội bộ | complete |
| 2026-09-14 | Merge `main`, giữ `system`, `filesystem.read`, `filesystem.write`, đồng bộ docs và local MCP smoke test | PR #12/#14 đã vào `main`; cần integration state thống nhất trước khi merge PR #13 | complete |
