# Quyết định: Public MCP endpoint và xác thực người dùng

## Trạng thái

Đã chốt cho M4. Các adapter vận hành thực tế (issuer, audience, URL public và database) được cấu hình khi triển khai.

## Bối cảnh

M1–M3 đã chứng minh local MCP, bridge do local chủ động mở, identity/pairing thiết bị và routing an toàn theo owner cùng `deviceId`. M4 cần cho MCP client từ xa gọi capability MCP trên đúng thiết bị đã pair mà không tạo một protocol thực thi tool thứ hai.

Các quyết định framework HTTP, user authentication, public MCP transport và mapping nhiều thiết bị chưa được khóa trong tài liệu trước đó.

## Quyết định

1. Dùng một Bun `fetch(Request) => Response` listener cho `/bridge`, `/mcp` và các route discovery. Dùng Streamable HTTP từ SDK TypeScript chính thức `@modelcontextprotocol/server` qua `createMcpHandler`; giữ custom WebSocket bridge hiện có.
2. `/mcp` là MCP server stateless theo HTTP request. Factory dựng tool set từ principal đã xác thực cho mỗi request. Client MCP upstream của local device được giữ lâu dài theo đúng `BridgeGatewaySession`, initialize một lần và tái sử dụng cho `tools/list`/`tools/call`.
3. Public server là OAuth resource server, không tự phát access token. Dùng external OpenID Connect authorization server tương thích OAuth 2.1; discovery phải công bố Authorization Code và PKCE `S256`. Xác minh JWT chữ ký qua OIDC discovery/JWKS, issuer, audience, `exp`, `sub` và scope. Chuỗi `OIDC_ISSUER` giữ nguyên chính xác, không chuẩn hóa qua `URL.href`; nó phải khớp chính xác discovery và JWT. Giữ nguyên các trường OAuth client registration/issuer-response mà provider công bố; không tự quảng bá refresh-token grant hoặc PKCE support mà provider không công bố. `OIDC_AUDIENCE` phải bằng chính xác `PUBLIC_MCP_URL`. Production chỉ dùng HTTPS. Adapter không khóa vào một nhà cung cấp.
4. Principal ổn định được suy ra từ chuỗi `issuer + sub` đã xác minh bằng SHA-256 có domain prefix; không dùng `client_id` làm user identity và không lưu email/tên từ token làm owner key. Issuer khác nhau, kể cả chỉ khác dấu `/` cuối, là identity khác nhau. Cùng `issuer + sub` luôn cho cùng `ownerId` opaque.
5. `tools/list` tổng hợp tool của các thiết bị online; catalog vừa khám phá được giữ trong process khi thiết bị đó offline để alias cũ còn có thể trả lỗi tường minh. Alias gắn với full `deviceId` canonical để tên thiết bị trùng không va chạm. Input/output schema và result giữ contract MCP gốc. `devices_list` là tool quản lý trạng thái; không thêm `device.call` hay RPC tương đương.
6. Mọi lần list/call đều route lại bằng `{ ownerId, deviceId }`; trạng thái online ở thời điểm discovery không phải authorization. Tool call cũ sau disconnect trả lỗi MCP `DEVICE_OFFLINE` và không fallback sang thiết bị khác. Cache catalog chỉ tồn tại trong process, không phải persistence.
7. Audit hook chỉ nhận metadata: principal opaque, `deviceId`, tên MCP tool, thời gian, duration, outcome/error code. Không ghi input, file content, command output, token hoặc credential.

## Hệ quả và đánh đổi

- Tool name gồm prefix thiết bị, vì vậy model thấy định danh ổn định dù hai thiết bị có cùng display name. UI chọn thiết bị thân thiện hơn có thể được thêm tại M5 bằng MCP Apps mà không đổi routing contract.
- Tạo tool set theo từng HTTP request có chi phí upstream `tools/list`; client upstream persistent theo bridge session để không lặp `initialize` và không làm sai lifecycle MCP local.
- OIDC provider, public HTTPS domain, production database và audit sink phải được cấu hình bởi môi trường triển khai; source code không chứa tenant, token hay secret.
- Repositories in-memory hiện tại tiếp tục dùng cho acceptance/development. M4 không tuyên bố chúng là persistence production; production deployment phải inject adapter bền vững và coordination phù hợp trước khi mở cho nhiều process.
- Endpoint không sẵn sàng khi auth chưa cấu hình; public MCP phải fail closed.

## Tiêu chí chấp nhận

- `initialize`, `tools/list`, `tools/call` qua Streamable HTTP thật, auth JWT hợp lệ và WebSocket tới local MCP thật.
- Thiếu/sai/expired JWT, issuer/audience sai hoặc thiếu scope bị từ chối trước MCP.
- Caller chỉ thấy/route được device thuộc principal; duplicate device name vẫn map duy nhất; offline/disconnect không fallback.
- Local MCP error/result giữ nguyên MCP semantics; audit không chứa tool arguments hay result content.
- M1/M2/M3 regression cùng lint, typecheck và test mục tiêu pass.

## Nguồn kỹ thuật

- [MCP TypeScript SDK — HTTP serving](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md)
- [MCP TypeScript SDK — OAuth resource server](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/authorization.md)
- [OpenAI — Xác thực MCP app](https://developers.openai.com/plugins/build/auth)
- [OpenID Connect Discovery 1.0](https://openid.net/specs/openid-connect-discovery-1_0.html)

## Lịch sử

| Ngày | Thay đổi | Lý do | Trạng thái |
|---|---|---|---|
| 2026-09-17 | Chốt Streamable HTTP, OIDC resource server, principal và mapping tool theo thiết bị | Bắt đầu M4 sau khi M3 local target suite đã qua; cần khóa boundary trước implementation | approved |
| 2026-09-17 | Yêu cầu discovery quảng bá PKCE `S256` và chuyển nguyên trạng các capability OAuth được provider công bố | Đảm bảo ChatGPT không nhận metadata giả về CIMD/DCR, issuer response hoặc refresh grant | approved |
| 2026-09-18 | Giữ nguyên issuer OIDC đã cấu hình khi so metadata, JWT và tạo owner identity | URL normalization có thể gộp issuer khác nhau hoặc từ chối issuer không có dấu `/` cuối | approved |
