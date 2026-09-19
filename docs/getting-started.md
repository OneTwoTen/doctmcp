# Hướng dẫn cài đặt và sử dụng doctmcp

Tài liệu này dành cho người muốn clone repository, chạy doctmcp local, kết nối một máy local với public server và pairing để MCP client/ChatGPT gọi được local MCP runtime.

> Trạng thái: M1–M6 có implementation và CI local; OIDC, HTTPS domain, OAuth registration và mount Coolify thực tế vẫn cần cấu hình/xác nhận trong deployment. Xem [Coolify SQLite](deployment/coolify-sqlite.md).

## 1. Kiến trúc sử dụng

```text
ChatGPT / MCP client
        │
        │ OAuth + MCP /mcp
        ▼
Public Server
        │
        │ routed MCP client
        ▼
WebSocket /bridge
        │
        │ outbound connection từ local
        ▼
Local MCP Runtime
        │
        ├─ workspace
        ├─ system
        ├─ filesystem.read
        ├─ filesystem.write
        ├─ filesystem.delete
        └─ shell.exec
```

Máy local không cần mở port inbound ra Internet. Local CLI chủ động kết nối tới public server.

## 2. Yêu cầu

- Git.
- Bun 1.4.2.
- Terminal có thể chạy Bun.
- Nếu dùng ChatGPT integration: public HTTPS domain, OIDC authorization server và OAuth client registration.

Kiểm tra:

```sh
git --version
bun --version
```

Không cần npm/yarn/pnpm cho workflow chuẩn của repository.

## 3. Clone và cài dependency

```sh
git clone https://github.com/OneTwoTen/doctmcp.git
cd doctmcp
bun install
```

Kiểm tra sau khi cài:

```sh
bun run check
bun run typecheck
bun test
```

Acceptance suite:

```sh
bun run test:local
bun run test:m2
bun run test:m3
bun run test:m4
bun run test:m5
```

| Lệnh | Phạm vi |
|---|---|
| bun run test:local | Local MCP M1 |
| bun run test:m2 | Public server ↔ local bridge |
| bun run test:m3 | Device, pairing, credential, reconnect, routing |
| bun run test:m4 | Public MCP, OIDC, routing |
| bun run test:m5 | CLI, pairing channel, credential ACK, ChatGPT flow |
| bun run check | Biome |
| bun run typecheck | TypeScript |
| bun test | Toàn bộ test suite |

## 4. Chạy Local MCP Runtime

Local runtime nằm trong apps/agent.

```sh
bun run dev:agent
```

M1 có 6 MCP tools:

- workspace
- system
- filesystem.read
- filesystem.write
- filesystem.delete
- shell.exec

Permission được enforce ở local.

## 5. Chạy Public Server local

Public server nằm trong apps/server.

```sh
DOCTMCP_STORAGE_MODE=memory bun run dev:server
```

Trong PowerShell, đặt `$env:DOCTMCP_STORAGE_MODE = "memory"` trước khi chạy `bun run dev:server`. Local/test chỉ dùng memory khi bật tường minh. Nếu muốn thử SQLite, đặt `DOCTMCP_STORAGE_MODE=sqlite` và `DOCTMCP_DATA_DIR` tới directory có quyền ghi, tách khỏi code/release; production bắt buộc SQLite và persistent volume.

Nếu chưa cấu hình OIDC, gateway/bridge vẫn phục vụ development nhưng public /mcp không được bật.

Mặc định:

```text
BIND_HOST=127.0.0.1
PORT=3000
```

## 6. Cấu hình Public MCP + OIDC

Copy file mẫu:

```sh
cp apps/server/.env.example apps/server/.env
```

PowerShell:

```powershell
Copy-Item apps/server/.env.example apps/server/.env
```

Cấu hình tối thiểu:

```dotenv
PUBLIC_MCP_URL=https://doctmcp.example.com/mcp
OIDC_ISSUER=https://YOUR_AUTH_DOMAIN/
OIDC_AUDIENCE=https://doctmcp.example.com/mcp
BIND_HOST=127.0.0.1
PORT=3000
```

Ba biến public MCP phải được cấu hình cùng nhau. OIDC_AUDIENCE phải trùng chính xác PUBLIC_MCP_URL.

Không commit .env, access token, JWT hoặc client secret.

### Reverse proxy

```text
Internet
   │ HTTPS
   ▼
TLS reverse proxy
   │ HTTP + WebSocket
   ▼
127.0.0.1:3000
```

Nếu proxy chạy ở container/network khác:

```dotenv
BIND_HOST=0.0.0.0
TRUSTED_PROXY_ADDRESSES=<IP-chính-xác-của-proxy>
```

Proxy phải ghi đè X-Forwarded-Proto=https. Không dùng CIDR hoặc hostname trong TRUSTED_PROXY_ADDRESSES.

## 7. Tạo config cho máy local

Tạo file doctmcp.json:

```json
{
  "serverUrl": "https://doctmcp.example.com",
  "deviceName": "Máy làm việc",
  "credentialPath": "./.doctmcp/device-credential.json",
  "workspaces": [
    {
      "id": "project",
      "name": "Project",
      "root": "./project",
      "capabilities": {
        "read": true,
        "write": false,
        "delete": false,
        "execute": false
      },
      "deny": [".env"]
    }
  ]
}
```

Quy tắc:

- serverUrl là origin của public server, không thêm /mcp.
- serverUrl phải là HTTPS; HTTP chỉ hợp lệ cho loopback.
- credentialPath là nơi local lưu device credential.
- Nếu bỏ credentialPath, mặc định là ~/.doctmcp/device-credential.json.
- workspaces phải có ít nhất một workspace.
- root và credentialPath tương đối được resolve từ thư mục chứa file config.
- Mọi capability mặc định là false.
- Chỉ bật read, write, delete, execute khi thực sự cần.
- Workspace phải tồn tại, không chồng lấp và mỗi id phải duy nhất.

