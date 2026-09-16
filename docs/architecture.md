# Kiến trúc doctmcp

## Trạng thái foundation hiện tại

Repository hiện đã có:

- Bun 1.4.2 + TypeScript 7 strict.
- Bun workspaces cho `apps/*` và `packages/*`.
- Biome, TypeScript typecheck, Bun test và GitHub Actions CI.
- `apps/agent` đã có local MCP runtime và `BridgeServerTransport`; `apps/server` đã có WebSocket gateway, `BridgeClientTransport`, device/pairing repositories, credential lifecycle/completion và production runtime cho authenticated bridge.
- `packages/protocol` giữ bridge control-plane contract; `packages/schemas` đã có shared bridge, `Device`, pairing và device-credential schemas.

MCP server local và custom WebSocket bridge M2 đã hoàn tất. M3.1–M3.3 cũng đã hoàn tất: immutable device identity, atomic pairing code lifecycle, long-lived credential lifecycle và authenticated bridge handshake đã có implementation + regression coverage. M3.4/#33 là task active hiện tại; authoritative device-session registry, heartbeat/online state và cross-instance invalidation vẫn **chưa được coi là đã triển khai** cho tới khi #33 hoàn tất.

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

M3.4/#33 bổ sung authoritative session registry keyed bằng `deviceId`, duplicate-session policy, heartbeat/liveness, online/offline derived state và generation-aware cross-instance revoke/rotate invalidation. Public MCP endpoint thuộc M4.

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

M3 hiện hoàn tất 3/7 work item:

- ✅ M3.1/#30 — immutable device identity + persistence contract qua PR #37;
- ✅ M3.2/#31 — pairing session/code lifecycle + atomic claim qua PR #38;
- ✅ M3.3/#32 — device credential lifecycle + authenticated bridge handshake qua PR #39 (`163fb899`);
- ⏳ M3.4/#33 — device session registry, heartbeat và online/offline state — task active.

Foundation đã khóa:

- immutable UUID v4 `deviceId`, canonical lowercase;
- owner identity tách khỏi display metadata;
- owner-scoped `DeviceRepository` contract;
- one-time pairing code 60-bit, TTL, digest-only persistence và atomic claim;
- credential secret 256-bit, digest-only server persistence, generation-aware CAS, revoke/rotate và crash-safe completion recovery;
- authenticated bridge bind server-side owner/device identity trước MCP traffic;
- same-process lifecycle linearization chặn rotate/revoke chen vào pairing recovery/ready boundary;
- strict `bridge.hello.auth` schema và generic auth failure không leak raw credential.

M3.4 phải xây registry generation-aware để cùng `deviceId` có session ownership/liveness deterministic, chốt duplicate connection policy, derive online/offline state và propagate credential invalidation cross-instance trong bounded default ≤ 5 giây mà không đóng nhầm session generation mới.

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
- Không khóa framework HTTP public server trước khi public endpoint production thực sự cần.
- Breaking change của custom bridge/control plane phải có version/compatibility strategy riêng; không trộn version này với MCP protocol version.
- Thêm tool mới dựa trên semantic/permission boundary, không dựa trên mục tiêu làm `tools/list` ngắn bằng mọi giá.

## Phần chưa chốt

Các quyết định sau vẫn chưa cần khóa sau M3.3:

- framework HTTP cuối cùng của public server;
- production database adapter cho user/device registry;
- cơ chế user authentication của public endpoint;
- persistence/audit log ngoài Device/credential foundation hiện có;
- installer/tray/auto-update cho local runtime;
- UX chọn nhiều thiết bị trong ChatGPT;
- shell mode/PTY/streaming;
- MCP Tasks integration cho long-running command.

Chỉ chốt khi milestone tương ứng cần tới để tránh over-design.
