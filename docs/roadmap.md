# Roadmap doctmcp

Roadmap này mô tả thứ tự triển khai đã chốt. Mục tiêu là giảm rủi ro bằng cách hoàn thiện và kiểm thử từng lớp độc lập trước khi ghép ChatGPT vào toàn hệ thống. M1–M5 implementation và acceptance CI đã hoàn tất; bước tiếp theo là cấu hình môi trường hosted để xác nhận tích hợp ChatGPT thật.

## M1 — Local MCP

**M1 hoàn tất 8/8 work item.** Local runtime đã có đủ catalog 6 tool và acceptance suite MCP thật để khóa contract, permission/security boundary và vertical flow offline. M2–M5 cũng đã hoàn tất implementation và acceptance; xem các mục bên dưới để biết giới hạn triển khai hosted.

Các work item M1:

- ✅ M1.1 / #2 — Local MCP server, tool registry và protocol scaffold cleanup qua PR #10.
- ✅ M1.2 / #3 — Workspace registry, path resolver và permission core qua PR #11.
- ✅ M1.3 / #4 — Tool `system` (`info`, `which`) qua PR #12.
- ✅ M1.4 / #5 — Tool `filesystem.read` (`read`, `list`, `stat`, `search`) qua PR #13.
- ✅ M1.5 / #6 — Tool `filesystem.write` (`write`, `patch`, `mkdir`, `move`) qua PR #14.
- ✅ M1.6 / #7 — Tool destructive `filesystem.delete` qua PR #15.
- ✅ M1.7 / #8 — Tool `shell.exec` với direct spawn, timeout, output limit, execute permission, process-tree hardening và Windows regression coverage qua PR #16.
- ✅ M1.8 / #9 — MCP contract/acceptance suite toàn M1 qua PR #17.

Catalog M1 chốt 6 tool theo capability/risk boundary:

```text
workspace
  ├─ list
  └─ get

system
  ├─ info
  └─ which

filesystem.read
  ├─ read
  ├─ list
  ├─ stat
  └─ search

filesystem.write
  ├─ write
  ├─ patch
  ├─ mkdir
  └─ move

filesystem.delete

shell.exec
```

Phạm vi nền:

- MCP server + tool registry;
- schema/action validation;
- workspace registry + path resolver;
- permission layer local;
- structured tool result/error;
- timeout/output limit cho shell;
- temp-workspace integration test;
- MCP `tools/list` + `tools/call` acceptance test;
- loại bỏ `command.request` / `command.result` khỏi vai trò tool-execution protocol trong scaffold.

Không thuộc M1:

- `device` tool;
- custom `job` manager;
- process manager;
- Git/Docker/database tools;
- WebSocket bridge;
- pairing/database/public server/ChatGPT.

Tài liệu chi tiết: [`specs/2026-09-14-m1-local-mcp-design.md`](specs/2026-09-14-m1-local-mcp-design.md), [`tools/`](tools/README.md), [`testing/m1-local-mcp.md`](testing/m1-local-mcp.md).

Acceptance criteria đã được khóa bằng test:

- test client initialize được local MCP server;
- `tools/list` trả đúng 6 tool/schema/annotations;
- mỗi tool có success call qua MCP protocol thật;
- invalid input trả lỗi có cấu trúc mà server không crash;
- path traversal + symlink escape bị chặn;
- denied path/capability bị chặn tại local;
- delete không thể xoá workspace root;
- shell có timeout/output limit và không dùng implicit raw shell string;
- process-tree/cross-platform regression từ #8 tiếp tục xanh;
- test không cần public server, Internet hoặc ChatGPT;
- `bun run check`, `bun run typecheck`, `bun test` xanh.

## M2 — Public server gọi local MCP

**M2 hoàn tất 5/5 work item.** Public server đã dùng MCP Client chuẩn gọi production Local MCP Runtime qua WebSocket do local chủ động mở; acceptance suite #23 khóa cả success flow, MCP error semantics, disconnect/close và malformed/oversized boundary.

Các work item M2:

- ✅ M2.1 / #19 — Thiết kế Bridge protocol và transport contract qua PR #24.
- ✅ M2.2 / #20 — WebSocket gateway tối thiểu trên public server qua PR #25.
- ✅ M2.3 / #21 — `BridgeServerTransport` phía local agent qua PR #26.
- ✅ M2.4 / #22 — `BridgeClientTransport` phía public server qua PR #27.
- ✅ M2.5 / #23 — Acceptance/integration suite server ↔ local qua PR #28.

