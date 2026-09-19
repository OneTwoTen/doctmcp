# Kiến trúc doctmcp

## Trạng thái foundation hiện tại

Repository hiện đã có:

- Bun 1.4.2 + TypeScript 7 strict.
- Bun workspaces cho `apps/*` và `packages/*`.
- Biome, TypeScript typecheck, Bun test và GitHub Actions CI.
- `apps/agent` đã có local MCP runtime và `BridgeServerTransport`; `apps/server` đã có WebSocket gateway, `BridgeClientTransport`, device/pairing repositories, credential lifecycle/completion và production runtime cho authenticated bridge.
- `packages/protocol` giữ bridge control-plane contract; `packages/schemas` đã có shared bridge, `Device`, pairing và device-credential schemas.

MCP server local và custom WebSocket bridge M2 đã hoàn tất. M3.1–M3.5 đã có trên `main`; M3.6/#35 owner-scoped multi-device registry/routing và M3.7/#36 vertical acceptance/security suite đã được triển khai trong nhánh hiện tại. `test:m3` (127 pass), M1/M2 acceptance, `check` và `typecheck` xanh local; Linux full suite và Windows acceptance M1–M5 xanh trong [CI run](https://github.com/OneTwoTen/doctmcp/actions/runs/35359769097). Full suite Windows local còn 32 lỗi fixture symlink `EPERM`.

M4 implementation và local acceptance đã hoàn tất trong nhánh hiện tại: public Streamable HTTP endpoint trên Bun listener, OIDC JWT verifier, principal ổn định từ `issuer + sub`, tool alias theo `deviceId` và upstream MCP Client dùng lại theo bridge session. `test:m4` kiểm tra flow qua HTTP, WebSocket và local MCP thật; cross-platform CI đã xanh. IdP/domain thật và durable persistence chưa được xác nhận; M4 chưa production-ready.

## Kiến trúc mục tiêu

```text
ChatGPT / MCP client
        │
        │ MCP
        ▼
┌──────────────────────────────┐
│        Public Server         │
│                              │
│ Public MCP endpoint          │
│ Authentication               │
│ Device router                │
│ MCP client per device/session│
└──────────────┬───────────────┘
               │
               │ custom WebSocket transport
               │ local chủ động kết nối ra ngoài
               ▼
┌──────────────────────────────┐
│       Local MCP Runtime      │
│                              │
│ MCP server                   │
│ Workspace/Permission engine  │
│ Tool registry                │
│ ├─ workspace                 │
│ ├─ system                    │
│ ├─ filesystem.read           │
│ ├─ filesystem.write          │
│ ├─ filesystem.delete         │
│ └─ shell.exec                │
└──────────────────────────────┘
```

Local luôn là phía chủ động mở kết nối ra public server. Kiến trúc không yêu cầu port forwarding, public IP hoặc expose HTTP/MCP endpoint của máy local ra Internet.

## Ranh giới trách nhiệm

### Local MCP runtime (`apps/agent`)

`apps/agent` hiện giữ tên từ scaffold, nhưng vai trò kiến trúc là **local MCP runtime**.

Thành phần này chịu trách nhiệm:

- chạy MCP server;
- đăng ký local tools;
- validate input của tool;
- quản lý workspace registry/path resolver;
- enforce permission tại local;
- thực thi filesystem/process/system capability;
- chủ động kết nối custom transport tới public server;
- gửi `deviceId + credential` trong authenticated `bridge.hello` khi auth được cấu hình;
- lưu credential bền vững và tự reconnect/backoff ở #34.

Tool implementation không được phụ thuộc vào public server hoặc ChatGPT. Một tool phải có thể test local bằng MCP client test harness mà không cần network public.

### Public server (`apps/server`)

Ở M2, server chứng minh được:

