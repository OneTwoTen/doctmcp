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
bun run test:m3
bun run test:m4
```

- `test:local`: khóa catalog/contract/security của M1 Local MCP.
- `test:m2`: khóa public MCP Client ↔ WebSocket bridge ↔ Local MCP Runtime của M2.
- `test:m3`: khóa pairing/auth/reconnect/multi-device và security boundary M3.
- `test:m4`: khóa OIDC verifier, public Streamable HTTP endpoint, per-device MCP routing, offline error và audit.

Entrypoint scaffold:

```sh
bun run dev:agent
bun run dev:server
```

M1/M2 acceptance và implementation/local acceptance của M3/M4 đã hoàn tất trong nhánh hiện tại. M3 #36 vẫn cần CI/cross-platform verification. `dev:server` chỉ bật public `/mcp` khi OIDC config hợp lệ; chỉ thấy process listen không chứng minh external OAuth/ChatGPT đã kết nối được. M4 chưa production-ready khi chưa có IdP, domain và durable persistence.

## Chạy public MCP với authorization server

Server chỉ bật `/mcp` khi cả `PUBLIC_MCP_URL`, `OIDC_ISSUER` và `OIDC_AUDIENCE` đã cấu hình. Bắt đầu từ `apps/server/.env.example`. OIDC issuer phải publish discovery/JWKS qua HTTPS và phát JWT có audience khớp chính xác MCP URL cùng scope `mcp`. `/bridge` và `/mcp` dùng chung cổng Bun; reverse proxy phải chuyển tiếp WebSocket upgrade và HTTPS Host. Mặc định server chỉ bind loopback; đặt `BIND_HOST=0.0.0.0` khi reverse proxy ở container/network riêng và đã khóa inbound network phù hợp. Nếu TLS kết thúc tại proxy khác loopback, khai báo đúng IP peer của proxy trong `TRUSTED_PROXY_ADDRESSES`; proxy phải ghi đè `X-Forwarded-Proto=https`. Server chỉ tin scheme đó từ địa chỉ đã cấu hình, không tin forwarded client IP.

Không commit file `.env`, access token hoặc client secret. `bun run test:m4` dùng OIDC/JWT fixture cục bộ, không cần provider thật.

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

M3 implementation đã đủ 7/7 work item; M3.7 (#36) còn chờ CI/cross-platform gate. Chạy `bun run test:m3` để kiểm tra pairing/auth, reconnect/heartbeat, routing và security lifecycle; giữ transport core M2 độc lập.

Verification M1–M5 hiện chạy trên Windows local. Bun khả dụng tại môi trường này là 1.4.1 trong khi repository ghim 1.4.2; target suites xanh, còn full `bun test` có 32 fixture fail với `EPERM` khi tạo symlink. Không đổi test/security behavior để lách lỗi quyền này; xem [`testing/m3-acceptance.md`](testing/m3-acceptance.md).

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