Implementation đã khóa:

- local chủ động mở WebSocket và hoàn tất bridge handshake;
- gateway quản lý active bridge session và lifecycle/cleanup;
- local `BridgeServerTransport` tương thích MCP server role;
- public `BridgeClientTransport` tương thích MCP client role và bind độc quyền ready session;
- MCP `initialize`, `tools/list`, `tools/call system/info` chạy xuyên bridge thật;
- `filesystem.write` + `filesystem.read` round-trip trên temp workspace thật;
- structured domain error và unknown tool giữ nguyên MCP semantics;
- local disconnect khi request pending làm public MCP request reject rõ ràng;
- public close propagate về local và cleanup idempotent;
- malformed JSON và frame UTF-8 vượt 1 MiB bị production gateway reject deterministic;
- wire-size 1 MiB, FIFO queue 256 message / 4 MiB và backpressure deterministic;
- bridge session identity được tách khỏi MCP SDK `Transport.sessionId` để fresh `Client.connect()` luôn initialize đúng.

Acceptance flow đã chứng minh:

```text
Public MCP Client
    -> BridgeClientTransport
    -> Public WebSocket Gateway
    -> BridgeServerTransport
    -> Local MCP Runtime
    -> tools/list
    -> tools/call system/info
    -> filesystem round-trip
    -> result quay về public client
```

Chạy riêng suite M2:

```sh
bun run test:m2
```

Chi tiết: [`testing/m2-server-local.md`](testing/m2-server-local.md).

Pairing, database, device identity/routing, public MCP endpoint và ChatGPT integration không thuộc M2.

## M3 — Device management và pairing

**M3 implementation hoàn tất 7/7 work item; gate #36 đã qua CI/cross-platform.** M3.1–M3.5 đã merge qua PR #37–#41. M3.6/#35 và M3.7/#36 đã triển khai trong nhánh hiện tại; `test:m3` hiện 127/127 pass cùng M1/M2, `check` và `typecheck` xanh local. Full `bun test` trên Windows local có 32 lỗi fixture symlink `EPERM`; kết quả được ghi ở [M3 acceptance](testing/m3-acceptance.md). Linux full suite và Windows acceptance M1–M5 đều xanh trong [CI run 35359769097](https://github.com/OneTwoTen/doctmcp/actions/runs/35359769097). Mục tiêu của milestone là biến kết nối M2 thành kết nối thiết bị có identity, auth và lifecycle rõ ràng.

Các work item M3:

- ✅ M3.1 / #30 — Device identity/domain model + persistence contract qua PR #37.
- ✅ M3.2 / #31 — Pairing session/code lifecycle và atomic claim flow qua PR #38.
- ✅ M3.3 / #32 — Device credential lifecycle + authenticated bridge handshake qua PR #39 (`163fb899`).
- ✅ M3.4 / #33 — Device session registry, heartbeat và online/offline state qua PR #40.
- ✅ M3.5 / #34 — Local reconnect/backoff + credential resume qua PR #41.
- ✅ M3.6 / #35 — Multi-device registry + routing theo `deviceId` — implementation/target verification trong nhánh hiện tại.
- ✅ M3.7 / #36 — Acceptance/security suite pairing → reconnect → routing — local suite và CI/cross-platform xanh.

M3.1 đã khóa:

- immutable UUID v4 `deviceId`, canonical lowercase;
- opaque immutable `ownerId`;
- mutable device name/metadata;
- `DeviceRepository` không leak database-specific type;
- deterministic `InMemoryDeviceRepository` cho test;
- owner-scoped lookup/list/update/check;
- defensive snapshot và atomic/monotonic update;
- raw credential, live session và authoritative online state không nằm trong `Device` record.

M3.2 đã khóa:

