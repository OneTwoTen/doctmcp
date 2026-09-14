# `filesystem.write`

## Mục đích

Nhóm các thao tác thay đổi filesystem nhưng không mang semantics xoá trực tiếp. Tool này tách khỏi `filesystem.read` và `filesystem.delete` để giữ permission/risk boundary rõ.

## Actions

### `write`

Tạo mới hoặc ghi nội dung file.

```json
{
  "action": "write",
  "workspace": "doctmcp",
  "path": "tmp/example.txt",
  "content": "hello",
  "overwrite": false,
  "createParents": false
}
```

Quy tắc M1:

- mặc định `overwrite: false`;
- nếu file tồn tại và không cho overwrite, trả `ALREADY_EXISTS`;
- giới hạn input size;
- `createParents` mặc định false để tránh tạo cây thư mục ngoài dự kiến;
- không follow symlink để ghi ra ngoài workspace.

### `patch`

Sửa có điều kiện để giảm nguy cơ overwrite nhầm khi file đã đổi.

M1 ưu tiên patch dạng exact replacement đơn giản:

```json
{
  "action": "patch",
  "workspace": "doctmcp",
  "path": "README.md",
  "oldText": "old value",
  "newText": "new value",
  "expectedOccurrences": 1
}
```

Quy tắc:

- `oldText` phải tồn tại đúng số lần mong đợi;
- mismatch trả error, không ghi một phần;
- write theo kiểu atomic khi platform/implementation cho phép;
- unified diff/full patch engine là scope sau nếu chưa cần.

### `mkdir`

```json
{
  "action": "mkdir",
  "workspace": "doctmcp",
  "path": "tmp/nested",
  "recursive": false
}
```

Mặc định không recursive. Nếu target tồn tại, semantics phải ổn định và test rõ (M1 đề xuất trả success với `created: false` khi target đã là directory, lỗi nếu là file).

### `move`

```json
{
  "action": "move",
  "workspace": "doctmcp",
  "from": "tmp/a.txt",
  "to": "tmp/b.txt",
  "overwrite": false
}
```

Quy tắc:

- source và destination phải cùng nằm trong workspace được phép;
- mặc định không overwrite;
- destination tồn tại trả `ALREADY_EXISTS` nếu không cho overwrite;
- không dùng `move` như cách bypass `filesystem.delete` policy;
- cross-filesystem move fallback copy+delete chưa cần trong M1 nếu làm semantics phức tạp; có thể trả error rõ.

## Permission và annotations

Capability yêu cầu: `write`.

```text
readOnlyHint: false
destructiveHint: true
openWorldHint: false
```

Tool có thể thay thế nội dung hiện có hoặc di chuyển file, vì vậy `destructiveHint` là `true`. Annotation ở mức tool không thay thế policy/approval. M1 mặc định overwrite false để giảm rủi ro.

## Atomicity

Không được để file ở trạng thái một phần nếu validation/patch thất bại. `overwrite: true` và `patch` dùng temp file + rename, đồng thời giữ permission mode của file hiện có. Tạo file mới dùng `wx` để bảo đảm no-clobber; hiện chưa cam kết crash-atomic cho new-file creation. Nếu không đảm bảo atomic trên platform cụ thể, tài liệu implementation phải nêu rõ.

## Test bắt buộc

- write file mới thành công;
- write existing file bị chặn khi overwrite false;
- patch đúng một occurrence;
- patch mismatch không thay file;
- mkdir existing directory có semantics ổn định;
- move source → destination thành công;
- move không overwrite mặc định;
- traversal/symlink escape bị chặn cho source và destination;
- workspace chỉ có read permission bị từ chối;
- input vượt size limit bị từ chối trước khi ghi.

## Acceptance criteria

Không action nào có thể sửa file ngoài workspace hoặc âm thầm overwrite dữ liệu khi caller không yêu cầu rõ.

## Trạng thái implementation

Đang triển khai trong issue #6: schema discriminated, bốn action, giới hạn input, atomic write/patch, workspace resolver và MCP contract test đã có trên nhánh làm việc.

## History

| Ngày | Thay đổi | Lý do | Trạng thái |
|---|---|---|---|
| 2026-09-14 | Triển khai `filesystem.write` với `write`, `patch`, `mkdir`, `move` | Hoàn thiện capability write read-only tách khỏi `filesystem.delete` | in-progress |
