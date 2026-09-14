# Plan issue #3 — Workspace registry, path resolver và permission core

## Mục tiêu

Hoàn thiện foundation dùng chung cho các local tool: registry workspace đã cấu hình, resolver path an toàn và capability checker được enforce tại local runtime. Đồng thời expose tool MCP `workspace` với action `list` và `get`.

## Phạm vi

- `WorkspaceRegistry` lưu metadata workspace, canonicalize root và deny subtree.
- `WorkspacePathResolver` resolve path tương đối, chống traversal, absolute path, sibling-prefix và symlink escape.
- `PermissionChecker` kiểm tra `read`, `write`, `delete`, `execute`; deny subtree thắng allow.
- Tool `workspace` gọi được qua MCP.
- Test dùng temp directory, gồm cả symlink escape khi hệ điều hành hỗ trợ.

Không làm filesystem tools, shell tools, config file loader hoặc public/server transport trong issue này.

## Contract chính

```text
workspace id + relative path
  -> workspace root canonical
  -> reject absolute/.. path
  -> canonicalize existing target hoặc existing parent
  -> containment bằng path.relative
  -> deny subtree
  -> capability check
```

Workspace không được tự động thêm từ home/current directory. Root phải tồn tại khi registry được tạo để boundary security không mơ hồ.

## Tiêu chí nghiệm thu

- `workspace.list/get` success và unknown id qua MCP.
- Resolver xử lý path bình thường và `.`.
- Từ chối `..`, absolute path, sibling-prefix trap và symlink escape.
- Capability thiếu bị từ chối; deny subtree thắng allow.
- API dùng chung, filesystem/shell về sau không cần tự lặp lại path/permission logic.
- `bun run check`, `bun run typecheck`, `bun test` xanh.

## History

| Ngày | Thay đổi | Lý do | Trạng thái |
|---|---|---|---|
| 2026-09-14 | Khởi tạo plan cho issue #3 | Triển khai M1.2 theo roadmap và acceptance test của issue | complete |