- nhận kết nối WebSocket từ local runtime;
- bind kết nối đó vào `BridgeClientTransport` theo MCP client role;
- thực hiện MCP initialize;
- thực hiện `tools/list`;
- thực hiện `tools/call`;
- nhận MCP result/error đúng correlation của protocol MCP;
- propagate disconnect/session failure để request đang pending không treo.

`BridgeClientTransport` không mở WebSocket và không thực hiện bridge handshake. Nó chỉ bind vào một `BridgeGatewaySession` đã `ready`; Gateway sở hữu socket/session lifecycle. Bridge session identity được expose riêng (`bridgeSessionId`), không dùng MCP SDK `Transport.sessionId`, vì field MCP đó có semantics reconnect và có thể khiến `Client.connect()` bỏ qua initialize.

Ở M3.1, public server có `DeviceRepository` abstraction và deterministic `InMemoryDeviceRepository` cho test. `Device` khóa immutable UUID v4 `deviceId`, opaque immutable `ownerId`, mutable name/metadata và timestamps; repository có owner-scoped get/list/update/check. Raw credential, live bridge session và authoritative online state không nằm trong `Device` record.

Ở M3.2, pairing code/session lifecycle dùng one-time short-lived code, digest-only persistence và atomic claim boundary để create/bind đúng một device.

Ở M3.3, server có long-lived device credential lifecycle, pairing credential completion/recovery, per-device lifecycle linearization và authenticated bridge handshake. Production runtime verify credential trước ready/ACK, bind server-side `{ownerId, deviceId}`, reject MCP trước auth và đóng same-process active session khi credential generation bị rotate/revoke. Credential wire shape là 32 random bytes encode 43-char unpadded base64url; raw credential không persist trong server credential/completion stores.

M3.4/#33 đã bổ sung authoritative session registry keyed bằng `deviceId`, duplicate-session policy, heartbeat/liveness, online/offline derived state và generation-aware cross-instance revoke/rotate invalidation.

M3.5/#34 đã bổ sung `LocalBridgeReconnectController`, credential provider local và bounded exponential backoff + jitter. M3.6/#35 bổ sung owner-scoped `DeviceRoutingService`, ghép device record với online session hiện hành và kiểm tra active credential generation trước khi route. M3.7/#36 chứng minh MCP call qua routed WebSocket tới đúng một trong nhiều local runtime. Public MCP endpoint thuộc M4.

### MCP data plane

MCP sở hữu semantics cho:

- initialization/capability negotiation;
- tool discovery;
- tool call;
- tool result;
- MCP error;
- cancellation và các lifecycle message tương ứng khi được dùng.

Dự án không tự tạo thêm `command.request`, `command.result` hoặc RPC tương đương chỉ để bọc lại `tools/call`.

### doctmcp control plane

`packages/protocol` chỉ dành cho dữ liệu nằm ngoài MCP, ví dụ:

- bridge/device handshake;
- device/session identity;
- authentication metadata;
- heartbeat/online state;
- reconnect metadata;
- pairing lifecycle;
- bridge protocol version nếu cần tương thích transport riêng.

Control plane không được trở thành protocol thực thi tool song song với MCP.

## M1 — Local MCP

M1 đã hoàn tất và là foundation cho bridge M2.

```text
MCP test client
      │
      │ initialize / tools/list / tools/call
      ▼
Local MCP server
      │
      ├─ Tool registry
      ├─ Schema validation
      ├─ Workspace/path resolver
      ├─ Permission engine
      └─ Tool handlers
```

Catalog M1 cố ý chỉ có 6 tool. Tool là capability/risk boundary; action chỉ nhóm thao tác cùng bản chất.

Chi tiết contract nằm tại [`specs/2026-09-14-m1-local-mcp-design.md`](specs/2026-09-14-m1-local-mcp-design.md) và [`tools/`](tools/README.md).

### Không thuộc local catalog M1

`device` là control/public concern ở milestone sau. `job`, `process`, `git.*`, `docker.*` chưa cần để chứng minh Local MCP. Long-running execution sau này ưu tiên đánh giá MCP Tasks thay vì tự tạo RPC/job protocol riêng.

