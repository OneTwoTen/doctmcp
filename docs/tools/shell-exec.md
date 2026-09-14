# `shell.exec`

## Mục đích

Cho phép MCP client thực thi command local trong phạm vi workspace được cấp quyền. Đây là tool có risk cao nhất M1 nên phải có timeout, output limit và permission enforcement trước khi coi là hoàn tất.

## Input M1

Contract dùng direct process execution thay vì ép command qua shell string:

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

- `command` bắt buộc, không rỗng và không chứa NUL byte.
- `args` là mảng string, mặc định `[]`; với native executable, từng argument được truyền trực tiếp cho process, không qua shell reinterpretation.
- `cwd` tương đối với workspace, mặc định root workspace và luôn đi qua workspace resolver với capability `execute`.
- `timeoutMs` mặc định `30000`; local policy chặn giá trị lớn hơn `120000` theo cấu hình mặc định.
- M1 không expose `shell: true`, pipeline, redirection hoặc raw shell string cho MCP caller. Nếu cần shell syntax thật sau này, phải thêm explicit mode/tool contract và permission riêng.
- Caller không được truyền raw environment map.

Direct execution giảm ambiguity và shell injection, đồng thời vẫn đủ cho `git`, `bun`, `cargo`, compiler và phần lớn developer command. Trên Windows, `.cmd`/`.bat` shim phổ biến như npm-compatible shims được xử lý bằng bridge nội bộ có validation riêng, không biến contract thành raw shell execution. `system.which` dùng để kiểm tra executable trước khi chạy khi cần.

## Windows batch shim bridge

Windows không thể direct-spawn `.cmd`/`.bat` như native `.exe`. Khi executable đã resolve có extension `.cmd` hoặc `.bat`, runtime dùng `cmd.exe` như một platform bridge nội bộ với các ràng buộc sau:

- bridge không phải mode do MCP caller lựa chọn;
- command path và args được quote sau khi validation;
- reject newline, quote và các `cmd.exe` metacharacter/expansion character nguy hiểm trước khi spawn;
- không bật `shell:true` và không nhận raw shell command string;
- Windows CI chạy test thật cho `.cmd` shim và case metacharacter bị chặn.

Các argument cần shell metacharacter trên Windows batch shim không thuộc M1; caller phải dùng native executable hoặc một contract shell explicit trong milestone sau.

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

Policy mặc định giới hạn tổng stdout + stderr ở `1048576` bytes.

- Khi output chạm giới hạn, runtime chỉ giữ phần đã capture trong budget, terminate process tree và trả `truncated: true`.
- `exitCode` có thể là `null` nếu process bị terminate bằng signal.
- Exit code khác `0` vẫn là process result có cấu trúc, không biến thành `INTERNAL_ERROR`.
- Output được giữ theo byte budget trước khi decode UTF-8 để memory không tăng không giới hạn.

## Timeout và cancellation

- Timeout terminate process tree và trả domain error `TIMEOUT`.
- Trên POSIX, child được chạy trong process group riêng; runtime gửi `SIGTERM` cho group rồi `SIGKILL` sau grace period nếu cần.
- Trên Windows, runtime dùng `taskkill /T /F` để terminate process tree; nếu tree kill không khởi động được thì fallback kill direct child.
- Output-limit và MCP `AbortSignal` dùng cùng process-tree termination path, tránh chỉ kill parent rồi để descendant chạy tiếp.
- Đây vẫn là best-effort process-tree control, không phải OS sandbox; descendant chủ động tách khỏi process group/job boundary có thể cần sandbox/job manager ở milestone sau.
- M1 synchronous; không tạo custom `job`.

## Permission và command policy

Workspace cần capability `execute`. `cwd` vẫn chịu deny subtree của workspace.

Local shell policy mặc định deny các executable name:

```text
sudo
shutdown
reboot
```

So sánh policy dùng executable basename đã normalize, bỏ Windows executable extension phổ biến và không dùng prefix string. Vì vậy path như `/usr/bin/sudo` hoặc `shutdown.exe` không bypass được deny rule tương ứng.

Có thể override danh sách deny ở local configuration khi tạo tool. Policy nâng cao theo argument là scope riêng nhưng architecture không được làm nó bất khả thi.

## Environment policy

M1 không inherit toàn bộ `process.env` vào child. Runtime chỉ truyền allowlist local tối thiểu phục vụ executable discovery, home/temp và locale, ví dụ:

```text
PATH, PATHEXT, HOME, USERPROFILE,
TMP, TEMP, TMPDIR,
SystemRoot, WINDIR, COMSPEC,
LANG, LC_ALL, LC_CTYPE,
TERM, COLORTERM, NO_COLOR
```

Allowlist này là local configuration, không phải input từ MCP caller. Token, API key hoặc biến môi trường tùy ý không được truyền xuống child theo mặc định.

Lưu ý: capability `execute` vẫn là quyền mạnh. Process được chạy bằng user account hiện tại và M1 không phải OS sandbox; command có thể tự đọc file hoặc truy cập network nếu hệ điều hành cho phép. Workspace/cwd policy không được mô tả như sandbox process hoàn chỉnh.

## MCP annotations

`shell.exec` có side effect không thể suy ra chỉ từ tên executable. Annotation được khai báo conservative:

```text
readOnlyHint: false
destructiveHint: true
openWorldHint: true
```

`openWorldHint` được bật vì command có thể truy cập network/external entities. Local policy mới là nguồn enforcement thực.

## Security

- không dùng `eval`, shell concat hoặc caller-controlled implicit `shell:true`;
- Windows batch bridge chỉ nhận executable đã resolve và args vượt validation chặt, không nhận raw shell string;
- không inherit toàn bộ environment secret vào child;
- không log full sensitive args theo mặc định;
- `cwd` phải qua workspace resolver, không dùng path tùy ý;
- command denied bị chặn trước spawn;
- timeout, output limit và cancellation terminate process tree best-effort;
- command path/extension được normalize trước khi so deny policy;
- execute capability không được coi là filesystem sandbox cho process.

## Test bắt buộc

- command thành công, capture stdout;
- command exit code != 0, capture stderr/exit code;
- command không tồn tại trả structured error;
- cwd trong workspace hoạt động;
- cwd traversal/symlink escape bị chặn;
- workspace không có execute permission bị chặn;
- denied command không spawn;
- timeout terminate process tree;
- output limit được enforce, terminate descendants và result đánh dấu `truncated`;
- cancellation qua `AbortSignal` terminate descendants;
- args chứa space/quote được truyền đúng dưới direct spawn, không bị shell reinterpret;
- Windows `.cmd` shim chạy được với safe args và metacharacter nguy hiểm bị reject;
- environment secret tùy ý không được inherit vào child mặc định.

## Deferred

- interactive stdin/PTY;
- caller-controlled shell syntax/pipes/redirection;
- unrestricted Windows batch metacharacter arguments;
- long-running/background job;
- MCP Tasks integration;
- process list/kill;
- streaming stdout;
- argument-aware command policy;
- OS-level process sandbox/job object management.

## Acceptance criteria

Tool đủ dùng cho developer command phổ biến trong workspace, có coverage Linux + Windows cho process execution trọng yếu, nhưng không mở raw shell string hoặc inherit nguyên environment chỉ để tiện triển khai M1.
