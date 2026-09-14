# `shell.exec`

## Mục đích

Cho phép MCP client thực thi command local trong phạm vi workspace được cấp quyền. Đây là tool có risk cao nhất M1 nên phải có timeout, output limit và permission enforcement trước khi coi là hoàn tất.

## Input M1

Contract ưu tiên direct process execution thay vì ép mọi command qua shell string:

```json
{
  "workspace": "doctmcp",
  "command": "git",
  "args": ["status", "--short"],
  "cwd": ".",
  "timeoutMs": 30000
}
```

Quy tắc:

- `command` bắt buộc, không rỗng.
- `args` là mảng string, mặc định `[]`.
- `cwd` tương đối với workspace, mặc định root workspace.
- `timeoutMs` có default và max tại local config; caller không thể vượt max.
- M1 không cần expose `shell: true`/pipeline/redirection. Nếu cần shell syntax thật sau này, thêm explicit mode/tool contract và permission riêng thay vì silently chuyển direct exec sang shell.
- Không nhận raw environment map tùy ý trong contract đầu tiên. Nếu cần environment, chỉ cho allowlisted variables hoặc explicit policy sau.

Direct execution giảm ambiguity và shell injection, đồng thời vẫn đủ cho `git`, `bun`, `npm`, `cargo`, compiler và phần lớn developer command. `system.which` dùng để kiểm tra executable trước khi chạy khi cần.

## Output

```json
{
  "exitCode": 0,
  "signal": null,
  "stdout": "...",
  "stderr": "...",
  "durationMs": 42,
  "truncated": false
}
```

- stdout và stderr có giới hạn riêng hoặc tổng limit rõ.
- output vượt limit phải dừng capture/process theo policy; không được tăng memory không giới hạn.
- exit code khác 0 là process result có cấu trúc, không nhất thiết biến thành `INTERNAL_ERROR`.

## Timeout và cancellation

- timeout phải terminate child process.
- nếu MCP request bị cancel và SDK/runtime cho phép propagate, process phải được terminate cooperative/best-effort.
- phải tránh orphan process trong test cases phổ biến.
- M1 synchronous; không tạo `job` custom.

## Permission

Workspace cần capability `execute`. Permission engine có thể thêm allow/deny command policy.

Ví dụ local policy conceptual:

```yaml
shell:
  enabled: true
  deny:
    - sudo
    - shutdown
    - reboot
```

Tên executable phải được resolve nhất quán; không chỉ so prefix của một command string. Policy nâng cao theo args là scope riêng nhưng architecture không được làm nó bất khả thi.

## MCP annotations

`shell.exec` có side effect không thể suy ra chỉ từ tên executable. Không được dùng annotation để kết luận command an toàn. Khai báo conservative, ví dụ:

```text
readOnlyHint: false
destructiveHint: true
openWorldHint: true
```

`openWorldHint` dùng conservative vì command có thể truy cập network/external entities. Local policy mới là nguồn enforcement thực.

## Security

- không echo environment secrets vào log/result;
- không log full sensitive args nếu policy đánh dấu command nhạy cảm;
- `cwd` phải qua workspace resolver, không dùng path tùy ý;
- command denied phải bị chặn trước spawn;
- timeout/output limit được áp tại process layer, không chỉ validation input;
- không dùng `eval` hoặc string concatenation để tạo shell command.

## Test bắt buộc

- command thành công, capture stdout;
- command exit code != 0, capture stderr/exit code;
- command không tồn tại trả structured error;
- cwd trong workspace hoạt động;
- cwd traversal/symlink escape bị chặn;
- workspace không có execute permission bị chặn;
- denied command không spawn;
- timeout terminate process;
- output limit được enforce;
- args chứa space/quote được truyền đúng dưới direct spawn, không bị shell reinterpret.

## Deferred

- interactive stdin/PTY;
- shell syntax/pipes/redirection;
- long-running/background job;
- MCP Tasks integration;
- process list/kill;
- streaming stdout.

## Acceptance criteria

Tool đủ dùng cho developer command phổ biến trong workspace nhưng không mở một shell string không giới hạn chỉ để tiện triển khai M1.