- opaque UUID v4 `pairingSessionId`, tách khỏi `deviceId` và bridge session id;
- pairing code human-readable 12 symbol / 60-bit entropy, CSPRNG, TTL mặc định 5 phút;
- canonical normalization + SHA-256 digest lookup, không persist raw code;
- state one-time `pending → claimed|expired|cancelled`;
- atomic claim bao trọn expiry validation + `DeviceRepository.create()` + mark claimed;
- authoritative claim time được đọc trong repository atomic boundary;
- malformed/non-string/unknown/expired/reused/cancelled code cùng map `PAIRING_CODE_UNAVAILABLE`;
- anti-bruteforce hook chỉ nhận digest/context, không nhận raw pairing code.

M3.3 đã khóa:

- long-lived raw credential 32 CSPRNG bytes / 256 bit, wire format 43-char unpadded base64url;
- server chỉ persist digest có domain prefix, không persist/log raw credential;
- `credentialId + version` làm generation/CAS boundary; credential id không reuse;
- issue/verify/revoke/rotate deterministic, old generation mất hiệu lực sau rotate/revoke;
- pairing credential completion có durable `pending/recovering/delivered` state và crash-safe recovery reservation;
- per-device lifecycle coordinator serialize initial issue, recovery finalize và explicit rotate/revoke trong cùng runtime;
- authenticated `bridge.hello` bind server-side `{ownerId, deviceId}` trước `ready`/MCP traffic;
- strict auth schema reject malformed device id/credential trước verifier;
- ready lease + final credential revalidation chặn auth-vs-mutation race;
- successful rotate/revoke đóng same-process authenticated session và old secret không reconnect được;
- CI #270: 223/223 tests, 914 assertions, 34 files, M2 acceptance và Windows regression xanh.

M3.4 đã khóa:

- `DeviceSessionRegistry` keyed theo immutable `deviceId`, giữ exact credential generation và owner index;
- duplicate connection dùng policy new authenticated session replace old atomically, stale cleanup không evict generation mới;
- native WebSocket ping/pong heartbeat tách khỏi MCP traffic;
- online/offline derive từ active authenticated session + heartbeat liveness;
- heartbeat tại hoặc sau timeout boundary không revive stale session;
- `DeviceCredentialInvalidationBus` hỗ trợ revoke/rotate cross-instance, generation-aware với delayed/duplicate event;
- degraded fallback heartbeat revalidate authoritative credential generation khi invalidation delivery lỗi;
- invalidation publish mặc định bounded ≤ 5 giây để backend treo không giữ lifecycle lock vô hạn;
- PR #40 verification: 240 tests pass, M2 acceptance và Windows `shell.exec` regression xanh.

M3.5 đã triển khai trên `main` qua PR #41:

- `BridgeServerTransport` vẫn one-shot; reconnect nằm ở reusable `LocalBridgeReconnectController`;
- local credential provider có in-memory adapter và file-safe adapter validate bằng shared schema;
- file replace dùng temp file cùng directory, mode `0600`, sync, close, rename và cleanup khi fail;
- bounded exponential backoff + jitter, default 500ms → tối đa 30s, stable-ready reset sau 30s;
- network/socket/timeout retry; auth failure, missing credential, protocol mismatch và storage failure vào terminal/action-required state tương ứng;
- lifecycle + exact-attempt generation guard chặn stale callback/timer phá generation mới;
- repeated server unavailable không tạo parallel connect attempt;
- `stop()` concurrent dùng chung cleanup lifecycle, `start()` không vượt qua transport cleanup đang in-flight;
- acceptance thật chứng minh timeout reconnect bằng cùng credential và revoke dừng ở `auth-failed`;
- logger/public snapshot không chứa raw credential hoặc raw transport error message.

M3.6 đã triển khai trên task #35:

- `DeviceRoutingService` ghép owner-scoped `DeviceRepository`, session registry và active credential repository;
- device DTO không chứa `ownerId`, session handle hoặc credential metadata;
- route xác minh `{ ownerId, deviceId }`, trạng thái credential và exact session generation trước khi trả authenticated bridge session;
- unknown/wrong-owner, offline và credential không khả dụng có error code deterministic; không fallback theo `deviceName` hoặc session khác.

M3.7/#36 đã thêm `test:m3` và vertical flow pairing hai device cùng tên → authenticated WebSocket → route theo ID → MCP initialize/list/call → transient reconnect. Suite local và CI xanh trong [run 35359769097](https://github.com/OneTwoTen/doctmcp/actions/runs/35359769097).

Phạm vi còn lại của M3:

- Không còn hạng mục implementation M3; các cấu hình production nằm ngoài milestone này.

`device.list/get/ping` nếu cần expose cho model/client thuộc public/control-plane surface ở milestone sau, không phải local M1 tool catalog.

Security regression của M3 phải tiếp tục giữ pairing code one-time, credential revoke/rotate, auth race, session invalidation và reconnect lifecycle semantics. M2 regression phải tiếp tục xanh trong toàn M3.

## M4 — Public MCP endpoint

**Implementation, local acceptance và CI của M4 đã hoàn tất.** `test:m4`, M1/M2/M3 target suite, `bun run check` và `bun run typecheck` đều xanh. Full `bun test` trên Windows local còn 32 lỗi tạo symlink (`EPERM`), trong khi Linux full suite và Windows target suites xanh trong [CI run 35359769097](https://github.com/OneTwoTen/doctmcp/actions/runs/35359769097). M4 chưa production-ready cho tới khi cấu hình external deployment/authentication và durable persistence được xác nhận.

Mục tiêu: public server expose MCP endpoint chuẩn cho MCP client bên ngoài.

Phạm vi dự kiến:

- MCP server/public endpoint;
- OAuth 2.1/OIDC user authentication qua authorization server bên ngoài;
- chọn device hoặc route device;
- ánh xạ public tool call sang MCP client session của local device;
- xử lý offline/timeout/error rõ ràng;
- audit metadata tối thiểu.

Decision về Bun web-standard listener, Streamable HTTP SDK và OIDC resource server được ghi trong [decision M4](decisions/2026-09-17-public-mcp-endpoint.md). Repositories hiện tại mặc định in-memory; production persistence/deployment vẫn cần adapter bền vững.

## M5 — ChatGPT integration

**CLI local, pairing, local end-to-end và CI của M5 đã hoàn tất.** `bun run test:m5` kiểm tra HTTPS pairing start, WebSocket control channel outbound, OAuth-protected `devices_pair`, credential persistence trước ACK, authenticated bridge reconnect, `devices_list` và tool call vào workspace có permission. Chưa xác nhận OIDC provider, HTTPS deployment hoặc ChatGPT Developer Mode bằng cấu hình thật.

Đã triển khai:

- CLI `connect --config` với strict JSON/workspace validation, default deny, file credential provider và signal cleanup;
- pairing code chỉ hiện sau attach; credential được ghi local trước ACK;
- `devices_pair` lấy owner từ OAuth principal và không trả credential trong MCP result;
- pairing WebSocket riêng trên cùng gateway, rate/capacity limits và generic errors;
- local bridge reconnect, device listing, alias route và permission enforcement;
- fixture end-to-end chạy public MCP/bridge/local runtime thật.

Giới hạn còn lại trước triển khai hosted: cần OIDC issuer/audience, public HTTPS/TLS proxy, OAuth client/redirect URI do ChatGPT workspace cung cấp và kiểm thử thủ công qua ChatGPT thật. Repository chưa có durable multi-instance adapters; server state mặc định in-memory và chỉ phù hợp dev/test một process. Xem [M5 acceptance](testing/m5-chatgpt.md).

## Giai đoạn sau

Chỉ cân nhắc sau khi M1–M5 ổn định:

- Git tools nâng cao (`git.read`, `git.write`);
- process management;
- Docker tools;
- database tools;
- shell mode/PTY/streaming;
- long-running execution; ưu tiên đánh giá MCP Tasks trước khi tự tạo `job` protocol;
- local tool plugin system;
- desktop tray;
- auto-update;
- installer Windows/macOS/Linux;
- audit/history nâng cao;
- policy profile theo project/workspace;
- nhiều public server hoặc self-host distribution.

## Nguyên tắc roadmap

- Không kéo dependency của milestone sau vào milestone trước nếu chưa cần.
- Mỗi milestone phải có acceptance test độc lập.
- Tool catalog tối ưu semantic/permission boundary, không tối ưu số lượng tool một cách máy móc.
- Ưu tiên vertical proof nhỏ nhưng chạy thật hơn scaffold lớn chưa có behavior.
- Khi thay đổi thứ tự hoặc ranh giới milestone, cập nhật decision/spec tương ứng nếu đó là thay đổi kiến trúc dài hạn.
