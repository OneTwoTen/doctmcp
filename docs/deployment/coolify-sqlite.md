# M6 — Triển khai SQLite trên Coolify

Trạng thái: cấu hình/vận hành production cho **một** doctmcp server instance.
Code/CI kiểm chứng restart runtime và reopen database cùng một data directory.
Bước tạo ứng dụng, mount volume và recreate container trên Coolify thực tế phải
được người vận hành xác nhận trên VPS; repository không có quyền truy cập Coolify.

## Cấu trúc lưu trữ bắt buộc

```text
Coolify persistent storage
  /data/                    <-- bind mount hoặc persistent volume
    doctmcp.db
    doctmcp.db-wal          <-- SQLite tạo khi cần
    doctmcp.db-shm          <-- SQLite tạo khi cần

doctmcp application
  /app                      <-- source/release thay đổi khi deploy
```

**Không** mount SQLite tại `/app`, thư mục build hoặc đường dẫn ephemeral của
container. Một instance duy nhất được phép ghi vào database trong M6; không
scale replicas / chạy nhiều server dùng chung WAL qua network filesystem.
Không copy riêng file `doctmcp.db` khi DB đang mở mà bỏ qua WAL.

## Cấu hình ứng dụng

1. Cài Bun 1.4.2, build/deploy repository từ commit đã kiểm thử, với working
   directory là root của monorepo. Install command: `bun install`;
   start command: `bun --cwd apps/server run start`.
2. Trong Coolify, tạo **persistent storage** và mount chính xác tới `/data`.
   Đảm bảo account chạy Bun có quyền tạo/ghi/đọc `/data`, `doctmcp.db`,
   `-wal` và `-shm`. Nên dùng directory mode `0700`, SQLite file
   mode `0600`, và process umask `077`; không mount read-only.
3. Cấu hình environment trong Coolify (không commit secret):

   ```dotenv
   NODE_ENV=production
   DOCTMCP_STORAGE_MODE=sqlite
   DOCTMCP_DATA_DIR=/data
   BIND_HOST=0.0.0.0
   PORT=3000
   PUBLIC_MCP_URL=https://YOUR_DOMAIN/mcp
   OIDC_ISSUER=https://YOUR_AUTH_DOMAIN/
   OIDC_AUDIENCE=https://YOUR_DOMAIN/mcp
   ```

   `DOCTMCP_STORAGE_MODE` mặc định là `sqlite`, nhưng nên đặt rõ ràng.
   Nếu thiếu/sai `DOCTMCP_DATA_DIR`, mở database hoặc migration thất bại
   thì server **không listen**. `memory` chỉ được cho phép khi
   `NODE_ENV` khác `production` và phải bật tường minh.
4. Kết thúc HTTPS tại reverse proxy, forward WebSocket upgrade cho
   `/bridge` và `/pairing`, bảo vệ port nội bộ khỏi Internet. Nếu proxy
   ở container khác, cấu hình IP peer chính xác bằng
   `TRUSTED_PROXY_ADDRESSES` và yêu cầu proxy ghi đè
   `X-Forwarded-Proto=https`. `OIDC_AUDIENCE` phải trùng đúng
   `PUBLIC_MCP_URL`.

## Kiểm tra trước và sau redeploy/recreate

1. Triển khai với volume **rỗng**; xác nhận trong persistent mount có
   `/data/doctmcp.db` và `schema_migrations` ở version 1–4. Không đọc
   raw secret hoặc log pairing code từ SQLite.
2. Pair một local device, ACK và lưu credential trong local CLI. Xác nhận
   `devices_list` chỉ hiển thị device thuộc owner tương ứng, sau đó gọi
   một tool qua authenticated bridge.
3. Restart server process: device có thể offline tạm thời; local reconnect
   bằng **credential cũ** mà không phải pair lại. `deviceId` và owner không
   đổi, tool routing hoạt động lại sau bridge ready.
4. Recreate container/redeploy code trong Coolify **vẫn mount chính volume
   /data cũ**. Kiểm tra lại bước 2–3; pending pairing còn hạn vẫn có thể
   claim, pairing code hết hạn hoặc đã dùng không được dùng lại.
5. Nâng version code: kiểm tra migration mới được apply trước gateway listen
   và dữ liệu bản cũ không bị xóa. Nếu migration fail, dừng triển khai để
   xử lý schema/config; không xóa DB rồi khởi động lại.

CI `sqlite-server-storage.test.ts` tạo runtime mới, đóng/mở connection từ
cùng data directory và xác minh owner/device/credential + authenticated
WebSocket reconnect/routing bằng Bun gateway thật. Đây là bằng chứng ở mức
process/reopen, **không thay thế** bước recreate container trên Coolify thật.

## Dữ liệu không được persist

`DeviceSessionRegistry`, WebSocket objects, active MCP transport/client,
online/offline, in-memory pairing channel, workspace và local filesystem.
Sau restart, online chỉ phản ánh session mới đã authenticated/ready.

Chỉ persist pairing digest và credential digest; completion reservation,
generation và ACK metadata bền vững để có thể phục hồi secret bằng **rotate**
sau crash, không lưu raw credential. Device credential trong local CLI là dữ
liệu riêng, lưu tại local theo quyền `0600`.

## Giới hạn

M6 không cung cấp backup/restore, PostgreSQL, multi-instance coordination,
distributed invalidation hay Coolify resource provisioning tự động. Không
đánh đồng CI SQLite close/reopen với đã vận hành thành công trên VPS thật.
