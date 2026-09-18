# Kiểm thử M5 — CLI local và pairing ChatGPT

M5 ghép local CLI, pairing control channel, public MCP/OAuth và local MCP runtime. Test dùng Bun gateway và MCP Streamable HTTP client thật; OAuth verifier trong test là fixture, không gọi dịch vụ ChatGPT thật.

## Lệnh kiểm tra

```sh
bun run test:m5
bun run test:m4
bun run test:m3
bun run test:local
bun run test:m2
bun run check
bun run typecheck
```

Verification local gần nhất: `test:m5` 37/37, `test:m4` 16/16, `test:m3` 127/127, `test:local` 6/6, `test:m2` 6/6; `check` và `typecheck` xanh. Full Windows `bun test` có 292 pass và 32 fixture symlink fail (`EPERM`). Linux full suite cùng Windows target suites M1–M5 xanh trong [CI run 35359769097](https://github.com/OneTwoTen/doctmcp/actions/runs/35359769097).

Linux CI chạy full `bun test`; Windows CI chạy các target suite riêng để tránh fixture symlink cần quyền không có trên runner local Windows này. Cả hai job đã xanh trên commit `8fa55f8`.

## Flow đã xác nhận tự động

1. `LocalPairingClient` gửi HTTPS start request với channel proof ngẫu nhiên và tạo WSS `/pairing` outbound.
2. CLI chỉ hiển thị code sau frame `pairing.attached` đúng session.
3. OAuth-protected MCP `devices_pair` dẫn xuất owner từ token đã xác minh, claim pairing code một lần và chờ credential ACK.
4. Local lưu credential bằng file provider trước khi gửi ACK; secret không nằm trong MCP result hoặc audit.
5. `LocalBridgeReconnectController` mở authenticated `/bridge`, rồi public MCP gọi `devices_list` và alias tool đúng device.
6. Workspace permission `read` chạy thành công; write bị từ chối khi capability chưa bật.

Các test riêng khóa body/frame bounds, schema strict, rate-limit bucket, proof/session sai, storage failure, generation ACK, timeout/cleanup và cấu hình workspace.

## Chạy local CLI

Tạo JSON config:

```json
{
  "serverUrl": "https://api.example.com",
  "deviceName": "Máy làm việc",
  "credentialPath": "./.doctmcp/device-credential.json",
  "workspaces": [
    {
      "id": "project",
      "name": "Project",
      "root": "./project",
      "capabilities": { "read": true },
      "deny": [".env"]
    }
  ]
}
```

Workspace root và credential path tương đối tính từ thư mục chứa config. Workspace phải tồn tại, không chồng lấp và có ID duy nhất. Capability bỏ trống mặc định `false`. Nếu không khai báo `credentialPath`, provider dùng `~/.doctmcp/device-credential.json`.

```sh
bun run connect:agent -- --config ./doctmcp.json
```

`serverUrl` phải là HTTPS; chỉ loopback mới được dùng HTTP. Server start route chỉ nhận HTTP plaintext từ loopback. Khi TLS kết thúc ở reverse proxy chạy cùng máy, proxy loopback được chấp nhận; nếu proxy ở container/mạng khác, khai báo IP peer chính xác trong `TRUSTED_PROXY_ADDRESSES` và yêu cầu proxy ghi đè `X-Forwarded-Proto=https`. Không dùng địa chỉ proxy do client gửi, CIDR hoặc hostname; forwarded client IP không được tin. Máy local không mở listener inbound.

## Cấu hình ChatGPT và OAuth bên ngoài

- Cấu hình public server với `PUBLIC_MCP_URL=https://<domain>/mcp`, `OIDC_ISSUER` và `OIDC_AUDIENCE` theo [M4 guide](m4-public-mcp.md).
- Đăng ký public MCP endpoint trong ChatGPT Developer Mode theo hướng dẫn hiện hành của workspace/tài khoản.
- Authorization phải dùng Authorization Code + PKCE `S256`, resource/audience đúng `/mcp` và scope `mcp`.
- Redirect URI và client registration phải lấy từ màn hình cấu hình ChatGPT thực tế; không hard-code tenant/client id trong mã nguồn.
- Khởi chạy CLI trên máy cần kết nối và nhập pairing code đang hiển thị vào `devices_pair` bằng cùng tài khoản ChatGPT sở hữu thiết bị.

Repository chưa chứa OIDC tenant, domain HTTPS, OAuth client registration hoặc ChatGPT workspace credentials; vì vậy test tự động chứng minh protocol và flow cục bộ, không khẳng định đã đăng nhập ChatGPT hosted.

## Giới hạn triển khai hiện tại

- Device, pairing, credential completion, rate-limit và channel state mặc định lưu in-memory. Pairing session repository có giới hạn số record, tự dọn record hết hạn khi tạo session mới và được runtime quét định kỳ. Một server process phù hợp cho dev/test; nhiều instance/restart cần adapter persistence và coordination dùng chung.
- Credential provider ghi file nguyên tử với quyền file tối đa nền tảng hỗ trợ. OS keychain, installer và auto-update chưa triển khai.
- `devices_pair` ghi platform metadata là `unknown` vì giao diện tool chỉ nhận pairing code và device name.
- OIDC/ChatGPT live setup, cấu hình TLS proxy, public DNS, durable database và deploy chưa được kiểm tra bằng tài khoản/dịch vụ thật.