## M2 — Server gọi local

```text
Public MCP Client
      │
      ▼
BridgeClientTransport
      │ bind ready session
      ▼
Public Gateway
      │ WebSocket
      ▼
BridgeServerTransport
      │
      ▼
Local MCP server
      │
      ▼
local tool
```

Custom WebSocket bridge chỉ chịu trách nhiệm chuyển MCP message qua kết nối đã có. Nó không định nghĩa lại `tools/list`, `tools/call` hoặc result format.

## M3 — Device identity, pairing và authenticated sessions

M3 implementation hiện hoàn tất 7/7 work item; #36 đã qua CI/cross-platform verification:

- ✅ M3.1/#30 — immutable device identity + persistence contract qua PR #37;
- ✅ M3.2/#31 — pairing session/code lifecycle + atomic claim qua PR #38;
- ✅ M3.3/#32 — device credential lifecycle + authenticated bridge handshake qua PR #39 (`163fb899`);
- ✅ M3.4/#33 — device session registry, heartbeat và online/offline state qua PR #40;
- ✅ M3.5/#34 — local reconnect/backoff và credential resume qua PR #41;
- ✅ M3.6/#35 — multi-device registry và routing theo `deviceId` — implementation và target verification trong nhánh hiện tại.
- ✅ M3.7/#36 — acceptance/security suite pairing → reconnect → routing — local suite và CI/cross-platform xanh.

Trong môi trường Windows hiện tại (`Bun 1.4.1`), full `bun test` có 32 test fixture fail khi tạo symlink vì `EPERM`; M3 (127 tests), M1/M2, M4, M5, `bun run check` và `bun run typecheck` đều pass. Xem [M3 acceptance](testing/m3-acceptance.md) để biết lệnh và evidence đầy đủ.

Foundation đã khóa:

- immutable UUID v4 `deviceId`, canonical lowercase;
- owner identity tách khỏi display metadata;
- owner-scoped `DeviceRepository` contract;
- one-time pairing code 60-bit, TTL, digest-only persistence và atomic claim;
- credential secret 256-bit, digest-only server persistence, generation-aware CAS, revoke/rotate và crash-safe completion recovery;
- authenticated bridge bind server-side owner/device identity trước MCP traffic;
- same-process lifecycle linearization chặn rotate/revoke chen vào pairing recovery/ready boundary;
- strict `bridge.hello.auth` schema và generic auth failure không leak raw credential.

M3.4 đã triển khai registry generation-aware cho session ownership/liveness theo `deviceId`, duplicate replacement, online/offline derived state và credential invalidation cross-instance với bound mặc định ≤ 5 giây.

## M4 — Public MCP endpoint

M4 thêm `/mcp` vào cùng Bun listener đang phục vụ `/bridge`. Endpoint dùng Streamable HTTP từ MCP TypeScript SDK chính thức; tool call, schema, error và cancellation tiếp tục thuộc MCP.

Public server xác minh bearer access token từ authorization server OIDC bên ngoài. OIDC discovery/JWKS, OAuth protected-resource metadata RFC 9728, JWT signature, issuer, audience, expiry và scope `mcp` nằm trên boundary của `/mcp`. Discovery phải quảng bá Authorization Code + PKCE `S256`; capability OAuth tùy chọn chỉ được chuyển tiếp nếu provider công bố. `ownerId` được dẫn xuất bằng hash domain-separated của `issuer + sub`, không dùng `client_id` làm user identity.

Tool set dành riêng cho principal đã xác thực. Alias có dạng `d_<deviceIdHex32>__<localToolName>` để tên thiết bị trùng không gây va chạm. Callback route lại theo owner, device và active credential generation. Một MCP `Client` được initialize một lần và dùng lại cho đúng `BridgeGatewaySession`; session reconnect tạo client mới. Tool catalog vừa khám phá được giữ trong memory để alias cũ báo `DEVICE_OFFLINE` thay vì đổi thiết bị ngầm.

