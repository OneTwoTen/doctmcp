# M6.2 — SQLite bootstrap và versioned migrations

Trạng thái: đang triển khai trong #47. M6.2 chỉ tạo database layer và migration runner; **chưa persist device, credential hoặc pairing**. Production repository wiring và Coolify acceptance thuộc #48–#51.

## Cấu hình và lifecycle

- Chỉ khi `DOCTMCP_DATA_DIR` được đặt, server entrypoint mới mở SQLite và chạy migrations **trước khi gateway listen**. Nếu migration fail, startup fail, không khởi động gateway.
- Với môi trường hiện còn chạy M1–M5 in-memory, có thể không đặt biến này. Không có fallback `./data`, `/app` hoặc path build/release.
- Coolify (đến M6.6): mount persistent volume tại `/data`, đặt `DOCTMCP_DATA_DIR=/data`; không dùng thư mục `/app`. Data directory cần thuộc quyền sở hữu và chỉ được đọc/ghi bởi account chạy server. Đảm bảo volume có quyền tạo file, `-wal` và `-shm` cạnh `doctmcp.db`.
- Database file: `<DOCTMCP_DATA_DIR>/doctmcp.db`. Database connection được đóng khi server dừng hoặc startup thất bại sau khi bootstrap.
- SQLite: `journal_mode=WAL`, `foreign_keys=ON`, `synchronous=FULL` và `busy_timeout=5000`. Dữ liệu domain vẫn in-memory cho đến khi các adapters được nối vào runtime ở #51.

## Migration contract

Migrations SQL versioned nằm trong `apps/server/src/storage/migrations/` và được liệt kê tường minh theo thứ tự trong `readBundledMigrations`; tạo file mới **không tự động** khiến file đó được chạy. Mỗi migration mới cần tăng version và cập nhật danh sách, không chỉnh sửa lịch sử migration đã phát hành.

`schema_migrations` ghi version/name/time. Bootstrap chạy `BEGIN IMMEDIATE`, so khớp lịch sử đã áp dụng với danh sách bundled, chạy phần mới, ghi version rồi `COMMIT`. Sai thứ tự, thiếu history/version cao hơn release, SQL lỗi hoặc schema không tương thích đều rollback, đóng database và làm startup fail. Không drop/recreate database cũ. Khi triển khai multi-process/multi-instance ngoài phạm vi M6, cần thiết kế lại coordination tương ứng.

Baseline `0001_storage_baseline.sql` chỉ khóa tên migration duy nhất. Các bảng domain sẽ được tạo bằng migration mới khi triển khai #48–#50; không coi việc tạo `doctmcp.db` là bằng chứng đã hoàn tất persistence.

## Verification

`apps/server/tests/storage/sqlite-database.test.ts` kiểm thử data directory chưa tồn tại, WAL/foreign key, close/reopen, migration upgrade không mất record, rollback khi SQL lỗi, rejected history/sai thứ tự và concurrent bootstrap. Chạy `bun run check`, `bun run typecheck`, `bun test` và các acceptance suite liên quan trước khi merge.

## History

| Ngày | Thay đổi | Trạng thái |
| --- | --- | --- |
| 2026-09-19 | Bổ sung bootstrap SQLite và versioned migration runner cho #47 | đang triển khai |
