# M3.7 — Kế hoạch acceptance dọc và regression bảo mật

> **For agentic workers:** Dùng `superpowers:executing-plans` để triển khai tuần tự theo task và cập nhật checkbox theo bằng chứng mới.

**Mục tiêu:** Khóa flow pairing → authenticated reconnect → heartbeat → device routing → MCP call và cung cấp một lệnh `test:m3` chạy riêng regression/security M3.

**Kiến trúc:** Test dọc dùng production runtime/service/transport hiện có. Các case domain đã có test riêng được chạy qua script tổng hợp, không tạo test harness song song.

**Spec:** [`docs/specs/2026-09-17-m3-vertical-acceptance-design.md`](../specs/2026-09-17-m3-vertical-acceptance-design.md)

**Trạng thái:** Acceptance/security implementation và gate #36 hoàn tất. `test:m3` đạt 127/127; Linux full suite và Windows acceptance M1–M5 xanh trong [CI run 35359769097](https://github.com/OneTwoTen/doctmcp/actions/runs/35359769097). Full Windows suite local còn 32 fixture symlink lỗi `EPERM`; chi tiết ở [`docs/testing/m3-acceptance.md`](../testing/m3-acceptance.md).

## Task 1: MCP routed vertical acceptance

**Files:**
- Create: `apps/server/src/m3-acceptance.test.ts`

- [x] Dựng production server runtime, hai owner-matched pairing và credential, hai local runtime có workspace riêng, reconnect controller và WebSocket thật.
- [x] Khẳng định hai device cùng tên vẫn resolve theo ID; gọi `initialize`, `tools/list`, `system/info` và `workspace/list` qua `BridgeClientTransport`; kiểm tra response thuộc đúng runtime.
- [x] Đóng transient session A, đợi reconnect tạo session mới cùng device identity, rồi gọi MCP lại qua session mới.
- [x] Kiểm tra wrong-owner, unknown device, offline route, cross-device credential và cleanup lỗi làm test thất bại.
- [x] Chạy acceptance mới; production code không cần sửa ngoài router M3.6 đã triển khai.

## Task 2: Lệnh regression M3

**Files:**
- Modify: `package.json`

- [x] Ánh xạ expiry/reuse/concurrent pairing, invalid/cross-device/revoked/rotated credential, heartbeat/stale/duplicate session, reconnect, routing và secret redaction tới test hiện có.
- [x] Thêm script `test:m3` gồm vertical acceptance mới cùng các regression M3 liên quan.
- [x] Chạy `bun run test:m3` (123 pass), `bun run test:local` (6 pass), `bun run test:m2` (6 pass) và `bun run typecheck`.

## Task 3: Tài liệu và review M3

**Files:**
- Modify: `README.md`, `docs/README.md`, `docs/architecture.md`, `docs/development.md`, `docs/pairing.md`, `docs/roadmap.md`, `docs/security.md`.
- Modify: spec/plan M3.5 và M3.6 để chốt trạng thái thực tế.
- Modify: `docs/testing/m3-acceptance.md`.

- [x] Chuyển roadmap từ gate M3 sang trạng thái M3–M5 đã qua CI; ghi rõ cấu hình hosted còn lại.
- [x] Thêm hướng dẫn `test:m3`, flow acceptance và ánh xạ bảo mật.
- [x] Rà diff với issue #36, architecture, protocol, permissions và security; không có protocol duplication/fallback/secret leak.
- [x] Chạy `bun run check`, `bun run typecheck`, `bun test`, `bun run test:local`, `bun run test:m2`, `bun run test:m3`; ghi chính xác kết quả và hạn chế nền tảng.

## History

| Ngày | Thay đổi | Lý do | Trạng thái |
|---|---|---|---|
| 2026-09-17 | Khởi tạo plan M3.7 theo issue #36 | Lập thứ tự thực thi cho acceptance và security gate cuối M3 | in-progress |
| 2026-09-18 | Hoàn tất gate #36; `test:m3` 127/127 và Linux full/Windows target CI xanh | Xác nhận cross-platform qua CI run 35359769097; ghi riêng giới hạn symlink `EPERM` local | completed |
