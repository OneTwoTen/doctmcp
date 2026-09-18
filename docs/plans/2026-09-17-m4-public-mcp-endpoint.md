# Kế hoạch M4 — Public MCP endpoint

## Các bước

- [x] Thêm MCP SDK server và JWT/OIDC verification vào `apps/server`; viết test đỏ cho owner derivation và claim/token failure.
- [x] Thêm persistent MCP client registry theo `BridgeGatewaySession`; test initialize một lần, concurrency và session replacement/close.
- [x] Tạo public MCP handler với OAuth challenge/metadata, per-request tool aggregation và `devices_list`; test qua MCP client thật.
- [x] Tích hợp `/mcp` và metadata routes với listener hiện có mà không làm đổi `/bridge` behavior.
- [x] Thêm end-to-end HTTP → authenticated bridge → local MCP acceptance, duplicate-name, wrong-owner, offline/reconnect, result/error và audit assertions.
- [x] Cập nhật README, roadmap, architecture, security, development, tài liệu testing; ghi rõ config external và giới hạn persistence.
- [x] Chạy M4 acceptance, M1/M2/M3 target suite, `bun run check` và `bun run typecheck` local; tất cả pass.
- [x] Chạy full `bun test` trên Linux CI; Windows local hiện có 32 lỗi fixture `EPERM`.
- [x] Review implementation M4 với decision/spec và sửa các lỗi invalid OIDC subject, cleanup shutdown, metadata PKCE/CIMD/grant capability.
- [x] Xác nhận cross-platform CI cho M3 #36 và acceptance M1–M5 trên Windows.

## Verification commands

```sh
bun run test:m4
bun run test:local
bun run test:m2
bun run test:m3
bun run check
bun run typecheck
bun test
```

## History

| Ngày | Thay đổi | Lý do | Trạng thái |
|---|---|---|---|
| 2026-09-17 | Tạo plan cho M4 public MCP endpoint | Ánh xạ decision/spec thành các task có verification | in-progress |
| 2026-09-17 | Hoàn thành implementation, acceptance flow và tài liệu; chờ full regression/CI review | Public endpoint chạy xuyên HTTP → bridge → local MCP | in-progress |
| 2026-09-17 | Hoàn tất M4 acceptance và quality checks local; khắc phục review findings, cập nhật OAuth discovery và hướng dẫn ChatGPT | Local target suites xanh; Windows full suite và cross-platform CI vẫn pending | in-progress |
| 2026-09-18 | Rà soát toàn nhánh và giữ chính xác chuỗi OIDC issuer | Khắc phục khác biệt issuer do chuẩn hóa URL; local Windows full suite vẫn bị chặn bởi quyền tạo symlink | in-progress |
| 2026-09-18 | Mở rộng CI cho push `codex/**` và acceptance M1–M4 trên Windows | Cho phép kiểm tra cross-platform sau khi đẩy nhánh; run chưa được kích hoạt | in-progress |
| 2026-09-18 | Linux full suite và Windows acceptance M1–M5 xanh trong [CI run 35359769097](https://github.com/OneTwoTen/doctmcp/actions/runs/35359769097) | Xác nhận quality, full regression Linux và acceptance cross-platform; external deployment vẫn chưa xác thực | completed |
