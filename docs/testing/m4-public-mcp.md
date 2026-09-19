# Kiểm thử M4 — Public MCP endpoint

## Phạm vi

`bun run test:m4` kiểm tra public Streamable HTTP, OAuth resource-server challenge/metadata, OIDC JWT verification, MCP client persistent theo bridge session, routing theo `deviceId` và audit metadata.

Suite chạy end-to-end bằng Bun listener, WebSocket bridge thật, local MCP server thật và client Streamable HTTP chính thức. Test không cần tenant OIDC, token thật hoặc public domain.

## Lệnh

```sh
bun run test:m4
```

## Acceptance được khóa

- OIDC discovery phải khớp chính xác chuỗi issuer cấu hình (kể cả dấu `/` cuối) và endpoint/JWKS chỉ được dùng qua HTTPS.
- JWT có chữ ký, issuer, audience, `sub`, `exp` và client id hợp lệ; token hết hạn, sai issuer/audience, thiếu claim bắt buộc hoặc chữ ký sai bị từ chối.
- `ownerId` là hash opaque ổn định của `issuer + sub`; `client_id` không trở thành owner identity.
- `/mcp` thiếu token trả 401 Bearer challenge có RFC 9728 `resource_metadata`; thiếu scope `mcp` trả 403.
- Protected Resource Metadata chỉ rõ đúng URL `/mcp` và authorization server issuer.
- Public MCP chạy trên cùng Bun listener với `/bridge`, qua MCP Streamable HTTP thật.
- Hai thiết bị trùng tên có prefix tool không va chạm; mỗi alias gọi đúng workspace của thiết bị.
- Public tool giữ cả `inputSchema` và `outputSchema` nếu local MCP cung cấp.
- Upstream MCP `Client` được initialize một lần cho mỗi authenticated `BridgeGatewaySession` và dùng lại cho tool calls.
- `devices_list` trả trạng thái/metadata tối thiểu, không trả `ownerId`, credential hoặc session internals.
- Khi thiết bị đã quảng bá tool bị offline, alias cache trả `DEVICE_OFFLINE`; không route sang session khác.
- Audit gồm principal opaque, device, tool, timestamp, duration và outcome; không gồm input hay result content.

## Cấu hình tích hợp ChatGPT

### Điều kiện trước khi kết nối

`apps/server/.env.example` mô tả ba giá trị cần thiết: `PUBLIC_MCP_URL`, `OIDC_ISSUER` và `OIDC_AUDIENCE`. Đặt `PUBLIC_MCP_URL` là URL HTTPS công khai kết thúc bằng `/mcp`; `OIDC_AUDIENCE` phải khớp chính xác URL đó. Authorization server bên ngoài phải hỗ trợ Authorization Code + PKCE S256, trả JWT access token có `aud` đúng URL MCP, `sub` ổn định, `client_id` hoặc `azp`, và scope `mcp`.

ChatGPT cần giữ đăng nhập sau khi access token hết hạn. Cấu hình authorization server phát refresh token cho `offline_access`, quảng bá scope này trong discovery và cho phép scope đó trên OAuth client. Discovery phải quảng bá PKCE `S256`. Hỗ trợ phương thức đăng ký client mà ChatGPT chọn: CIMD (`client_id_metadata_document_supported`) hoặc DCR (`registration_endpoint`); nếu dùng OAuth client cấu hình sẵn, allowlist chính xác redirect URI mà trang cấu hình MCP của ChatGPT hiển thị. ChatGPT gửi resource identifier trong authorization/token request; IdP phải giữ giá trị đó trong `aud` của access token. Nếu discovery quảng bá `authorization_response_iss_parameter_supported`, IdP phải trả `iss` khớp chính xác issuer trong mọi authorization response. Không đoán redirect URI hoặc audience.

Pair ít nhất một thiết bị cho đúng tài khoản trước khi quét tools và để local runtime online. `tools/list` chỉ phát hiện tools của thiết bị đang online; catalog offline chỉ được cache trong memory của server. Công cụ xuất hiện dưới alias `d_<deviceId>__<toolName>`, còn `devices_list` cho biết thiết bị nào đang online. Môi trường mặc định của dự án dùng repositories in-memory; chưa dùng để phục vụ triển khai production hoặc nhiều process.

### Tạo app MCP nháp và kiểm thử

1. Trong ChatGPT web, bật Developer Mode nếu workspace và gói tài khoản cho phép. Vào **Settings → Apps → Create** hoặc mục tạo app tương đương trong workspace settings.
2. Nhập URL `PUBLIC_MCP_URL`, chọn OAuth, rồi chạy **Scan Tools**. Hoàn tất màn hình đăng nhập/ủy quyền của IdP và đợi quét kết thúc.
3. Tạo app nháp. Mở chat mới, chọn app và gọi `devices_list`, sau đó gọi một tool đọc trên thiết bị đang online. Kiểm tra kết quả thuộc đúng thiết bị có `deviceId` trong alias.
4. Kiểm tra offline bằng cách ngắt local runtime sau khi tool đã được quét; call alias cũ phải báo offline, không chuyển sang thiết bị khác. Kết nối lại runtime rồi quét/refresh tools.
5. Kiểm thử riêng write/delete/shell khi đã sẵn sàng; local permission engine vẫn là nơi quyết định cuối cùng. ChatGPT có thể yêu cầu xác nhận theo action và chính sách workspace.

Developer Mode, MCP đầy đủ và quyền dùng custom app hiện tùy gói/workspace; giao diện, quyền và mức hỗ trợ có thể thay đổi. Sau khi workspace publish app, ChatGPT có thể giữ snapshot tool definitions; refresh/scan lại khi tool schema thay đổi. Xem hướng dẫn [Developer Mode và MCP apps trong ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt) và [OAuth authentication cho MCP apps](https://developers.openai.com/plugins/build/auth).

Issuer, audience, domain hoặc credential thật không nằm trong repository. Chưa chạy kiểm thử thật qua ChatGPT hoặc IdP vì chưa có public deployment và cấu hình authorization server; test Bun local không thay thế bước đó.

## Kết quả hiện tại

Verification local mới nhất trên Windows với Bun 1.4.1 (repo ghim 1.4.2):

- `bun run test:m4`: 16 test, 75 assertion — pass.
- `bun run test:local`: 6 test, 188 assertion — pass.
- `bun run test:m2`: 6 test, 24 assertion — pass.
- `bun run test:m3`: 127 test, 475 assertion — pass.
- `bun run check` và `bun run typecheck` — pass.
- `bun test`: 292 pass, 32 fail (1215 assertion). Cả 32 lỗi đều do fixture `filesystem.read`/`filesystem.write` tạo symlink nhận `EPERM` trên Windows.

Workflow CI chạy các acceptance M1–M5 trên Windows và full suite/quality checks trên Linux; [run 35359769097](https://github.com/OneTwoTen/doctmcp/actions/runs/35359769097) đều xanh. Chưa xác thực với IdP hoặc ChatGPT thật vì chưa có public domain và cấu hình authorization server.
