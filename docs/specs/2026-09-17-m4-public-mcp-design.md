# M4 — Public MCP endpoint và device routing

## Mục tiêu

Cho MCP client từ xa gọi MCP tools trên các local runtime đã pair qua public server, có user authentication và owner-scoped routing.

## Phạm vi

- Bun web-standard HTTP route `/mcp` sử dụng MCP Streamable HTTP chính thức.
- OAuth 2.1/OIDC resource-server gate, discovery metadata và JWT verification. Authorization server discovery phải xác nhận Authorization Code + PKCE `S256`; các capability tùy chọn như CIMD, DCR, issuer identification, token endpoint auth methods và grant types chỉ được advertise khi provider công bố.
- Principal opaque, ổn định từ issuer và subject đã xác minh.
- Tổng hợp tool đang hoạt động của owner với alias theo full `deviceId`; giữ tool catalog vừa khám phá trong process để alias cũ báo offline tường minh.
- Một MCP `Client` persistent cho mỗi authenticated bridge session; không initialize lại trước từng call.
- Device status tool, lỗi offline/unknown/disconnect, audit metadata hook.
- Acceptance end-to-end public HTTP → server MCP client → WebSocket → local MCP server thật.

## Ngoài phạm vi

- Tự phát OAuth token, đăng nhập/password database hoặc quản lý authorization server.
- Chọn/mời/revoke user trên web dashboard.
- Production database adapter và shared distributed lock. Các interface phải injectable; hiện tại adapter mặc định in-memory chỉ dành cho dev/test.
- Pairing UX cho người dùng cuối, widget ChatGPT hoặc publish/deploy endpoint.
- Expose local MCP server ra public network.
- Tạo `device.call`, `command.request`, hoặc RPC bọc `tools/call`.

## Luồng chính

```text
MCP client
  -> POST /mcp (Bearer JWT)
  -> OIDC validation + scope `mcp`
  -> derive opaque ownerId from (iss, sub)
  -> per-request MCP server factory
  -> list owned online devices and upstream MCP tools
  -> MCP tool alias namespaced by canonical deviceId
  -> tools/call resolves owner + device again
  -> persistent MCP Client for exact BridgeGatewaySession
  -> WebSocket bridge -> local MCP server -> original result/error
```

## Contract

- MCP path cố định `/mcp`; discovery route được sinh từ URL MCP đầy đủ.
- Mọi tool proxy giữ nguyên schema JSON input/output của local MCP, tool result và `isError`; tên công khai có prefix `d_<deviceIdHex32>__`.
- `devices_list` trả `{deviceId, deviceName, status, metadata}` của owner đã xác thực; không có session/credential/owner internals.
- Device online được discovery trực tiếp; catalog cached của device vừa offline được giữ để callback trả mã `DEVICE_OFFLINE`. Mọi call route lại và yêu cầu exact credential generation hợp lệ.
- Khi device disconnect trong lúc call, request kết thúc với MCP error; call sau báo `DEVICE_OFFLINE`. Không chọn session thay thế ngầm.
- OIDC claims yêu cầu `iss`, `sub`, `exp`, `client_id` hoặc `azp`, và audience đã cấu hình. Scope lấy từ `scope` hoặc `scp`; cần `mcp`.
- Giữ nguyên chuỗi `OIDC_ISSUER` cấu hình khi so sánh với discovery/JWT và khi dẫn xuất owner; issuer có và không có dấu `/` cuối là hai identity khác nhau.
- Không thay thế metadata discovery thiếu bằng giá trị phỏng đoán cho `code_challenge_methods_supported` hoặc `grant_types_supported`; startup từ chối provider không quảng bá PKCE `S256` và authorization code.
- `OIDC_AUDIENCE` phải khớp chính xác `PUBLIC_MCP_URL` theo RFC 8707 resource binding.
- `AuthInfo.extra.ownerId` chứa principal opaque do verifier tạo; caller không thể tự gửi owner id qua tool input.
- Audit callback nhận mã kết quả, không nhận argument/result.

## Bảo mật và lỗi

- Không auth, token sai/hết hạn, claim không hợp lệ: HTTP 401 với Bearer challenge và `resource_metadata`.
- Token hợp lệ nhưng thiếu scope: HTTP 403 `insufficient_scope`.
- Sai issuer/audience, JWT alg không được chấp nhận hoặc chữ ký sai: generic invalid token.
- Device sai owner/không tồn tại: `DEVICE_NOT_FOUND`; offline: `DEVICE_OFFLINE`; routing/storage: `ROUTING_UNAVAILABLE`.
- Tool alias không tồn tại trả lỗi tool MCP; không decode tên display để suy ra owner hoặc route.
- Không trả raw exception, JWT claim hoặc authorization header ra client/log.
- Metadata endpoints cho phép CORS theo MCP SDK; `/mcp` auth gate giữ token validation ở server.

## Kiểm thử chấp nhận

1. HTTP MCP client initialize/list/call qua 2 authenticated local WebSocket sessions thật.
2. Tool list có namespace không va chạm khi hai device cùng tên; mỗi alias gọi đúng workspace; alias đã cache trả `DEVICE_OFFLINE` khi mất kết nối.
3. Tool call với token của owner khác, tool alias sai hoặc device offline không chạm runtime còn lại.
4. JWT test ký bằng fixture JWKS: valid, expired, wrong issuer, wrong audience, no subject, no scope, wrong signature.
5. Một session upstream chỉ initialize một lần dù nhiều request HTTP đồng thời; reconnect tạo MCP Client mới và route lại cùng device id.
6. Giữ nguyên structured MCP result/error; audit chỉ ghi metadata.
7. M1/M2/M3 target acceptance, `bun run check`, `bun run typecheck` và full suite trên môi trường có symlink support.

## History

| Ngày | Thay đổi | Lý do | Trạng thái |
|---|---|---|---|
| 2026-09-17 | Khởi tạo đặc tả public endpoint M4 | Khóa contract trước implementation | approved |
| 2026-09-17 | Chốt PKCE S256 bắt buộc và OAuth discovery metadata phải phản ánh đúng capability của provider | Tương thích OAuth 2.1 và tránh quảng bá khả năng chưa được xác nhận | approved |