## 8. Chạy local CLI

```sh
bun run connect:agent -- --config ./doctmcp.json
```

CLI sẽ:

1. validate config;
2. khởi tạo local MCP runtime;
3. nếu chưa có credential, mở pairing channel outbound;
4. hiển thị pairing code sau khi server xác nhận đúng session;
5. chờ credential được ghép;
6. lưu credential local;
7. mở authenticated /bridge;
8. tự reconnect khi bridge mất kết nối.

Khi đã có credential, lần chạy sau sẽ bỏ qua pairing.

Dừng bằng Ctrl+C.

## 9. Pairing lần đầu

Pairing cần public MCP endpoint đã có OAuth/OIDC.

Trong MCP client đã đăng nhập bằng account sở hữu device, gọi tool devices_pair với pairing code đang hiển thị.

Flow:

```text
Local CLI
  │
  ├─ POST /pairing/sessions
  ├─ WebSocket /pairing
  │
  ▼
Public Server
  │
  │ devices_pair + OAuth
  ▼
Claim pairing code
  │
  ▼
Credential delivery
  │
  ▼
Local lưu credential
  │
  └─ ACK
```

Server không trả raw credential vào MCP result. Local phải lưu credential thành công trước khi ACK.

## 10. Kết nối ChatGPT

Cần có:

1. public HTTPS domain;
2. OIDC authorization server;
3. discovery/JWKS qua HTTPS;
4. access token có audience đúng PUBLIC_MCP_URL;
5. scope mcp;
6. OAuth Authorization Code + PKCE S256;
7. MCP client/ChatGPT Developer Mode được đăng ký với public MCP endpoint.

Public MCP URL:

```text
https://<domain>/mcp
```

Sau khi MCP endpoint được đăng ký và OAuth hoạt động:

1. chạy connect:agent trên máy local;
2. lấy pairing code;
3. dùng devices_pair trong ChatGPT;
4. chờ CLI báo pairing hoàn tất;
5. giữ CLI chạy để duy trì bridge;
6. gọi devices_list để kiểm tra device;
7. gọi các local tools qua alias chứa deviceId.

Redirect URI và client registration phải lấy từ cấu hình OAuth thực tế; không tự đoán hoặc hard-code vào repository.

## 11. Kiểm tra end-to-end

```text
ChatGPT
  ↓
/mcp + OAuth
  ↓
device routing
  ↓
MCP client persistent
  ↓
/bridge WebSocket
  ↓
Local MCP
  ↓
workspace permission
  ↓
tool
```

Nên bắt đầu bằng capability read-only. Chỉ bật write/delete/execute sau khi read-only flow hoạt động.

## 12. Troubleshooting

### Public MCP is disabled

Kiểm tra:

```text
PUBLIC_MCP_URL
OIDC_ISSUER
OIDC_AUDIENCE
```

Cả ba phải được cấu hình.

### OIDC_AUDIENCE không khớp

Nếu:

```text
PUBLIC_MCP_URL=https://example.com/mcp
```

thì:

```text
OIDC_AUDIENCE=https://example.com/mcp
```

### CLI báo INVALID_SERVER_URL

serverUrl phải là origin:

```json
{
  "serverUrl": "https://example.com"
}
```

Không dùng https://example.com/mcp cho serverUrl.

### Pairing code không xuất hiện

Kiểm tra public server, HTTPS, WebSocket upgrade, OIDC config và reverse proxy/TLS scheme.

### Device online nhưng tool bị từ chối

Kiểm tra capability của workspace. write/delete/execute sẽ bị deny nếu chưa bật.

### Pairing xong nhưng lần chạy sau lại pair

Kiểm tra credentialPath, quyền ghi file và file ~/.doctmcp/device-credential.json.

### Restart server làm mất device/pairing state

Kiểm tra `DOCTMCP_STORAGE_MODE` (production cần `sqlite`) và persistent volume `DOCTMCP_DATA_DIR`. Nếu chạy `memory`, dữ liệu chỉ tồn tại trong process. Trong Coolify, mount volume riêng vào `/data` và dùng lại volume đó khi redeploy/recreate; xem [hướng dẫn SQLite](deployment/coolify-sqlite.md). Trạng thái online chỉ trở lại sau khi local bridge reconnect.

## 13. Những gì chưa production-ready

Implementation M1–M5 đã có local acceptance và cross-platform CI, nhưng deployment thật vẫn cần:

- OIDC tenant/provider thực tế;
- public HTTPS domain;
- OAuth client registration;
- xác nhận persistent volume và container recreate trên Coolify thực tế (code SQLite đã triển khai);
- multi-instance deployment coordination (không thuộc M6);
- production reverse proxy/TLS;
- installer/OS service/auto-update cho local runtime;
- production monitoring.

dev:server chạy thành công không đồng nghĩa ChatGPT hosted đã kết nối được.

## 14. Workflow contributor

Sau khi clone:

```sh
bun install
bun run check
bun run typecheck
bun test
```

Khi sửa subsystem:

```text
đọc architecture/spec
  ↓
sửa implementation
  ↓
thêm/sửa test
  ↓
chạy acceptance suite liên quan
  ↓
bun run check
bun run typecheck
bun test
  ↓
review diff
```

Tài liệu domain phải được cập nhật cùng thay đổi khi sửa architecture, protocol, pairing, permission hoặc security boundary.

Xem thêm:

- development.md
- project-playbook.md
- architecture.md
- pairing.md
- security.md
- testing/m5-chatgpt.md
- deployment/coolify-sqlite.md
