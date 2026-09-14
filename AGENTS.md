# AGENTS.md

Tài liệu này quy định cách agent AI và contributor làm việc trong repository `doctmcp`.

## Mục tiêu dự án

`doctmcp` kết nối ChatGPT với máy local thông qua public MCP/relay server và local agent chủ động kết nối ra server.

Không thay đổi nguyên tắc kiến trúc này nếu chưa có quyết định rõ ràng trong issue hoặc tài liệu kiến trúc.

## Stack bắt buộc

- Bun 1.4.2.
- TypeScript strict.
- Bun workspaces.
- Biome cho lint và format.
- Shared wire contract nằm trong `packages/protocol`.
- Shared validation nằm trong `packages/schemas`.

## Quy tắc phát triển

1. Ưu tiên viết test đỏ trước khi triển khai behavior mới.
2. Không duplicate kiểu dữ liệu wire giữa server và agent; sửa contract dùng chung.
3. Không để `apps/server` import implementation nội bộ của `apps/agent` và ngược lại.
4. Tool public/MCP không bắt buộc ánh xạ 1:1 với local tool. Protocol nội bộ phải giữ tính tổng quát.
5. Thay đổi protocol, pairing, authentication hoặc permission phải cập nhật tài liệu tương ứng trong `docs/`.
6. Không commit secret, token thiết bị, pairing code thực, private key hoặc `.env`.
7. Không thêm dependency nếu standard library/Bun API giải quyết tốt cùng bài toán.
8. Giữ commit nhỏ, tập trung theo một mục tiêu.

## Security rules

- Local agent không expose cổng public để ChatGPT kết nối trực tiếp.
- Mọi lệnh local phải qua permission policy trước khi thực thi.
- Pairing code là credential ngắn hạn, dùng một lần, có expiry.
- Device token phải có thể revoke và không được ghi log dạng plain text.
- File path phải normalize/canonicalize trước khi so với allow/deny policy.
- Shell execution là capability nhạy cảm; không được bypass policy bằng alias hoặc wrapper tool.

## Phạm vi package

- `apps/server`: MCP endpoint, auth, pairing, registry thiết bị, routing command, WebSocket gateway.
- `apps/agent`: kết nối server, lưu credential local, permission engine, local tool implementations.
- `packages/protocol`: message envelope và wire types.
- `packages/schemas`: runtime validation của input/output.
- `packages/config`: cấu hình dùng chung khi thực sự cần chia sẻ.
- `packages/test-utils`: helper chỉ dành cho test.

## Definition of done

Một thay đổi được coi là hoàn tất khi code, test, typecheck, Biome và tài liệu liên quan đều đồng bộ. Không che lỗi bằng cách tắt rule hoặc bỏ validation nếu chưa ghi rõ lý do.
