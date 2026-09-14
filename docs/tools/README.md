# Tool catalog M1

Thư mục này mô tả contract của các MCP tool local. Mỗi tài liệu là nguồn tham chiếu cho schema, permission, behavior, error và test của tool tương ứng.

## Catalog

| Tool | Tài liệu | Risk |
|---|---|---|
| `workspace` | [workspace.md](workspace.md) | read-only |
| `system` | [system.md](system.md) | read-only |
| `filesystem.read` | [filesystem-read.md](filesystem-read.md) | read-only |
| `filesystem.write` | [filesystem-write.md](filesystem-write.md) | write |
| `filesystem.delete` | [filesystem-delete.md](filesystem-delete.md) | destructive |
| `shell.exec` | [shell-exec.md](shell-exec.md) | execute / high-risk |

## Quy ước chung

- Tool name phản ánh capability boundary, không phản ánh file/module implementation.
- Action chỉ dùng khi các thao tác con có cùng domain và risk boundary.
- Schema action dùng discriminated union.
- Tool không tự bypass workspace/permission layer.
- Result là structured data; log chỉ phục vụ diagnostics local.
- Error phải map về error code ổn định được định nghĩa trong spec M1.
- Annotation MCP chỉ là hint; local permission mới là enforcement.

Xem thiết kế tổng thể tại [`../specs/2026-09-14-m1-local-mcp-design.md`](../specs/2026-09-14-m1-local-mcp-design.md).
