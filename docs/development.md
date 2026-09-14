# Phát triển local

## Yêu cầu

- Bun **1.4.2**.
- Git.

Repository dùng Bun làm package manager/runtime chính cho TypeScript. Không cần npm/yarn/pnpm cho workflow chuẩn của dự án.

## Cài dependencies

```sh
bun install
```

Khi `bun.lock` đã được commit, CI và local nên ưu tiên cài theo lockfile để tránh dependency drift.

## Lệnh chính

```sh
bun run check
bun run typecheck
bun test
```

- `check`: chạy Biome trên repository.
- `typecheck`: chạy TypeScript 7 strict check.
- `bun test`: chạy Bun test suite.

Entrypoint scaffold:

```sh
bun run dev:agent
bun run dev:server
```

Cho tới khi M1/M2 hoàn tất, việc entrypoint khởi động được không đồng nghĩa MCP runtime hoặc server ↔ local networking đã hoạt động.

## Thứ tự phát triển hiện tại

### M1 — Local MCP

Mọi behavior local nên test độc lập trước:

```text
MCP test client
    -> tools/list
    -> tools/call
    -> Local MCP server
```

Không đưa WebSocket, pairing hoặc ChatGPT vào test M1 nếu không cần.

### M2 — Server → Local

Sau khi local MCP ổn định, thêm integration test:

```text
server MCP client
    -> custom WebSocket transport
    -> local MCP server
```

Acceptance test quan trọng nhất là server gọi được `tools/list` và `tools/call` thật từ local.

## Quy tắc test-first

Ưu tiên viết test đỏ trước implementation khi behavior có thể mô tả rõ.

Với local tool:

- test schema/input;
- test success path;
- test error đáng kể;
- test denied path nếu tool chịu permission;
- không chỉ test tên tool hoặc static string.

Với transport:

- test message đi hai chiều;
- test close/error;
- test request đang chờ khi disconnect;
- test không duplicate/reorder ngoài guarantee đã thiết kế.

Với security-sensitive behavior, test denied path là bắt buộc trước khi coi feature hoàn tất.

## Thay đổi tài liệu

Khi thay đổi architecture, protocol, pairing, permission hoặc security boundary, cập nhật tài liệu domain tương ứng trong cùng scope.

Tài liệu mặc định viết tiếng Việt. Không dịch code, command, API identifier hoặc protocol field nếu việc dịch làm mất tính tương thích/kỹ thuật.

## Commit và branch

Ưu tiên thay đổi nhỏ theo một mục tiêu. Conventional-style commit message có thể dùng khi phù hợp, ví dụ:

```text
feat(agent): add local MCP system info tool
test(agent): cover filesystem permission denial
feat(server): add websocket MCP client transport
docs: record local MCP first architecture
```

Không chia commit chỉ để tạo lịch sử đẹp nếu các commit trung gian làm repository không build/test được.

## Verification trước khi hoàn tất

Chạy ít nhất:

```sh
bun run check
bun run typecheck
bun test
```

Feature cross-layer phải chạy thêm integration test tương ứng. Không dùng kết quả CI cũ hoặc suy đoán thay cho bằng chứng kiểm tra mới.
