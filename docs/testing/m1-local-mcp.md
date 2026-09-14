# Kiểm thử M1 — Local MCP

## Mục tiêu

M1 chỉ được coi là hoàn tất khi có bằng chứng MCP client thật có thể discover và call toàn bộ catalog local. Test phải chạy offline và không phụ thuộc public server/ChatGPT.

M1.1–M1.7 (#2–#8) đã hoàn tất trên `main`. M1.8 / #9 bổ sung acceptance suite cuối để khóa toàn bộ Definition of Done của milestone; M1 chỉ được coi là xanh khi suite này và quality checks của repository cùng pass.

## Nguyên tắc

- Red-first cho behavior mới khi khả thi.
- Dùng temp directory làm workspace test; không test destructive behavior trên repository/home thật.
- Không mock filesystem/process ở acceptance layer.
- Không mock MCP layer ở acceptance test cuối: dùng MCP `Client`, `McpServer` và transport test thật của SDK.
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
| `shell.exec` | stdout + exit code | denied command, timeout/process-tree termination, output limit, cancellation, cwd escape |

Regression cross-platform của `shell.exec` phải tiếp tục được giữ xanh:

- timeout, output-limit và `AbortSignal` không để descendant process sống sót trong các case phổ biến;
- native executable giữ direct-spawn semantics;
- Windows `.cmd/.bat` shim chạy qua constrained bridge, safe args hoạt động và shell metacharacter nguy hiểm bị reject;
- environment secret tùy ý không được inherit mặc định.

Các regression chi tiết này tiếp tục nằm trong test chuyên biệt của `shell.exec`; acceptance suite không duplicate toàn bộ platform matrix mà kiểm tra contract MCP và các boundary M1 quan trọng nhất.

## Tầng 3 — MCP contract/acceptance

Acceptance suite chính nằm tại:

```text
apps/agent/src/m1-acceptance.test.ts
```

Catalog 6 tool được tạo qua `createLocalToolCatalog()` trong `apps/agent/src/local-tool-catalog.ts`. Đây là registration path dùng chung cho acceptance test để tránh hard-code một catalog khác với runtime.

### `tools/list`

Assert:

- đúng 6 tool;
- tên đúng;
- description không rỗng;
- có input/output schema;
- action schema đúng với catalog đã chốt;
- annotations đúng risk class đã chốt.

### `tools/call`

Ít nhất một success call cho mỗi tool phải đi qua MCP protocol thật, không gọi handler trực tiếp.

Vertical flow được khóa bằng test:

```text
initialize
  -> tools/list
  -> workspace/list
  -> filesystem.write/write temp.txt
  -> filesystem.read/read temp.txt
  -> system/info
  -> shell.exec direct command trong workspace
  -> filesystem.delete temp.txt
  -> filesystem.read/list xác nhận final state
```

Sau flow, test kiểm tra file thực sự đã bị xoá trên filesystem và session MCP vẫn hoạt động.

### Invalid calls và security regression

Acceptance suite kiểm tra trực tiếp qua MCP:

- unknown tool;
- invalid schema;
- handler domain error;
- path traversal;
- symlink escape;
- deny subtree;
- denied capability;
- workspace root delete guard;
- shell timeout;
- shell output limit;
- server vẫn trả lời request hợp lệ sau các lỗi/termination trên.

Process-tree termination, cancellation và Windows `.cmd/.bat` behavior tiếp tục được khóa bằng `shell-exec.test.ts` và `shell-exec-hardening.test.ts` thay vì tạo một implementation riêng trong acceptance suite.

## Test isolation

- Mỗi test destructive tạo temp workspace riêng bằng OS temp directory.
- Cleanup chạy trong lifecycle kể cả khi assert fail.
- Không chạm repository hoặc home directory thật cho write/delete test.
- Không phụ thuộc executable tùy chọn; shell smoke test dùng runtime hiện tại qua `process.execPath`.
- Không cần network Internet, public server hoặc ChatGPT.

## Chạy test

Chạy riêng acceptance suite:

```sh
bun run test:local
```

Root script này chạy trực tiếp `apps/agent/src/m1-acceptance.test.ts` bằng `bun test`. Không còn script smoke test riêng ngoài test runner, tránh việc một đường test cũ chỉ cover một phần catalog.

Quality gate của M1:

```sh
bun run check
bun run typecheck
bun test
```

`bun test` tự discover acceptance suite, vì vậy root `ci` bao phủ #9 mà không cần gọi thêm một script ngoài test runner.

Ngoài quality job chính, Windows `shell.exec` integration job đã được thêm từ #8 và phải tiếp tục xanh để chặn regression `.cmd/.bat`/process-tree theo platform.

## Definition of done

- toàn bộ matrix trên có test ở acceptance hoặc test chuyên biệt tương ứng;
- không có skipped test để che thiếu behavior chính;
- success + denied path đều được kiểm tra;
- acceptance test sử dụng MCP client/server thật;
- regression `shell.exec` về timeout/output/cancel + process-tree/cross-platform tiếp tục xanh;
- `bun run check`, `bun run typecheck`, `bun test` đều xanh;
- test chạy lặp lại không làm bẩn working tree hoặc máy developer.
