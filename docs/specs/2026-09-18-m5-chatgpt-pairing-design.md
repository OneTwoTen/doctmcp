# M5 — CLI local và ghép nối ChatGPT

## Mục tiêu

Cho người dùng cấu hình một local runtime, ghép runtime đó với tài khoản ChatGPT qua public MCP endpoint, rồi gọi tool local qua luồng MCP đã hoàn tất ở M4.

Đặc tả này mở rộng pairing control plane đã có ở M3 và thêm CLI để chạy `Local MCP Runtime`. Nó không thay đổi MCP data plane: tool local vẫn được gọi bằng `tools/list` và `tools/call` qua MCP Streamable HTTP và WebSocket bridge hiện hành.

## Phạm vi

- CLI local đọc cấu hình workspace, chạy pairing lần đầu và khởi động local MCP runtime.
- Kết nối outbound riêng tới server cho pairing; local không mở cổng inbound.
- MCP tool `devices_pair` được bảo vệ bởi OAuth hiện có, lấy owner từ principal đã xác thực và nhận pairing code do CLI hiển thị.
- Device credential chỉ đi trên kênh pairing outbound đã gắn với đúng session; CLI lưu credential qua `DeviceCredentialProvider` trước khi ACK.
- Sau khi lưu credential, CLI mở bridge đã xác thực và tự reconnect bằng `LocalBridgeReconnectController`.
- Giữ `devices_list`, tool alias theo `deviceId`, permission local và annotations hiện hành.
- Hướng dẫn kết nối public MCP endpoint với ChatGPT Developer Mode và OAuth provider tương thích.

## Ngoài phạm vi

- ChatGPT App có widget/MCP Apps UI, dashboard quản lý thiết bị hoặc OAuth authorization server riêng.
- Cấp quyền vượt các capability workspace mà chủ máy đã cấu hình.
- Expose local MCP server ra mạng hoặc tạo RPC thực thi tool ngoài MCP.
- Production database, distributed lock, shared rate-limit store, tenant/OIDC setup hay deploy domain. Runtime mặc định hiện dùng repository in-memory; deployment nhiều instance cần adapter bền vững và coordination dùng chung trước khi được coi là production-ready.
- Tự động cài đặt hệ thống, auto-update hoặc quản trị credential bằng OS keychain.

## Actor và dữ liệu nhạy cảm

- **Local CLI**: tạo pairing session, tạo bí mật kênh ngẫu nhiên, hiển thị pairing code sau khi kênh đã gắn, lưu device credential và chạy MCP runtime.
- **ChatGPT/MCP client**: dùng access token OAuth của người dùng để gọi `devices_pair`, rồi dùng những tool do thiết bị đó cung cấp.
- **Public server**: sở hữu pairing state, xác thực OAuth owner, cấp credential và chuyển đúng credential tới đúng kênh local.
- **Pairing code**: bearer code ngắn hạn, một lần, hiện có entropy 60 bit và TTL 5 phút.
- **Pairing channel proof**: bí mật CSPRNG 256 bit chỉ sống trong lúc ghép nối; server chỉ giữ digest có domain prefix. Pairing session ID tự nó không cấp quyền attach.
- **Device credential**: secret 256 bit dài hạn; chỉ lưu tại local và digest phía server. Không được trả trong MCP result, log hoặc audit event.
- **TLS proxy**: chỉ tin `X-Forwarded-Proto=https` khi IP peer trực tiếp khớp chính xác một entry trong `TRUSTED_PROXY_ADDRESSES`; không dùng forwarded header để xác định client IP. Không hỗ trợ wildcard, CIDR hoặc hostname trong danh sách.

## Luồng chính

```text
Người dùng chạy CLI với cấu hình workspace
  -> CLI tạo channel proof ngẫu nhiên
  -> HTTPS POST /pairing/sessions {deviceName, proof}
  <- pairingSessionId + pairingCode + expiresAt
  -> WebSocket outbound /pairing; attach {pairingSessionId, proof}
  <- attached
  -> CLI mới hiển thị pairingCode và chờ claim

ChatGPT MCP client (OAuth token hợp lệ)
  -> devices_pair {pairingCode, deviceName}
  -> ownerId lấy từ AuthInfo đã xác thực; không nhận ownerId từ arguments
  -> claim code atomic + tạo device + cấp credential
  -> server gửi pairing.credential qua socket gắn với đúng pairingSessionId
  <- local kiểm tra schema, ghi credential nguyên tử, rồi gửi pairing.ack
  <- devices_pair trả deviceId/deviceName/status an toàn; tuyệt đối không trả credential

Local CLI
  -> khởi động local MCP server với workspace/capability đã cấu hình
  -> mở bridge WebSocket authenticated bằng credential vừa lưu
ChatGPT
  -> devices_list và tool aliases -> MCP tools/call -> bridge -> local MCP tools/call
```

## Contract và quyết định thiết kế

### CLI và workspace