Audit hook chỉ nhận principal opaque, device/tool id, timestamp/duration và outcome/error code; arguments và results không ghi. Repositories mặc định vẫn in-memory cho development/test. Production cần durable repository adapters và deployment process/coordination tương thích trước khi triển khai dùng thật.

## M5 — CLI local và pairing ChatGPT

Local CLI đọc config strict, validate/canonicalize workspace trước khi mở kết nối, và mặc định deny mọi capability không được bật. Khi chưa có credential, CLI tạo proof trong RAM, POST `/pairing/sessions`, rồi mở outbound WebSocket `/pairing`. Code chỉ xuất hiện sau khi server gắn socket đúng session/proof. `devices_pair` chạy dưới OAuth `/mcp`, claim code một lần, gửi credential qua pairing socket và chỉ trả metadata sau khi local ghi credential rồi ACK. Sau đó CLI mở `/bridge` bằng credential đã lưu và reconnect theo policy M3.5. Secret cache được dọn khi ACK hoặc channel hết hạn; pairing repository có capacity bound và pruning định kỳ.

Pairing frames là control plane riêng; MCP tool discovery/call vẫn đi qua Streamable HTTP → routed MCP Client → authenticated bridge → local MCP. Credential, code và proof không đi vào MCP result/audit. `/pairing/sessions` dùng body limit, strict keys, server-derived remote address và rate guard; HTTP plaintext chỉ được chấp nhận từ loopback. TLS proxy ngoài loopback cần IP peer chính xác trong `TRUSTED_PROXY_ADDRESSES` và phải ghi đè `X-Forwarded-Proto=https`. Pairing record có capacity bound và runtime pruning định kỳ.

`bun run test:m5` chạy local vertical flow bằng Bun server, WebSocket pairing, OAuth verifier fixture, MCP Client thật, file credential provider, bridge reconnect và workspace permission. OIDC tenant, TLS proxy, ChatGPT registration và durable multi-instance storage là cấu hình deployment bên ngoài, chưa được xác nhận từ repository.

## Security boundary

- Workspace root là boundary đầu tiên cho filesystem/cwd.
- Path resolver phải chống traversal, symlink escape và sibling-prefix bug.
- Permission được enforce tại local, không tin public server tuyệt đối.
- `delete` là capability destructive riêng.
- `shell.exec` dùng direct spawn trong M1, có timeout/output limit và command policy.
- MCP tool annotations hỗ trợ mô tả risk nhưng không phải authorization.
- Device ownership nằm server-side; authenticated device không bypass local permission.
- Raw pairing code/device credential không được log hoặc persist ngoài boundary đã document.

## Nguyên tắc mở rộng

- Tách tool implementation khỏi transport.
- Tách MCP semantics khỏi device/session control plane.
- Không thêm database, queue, Redis hoặc service riêng trước khi milestone hiện tại chứng minh nhu cầu thật.
- Public HTTP/MCP framework và OIDC resource-server contract được chốt tại [decision M4](decisions/2026-09-17-public-mcp-endpoint.md).
- Breaking change của custom bridge/control plane phải có version/compatibility strategy riêng; không trộn version này với MCP protocol version.
- Thêm tool mới dựa trên semantic/permission boundary, không dựa trên mục tiêu làm `tools/list` ngắn bằng mọi giá.

## Phần chưa chốt

Các quyết định sau vẫn chưa được khóa:

- production database adapter cho user/device registry;
- persistence/audit log ngoài Device/credential foundation hiện có;
- OIDC provider cụ thể, tenant, scope/audience registration và public HTTPS domain;
- deployment target và persistent database/volume;
- installer/tray/auto-update cho local runtime;
- UX chọn nhiều thiết bị trong ChatGPT;
- shell mode/PTY/streaming;
- MCP Tasks integration cho long-running command.

Chỉ chốt khi milestone tương ứng cần tới để tránh over-design.
