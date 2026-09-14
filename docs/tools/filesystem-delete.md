# `filesystem.delete`

## Mục đích

Cô lập thao tác xoá thành một tool riêng vì đây là destructive capability. Không đặt delete chung với `filesystem.write` chỉ để giảm số lượng tool.

## Input

M1 không cần `action`:

```json
{
  "workspace": "doctmcp",
  "path": "tmp/example.txt",
  "recursive": false
}
```

Có thể bổ sung `expectedType: "file" | "directory"` nếu implementation cần thêm guard, nhưng không bắt buộc cho contract đầu tiên.

## Semantics

- `path` phải nằm trong workspace và qua permission resolver chung.
- `recursive` mặc định false.
- directory không rỗng + `recursive: false` phải bị từ chối.
- không follow symlink để xoá target ngoài workspace; nếu path chính là symlink, semantics phải là xoá link chứ không recursive vào target.
- root workspace (`path: "."`, empty path hoặc equivalent) **không bao giờ được xoá** qua tool này.
- path không tồn tại: M1 đề xuất trả `PATH_NOT_FOUND`, không giả vờ success, để model/client nhận biết trạng thái thực.
- không có `force` trong M1. Nếu cần sau này phải có lý do và policy riêng.

## Permission và annotations

Capability yêu cầu: delete/destructive permission riêng hoặc `write` + destructive policy rõ. Khuyến nghị local policy có cờ `delete` riêng dù workspace cho write.

```text
readOnlyHint: false
destructiveHint: true
openWorldHint: false
```

Không đặt `idempotentHint: true` trong M1 vì second call hiện trả `PATH_NOT_FOUND`, nên kết quả protocol không hoàn toàn giống lần đầu.

## Safety guard

Bắt buộc chặn:

- workspace root;
- path resolve ra ngoài workspace;
- symlink escape;
- recursive directory delete khi capability không cho phép;
- path nằm trong deny list;
- target đặc biệt mà OS/runtime xác định không phải file/directory thông thường nếu chưa hỗ trợ.

## Result

```json
{
  "deleted": true,
  "path": "tmp/example.txt",
  "type": "file"
}
```

Không trả nội dung file đã xoá vào result hoặc log.

## Test bắt buộc

- xoá file trong temp workspace thành công;
- xoá empty directory thành công;
- non-empty directory bị chặn khi recursive false;
- recursive delete chỉ chạy khi input + permission cho phép;
- workspace root luôn bị chặn;
- traversal và symlink escape bị chặn;
- denied path không thay đổi filesystem;
- path không tồn tại trả error có cấu trúc.

## Acceptance criteria

Tool chỉ xoá đúng target được caller chỉ định trong workspace, không có implicit recursive/force behavior và không thể dùng path trick để vượt permission boundary.