- Thêm lệnh `connect` cho agent package. Lệnh nhận config path/server URL; config khai báo tên thiết bị, credential path và một hay nhiều workspace với capability `read`, `write`, `delete`, `execute` cùng deny paths.
- Workspace capability mặc định là `false`; CLI không bật `delete` hoặc `execute` ngầm. Không nhận một workspace root bất kỳ từ lời gọi `devices_pair`; quyền luôn đến từ cấu hình local.
- Nếu đã có credential hợp lệ thì CLI bỏ qua pairing và chạy reconnect controller. Nếu chưa có thì hoàn tất pairing trước khi mở bridge.
- Credential được ghi bằng file provider hiện có với atomic replace và giới hạn quyền file tối đa mà nền tảng hỗ trợ. CLI không in config secret, channel proof hay credential.
- `Ctrl+C`/SIGTERM dừng reconnect controller, transport và MCP runtime theo thứ tự cleanup hiện có.

### Pairing control plane

- Server thêm HTTP start route và WebSocket pairing path riêng. Start route chỉ dành cho tạo phiên chưa được pair; nó không cấp device credential. WSS/HTTPS bắt buộc ngoài loopback production.
- HTTP start route và hai WebSocket path `/bridge` + `/pairing` dùng cùng Bun listener. Gateway dispatch theo pathname và socket kind; pairing frame đi qua schema/handler riêng ở `packages/protocol` hoặc server boundary, không qua `bridgeMessageSchema`. Start route nhận body nhỏ có giới hạn và dùng server-derived remote address cho rate limit, không tin forwarded IP header nếu proxy chưa cấu hình trust rõ.
- CLI sinh channel proof cục bộ bằng CSPRNG, gửi qua HTTPS và giữ trong RAM. Server kiểm tra proof theo digest constant-time, chỉ lưu digest và gắn một socket hoạt động với session.
- CLI chỉ hiển thị pairing code sau khi server xác nhận attach. Socket reconnect chỉ được chấp nhận cùng proof và trong thời gian session còn hiệu lực; attach cạnh tranh bị từ chối.
- Message schema pairing chỉ chứa control-plane event tối thiểu: `attach`, `attached`, `credential`, `ack`, `error`, `close`. Nó không mang `tools/list`, `tools/call`, tool arguments hay tool results.
- Claim tạo ra credential gắn với owner/device đã claim. Server gửi credential đến waiter theo `pairingSessionId` và chờ ACK sau khi local đã lưu bền vững. MCP response chỉ trả metadata thiết bị không nhạy cảm.
- Claim attempt được giới hạn theo owner đã xác thực; số pairing session/socket chờ có giới hạn và TTL. Không ghi pairing code, channel proof, credential, Authorization header hay nội dung message vào log.
- Nếu phiên hết hạn, code đã dùng, proof sai, socket không khớp, delivery timeout, credential persistence lỗi hoặc ACK sai generation: trả error code generic phù hợp, không để code dùng lại và không báo bí mật/chi tiết xác thực cho caller.
- Start failure đóng/thu hồi phiên chưa hiển thị code; delivery timeout sau claim không được trả success. Vì claim là one-time, timeout cần được nêu rõ để người dùng bắt đầu pairing code mới; không cố tái sử dụng code đã claim.

### MCP surface và ChatGPT

- Thêm `devices_pair` vào public MCP server. Input gồm `pairingCode` và `deviceName`; `ownerId` được suy ra chỉ từ OAuth principal đã xác minh. Tool result chỉ gồm `deviceId`, `deviceName`, trạng thái pairing và hướng dẫn chờ thiết bị online.
- Description yêu cầu ChatGPT hỏi pairing code từ người dùng; không tự suy diễn code, không đọc code từ local filesystem và không tự gọi tool lặp lại sau lỗi.
- `devices_list` và alias tool giữ nguyên theo M4; mô tả alias tiếp tục nêu device name và ID để model chọn đúng thiết bị. Offline/disconnect giữ lỗi tường minh và không fallback sang device khác.
- Hướng dẫn cấu hình ChatGPT dùng endpoint HTTPS `/mcp`, OAuth Authorization Code + PKCE `S256`, audience/resource binding đúng M4 và scope `mcp`. Redirect URI/client registration phải lấy từ cấu hình Developer Mode thực tế; không hard-code tenant hoặc giả định quyền truy cập ChatGPT workspace.
- Người dùng cấp quyền cho owner khi nhập pairing code vào tài khoản ChatGPT đang đăng nhập. CLI hiển thị cảnh báo rõ rằng mọi capability đã bật cho workspace sẽ khả dụng với owner đó.

## Bảo mật, lỗi và vòng đời

