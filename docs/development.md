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
- `bun test`: chạy toàn bộ Bun test suite.

Acceptance suite chuyên biệt:

```sh
bun run test:local
bun run test:m2
```

- `test:local`: khóa catalog/contract/security của M1 Local MCP.
- `test:m2`: khóa public MCP Client ↔ WebSocket bridge ↔ Local MCP Runtime của M2.

Entrypoint scaffold:

```sh
bun run dev:agent
bun run dev:server
```

M1 và M2 đã hoàn tất bằng test. Entrypoint chạy được vẫn không đồng nghĩa các milestone sau như pairing/device routing/public MCP endpoint đã tồn tại.

## Thứ tự phát triển hiện tại

### M1 — Local MCP

Mọi behavior local được test độc lập:

```text
MCP test client
    -> tools/list
    -> tools/call
    -> Local MCP server
```

Không đưa WebSocket, pairing hoặc ChatGPT vào test M1 nếu không cần.

### M2 — Server → Local

M2 đã có acceptance suite production path:

```text
Public MCP Client
    -> BridgeClientTransport
    -> Public WebSocket Gateway
    -> BridgeServerTransport
    -> Local MCP Runtime
```

Suite phải giữ xanh các behavior: initialize, exact 6-tool catalog, `system/info`, filesystem round-trip, structured error, pending disconnect, public close, malformed/oversized frame và cleanup.

Chi tiết: [`testing/m2-server-local.md`](testing/m2-server-local.md).

### M3 — Device management và pairing

Đây là milestone active tiếp theo. Khi triển khai M3, giữ transport core M2 độc lập với pairing/auth persistence và thêm test riêng cho device identity, credential, reconnect/heartbeat và security lifecycle.

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
test(m2): lock server-local bridge acceptance
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

Feature cross-layer phải chạy thêm acceptance/integration test tương ứng. Với thay đổi M2 bridge, chạy thêm `bun run test:m2`. Không dùng kết quả CI cũ hoặc suy đoán thay cho bằng chứng kiểm tra mới.


## Playbook thực hành

Khi bắt đầu issue mới, review PR, xử lý review feedback hoặc cần xác định test/tài liệu phải cập nhật, dùng [`project-playbook.md`](project-playbook.md) làm checklist thực hành. `development.md` tập trung vào môi trường và lệnh local; playbook tập trung vào quy trình hoàn thành một task từ đầu đến cuối.
