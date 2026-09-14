# Kiểm thử M1 — Local MCP

## Mục tiêu

M1 chỉ được coi là hoàn tất khi có bằng chứng MCP client thật có thể discover và call toàn bộ catalog local. Test phải chạy offline và không phụ thuộc public server/ChatGPT.

## Nguyên tắc

- Red-first cho behavior mới khi khả thi.
- Dùng temp directory làm workspace test; không test destructive behavior trên repository/home thật.
- Không mock filesystem/process ở acceptance layer.
- Unit test có thể mock abstraction OS khi cần kiểm tra cross-platform edge case.
- Test phải kiểm tra state sau operation, không chỉ kiểm tra result string.

## Tầng 1 — Schema/unit

Mỗi discriminated action cần valid + invalid cases:

- thiếu field bắt buộc;
- action không tồn tại;
- empty command/path/query;
- negative/over-limit timeout, read size, maxResults;
- field chỉ thuộc action khác;
- overwrite/recursive default.

Path resolver unit tests:

- normal relative path;
- `.`;
- `..` traversal;
- absolute path;
- sibling-prefix trap (`/workspace-a` vs `/workspace-ab`);
- symlink escape;
- non-existing leaf với existing parent;
- Windows separator/drive semantics khi test environment hỗ trợ hoặc qua platform abstraction.

## Tầng 2 — Tool integration

Fixture chuẩn:

```text
temp-root/
├─ readme.txt
├─ src/
│  ├─ a.ts
│  └─ b.ts
├─ empty/
└─ denied/
```

Test matrix tối thiểu:

| Tool | Success | Boundary/error |
|---|---|---|
| `workspace` | list/get | unknown id |
| `system` | info/which | executable not found |
| `filesystem.read` | read/list/stat/search | traversal, binary/limit, not found |
| `filesystem.write` | write/patch/mkdir/move | overwrite false, patch mismatch, traversal |
| `filesystem.delete` | file/dir delete | root guard, recursive guard, denied path |
| `shell.exec` | stdout + exit code | denied command, timeout, output limit, cwd escape |

## Tầng 3 — MCP contract

Khởi tạo server bằng cùng registration code production và kết nối MCP client test.

### `tools/list`

Assert:

- đúng 6 tool;
- tên đúng;
- description không rỗng;
- input schema đúng root/object/action expectations;
- annotations đúng risk class đã chốt.

### `tools/call`

Ít nhất một success call cho mỗi tool phải đi qua MCP protocol thật, không gọi handler trực tiếp.

Ví dụ vertical flow:

```text
initialize
  -> tools/list
  -> workspace/list
  -> filesystem.write/write temp.txt
  -> filesystem.read/read temp.txt
  -> shell.exec direct command trong workspace
  -> filesystem.delete temp.txt
```

Sau flow, assert file thực sự đã bị xoá và server/session vẫn hoạt động.

### Invalid calls

- unknown tool;
- invalid action/schema;
- denied workspace/path;
- handler domain error;
- process timeout.

Client phải nhận error/result có cấu trúc và server không crash.

## Test isolation

- Mỗi test destructive có temp workspace riêng.
- Cleanup trong `finally`/test lifecycle kể cả khi assert fail.
- Không phụ thuộc executable tùy chọn nếu CI không đảm bảo có; ưu tiên Bun/runtime hiện có cho process smoke test và test command policy riêng bằng fixture/helper.
- Không cần network Internet.

## CI

M1 phải pass:

```sh
bun run check
bun run typecheck
bun test
```

Nếu bổ sung script test riêng, root `ci` phải bao phủ nó hoặc `bun test` phải discover suite tự động.

## Definition of done

- toàn bộ matrix trên có test;
- không có skipped test để che thiếu behavior chính;
- success + denied path đều được kiểm tra;
- acceptance test sử dụng MCP client/server thật;
- test chạy lặp lại không làm bẩn working tree hoặc máy developer.