- Pairing code không phải credential dài hạn. Claim sai/hết hạn/đã dùng đều trả lỗi chung; code chỉ claim một lần.
- Credential chỉ được gửi sau khi claim thành công, qua TLS tới đúng socket được xác thực bằng proof. Không lưu raw credential ở server persistence; buffer/cache tạm phải bị xóa khi ACK hoặc hết hạn.
- Local ghi credential trước ACK. ACK chứa `pairingSessionId`, `deviceId`, `credentialId`, `version`; server kiểm tra owner/device/generation chính xác trước khi đánh dấu delivered.
- Nếu lưu credential thất bại, local không ACK và không mở bridge. CLI báo lỗi storage an toàn; server không báo pairing thành công cho ChatGPT.
- Revoke/rotate vẫn dùng lifecycle hiện tại: bridge generation cũ mất hiệu lực. Pairing không bỏ qua local permission checks.
- Start route và attach có giới hạn tốc độ/kích thước, số lượng pending có bound, timeout, đóng socket và cleanup idempotent. Guard/store là injectable; adapter mặc định trong-memory chỉ phù hợp dev/single instance.
- Runtime restart làm mất socket/proof cache mặc định: CLI phải bắt đầu pairing mới nếu phiên chưa hoàn tất. Không khôi phục bằng cách trả credential qua MCP.
- Completion cache chỉ giữ raw credential tới ACK hoặc channel expiry/shutdown. In-memory pairing repository giới hạn 10.000 record, pruning khi tạo session và mỗi 60 giây; digest code đã hết hạn được giữ trong bound 100.000 tombstone.

## Acceptance criteria

1. CLI đọc config hợp lệ, từ chối workspace path không tồn tại/chồng lấp hoặc config capability sai; capability thiếu mặc định deny.
2. Pairing start sinh code một lần; CLI không in code trước `attached`; proof sai, session sai, code hết hạn/reused và attach trùng đều bị từ chối.
3. MCP `tools/list` công bố `devices_pair` và `devices_list`; unauthenticated/thiếu scope không gọi được tool.
4. Owner A pair code thành công và chỉ Owner A thấy device; Owner B không thể list/route device đó. Arguments không thể giả `ownerId`.
5. Credential chỉ đến pairing socket đúng; credential không xuất hiện trong MCP result, audit/logger hoặc các message MCP. Local persist xong mới ACK và bridge authenticated thành công.
6. Credential storage failure, delivery timeout, disconnect, cache cleanup khi expiry/shutdown, duplicate ACK, sai generation và claim brute-force path có test; không báo success sai và không cho code dùng lại.
7. Hai thiết bị cùng tên vẫn có alias ổn định theo `deviceId`; local tool call đi đúng workspace và permission; offline không fallback.
8. Integration acceptance dùng MCP Streamable HTTP client thật + OAuth/JWKS fixture + pairing WebSocket + local MCP bridge thật cho `devices_pair` → `devices_list` → `tools/call`.
9. `bun run test:m5`, M1–M4 target suites, `bun run check`, `bun run typecheck` và full `bun test` trên runner có symlink support xanh.
10. README/roadmap/security/pairing/testing hướng dẫn rõ capability đã chạy, external OAuth/ChatGPT setup còn cần cấu hình, và giới hạn in-memory deployment.

## Test strategy

- Test-first theo boundary: CLI argument/config validation, pairing control protocol schema, proof verification, atomic claim, delivery/ACK, retry/timeout/cleanup và MCP tool schema/error/output.
- Unit test fault injection cho proof sai, expiry boundary, claim concurrency, storage write failure, socket đóng trước/sau delivery, duplicate/stale ACK, credential rotate race và rate limit.
- Acceptance local thật dựng server gateway, public Streamable HTTP MCP endpoint với OAuth/JWKS fixture, local CLI runtime và WebSocket sockets trong cùng test process; assert rằng secret không xuất hiện ở result/log.
- Chạy M1/M2/M3/M4 suites riêng và toàn bộ suite trên GitHub Linux/Windows CI. Test ChatGPT hosted bằng hướng dẫn thủ công sau khi người dùng cung cấp/configure OAuth provider và endpoint public; không tuyên bố đã xác nhận ChatGPT live nếu chưa có môi trường đó.

## Tự rà soát đặc tả

- Giữ nguyên data plane là MCP; pairing WebSocket chỉ mang control-plane session/credential lifecycle.
- Device credential không đi qua MCP response. Local chủ động mở cả pairing và bridge socket; không expose port inbound.
- Owner lấy từ OAuth đã xác minh; workspace permission chỉ do local quyết định.
- Đã nêu rõ giới hạn single-instance/in-memory và các thiết lập bên ngoài chưa thể xác nhận từ repository.
- Trước khi implementation cần chuyển acceptance criteria thành plan có test cụ thể, rà lại error/state transitions trong implementation hiện hành và bổ sung decision note nếu phải đổi trust boundary hoặc persistence contract.

## History

| Ngày | Thay đổi | Lý do | Trạng thái |
|---|---|---|---|
| 2026-09-18 | Người dùng duyệt hướng CLI local + ChatGPT pair; hoàn tất implementation, hardening và CI verification | Linux full suite và Windows acceptance M1–M5 xanh trong [CI run 35359769097](https://github.com/OneTwoTen/doctmcp/actions/runs/35359769097); hosted ChatGPT còn cần cấu hình OIDC/domain/workspace | completed |
