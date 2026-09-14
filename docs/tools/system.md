# `system`

## Trạng thái

**Đã hoàn tất.** Issue #4 được triển khai và merge qua PR #12. MCP tool `system` có hai action `info` và `which`, bao gồm schema, structured result, annotation read-only, resolver executable đa nền tảng và kiểm thử qua MCP.

## Mục đích

`system` cung cấp thông tin máy local và khả năng tra executable theo cách read-only. Tool này không quản lý process và không thay đổi hệ thống.

## Actions

### `info`

Input:

```json
{ "action": "info" }
```

Output conceptual:

```json
{
  "platform": "darwin",
  "arch": "arm64",
  "hostname": "DoCT-MAC",
  "runtime": {
    "name": "bun",
    "version": "1.4.2"
  }
}
```

M1 chỉ trả metadata hữu ích cho tool execution/debug. Không dump environment variables, username, network interface hoặc thông tin nhạy cảm không cần thiết.

### `which`

Input:

```json
{
  "action": "which",
  "command": "git"
}
```

Output:

```json
{
  "found": true,
  "path": "/usr/bin/git"
}
```

Nếu không tìm thấy executable, đây là kết quả hợp lệ (`found: false`) thay vì internal error.

## Permission và annotations

`system` là read-only:

```text
readOnlyHint: true
destructiveHint: false
openWorldHint: false
```

`which` chỉ tra executable path; không chạy command để suy ra kết quả.

## Cross-platform

Implementation hỗ trợ Windows, macOS và Linux. Resolver tách logic theo target platform, dùng `PATH`/`PATHEXT` phù hợp, loại directory khỏi kết quả và hỗ trợ symlink tới executable file.

## Test bắt buộc

- `info` trả platform/arch/runtime có kiểu ổn định.
- `which` tìm thấy một executable chắc chắn có trong môi trường test phù hợp.
- `which` trả `found: false` cho tên ngẫu nhiên không tồn tại.
- command rỗng hoặc chứa input không hợp lệ bị schema reject.
- `info` không trả environment secrets.
- Windows `PATHEXT` và POSIX path resolution có regression test độc lập.
- directory không được coi là executable; symlink tới executable file được chấp nhận.

## Acceptance criteria

MCP client gọi được cả hai action qua `tools/call` và nhận structured result không phụ thuộc vào format log của OS.

## History

| Ngày | Thay đổi | Lý do | Trạng thái |
|---|---|---|---|
| 2026-09-14 | Triển khai `system` với `info`, `which` qua PR #12 | Hoàn thiện capability system read-only và executable lookup đa nền tảng | complete |
