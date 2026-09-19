# M6 — SQLite bootstrap, repository và restart acceptance

Trạng thái: implementation M6.1–M6.6, cần đối chiếu CI của PR #58
và checklist recreate thực tế trong [Coolify SQLite](../deployment/coolify-sqlite.md).
Không nhầm CI reopen SQLite trên runner với đã deploy trên VPS.

## Production storage và lifecycle

Server entrypoint dùng `DOCTMCP_STORAGE_MODE=sqlite` mặc định.
`DOCTMCP_DATA_DIR` bắt buộc, trỏ đến volume bền vững nằm ngoài
release/application directory. `DOCTMCP_STORAGE_MODE=memory` chỉ dành cho
development/test khi chọn tường minh, bị reject nếu `NODE_ENV=production`.

Trước khi gateway listen, mở SQLite, tạo data directory, bật WAL,
foreign keys, busy timeout, synchronous FULL và apply toàn bộ migrations
transactional. Bootstrap/migration lỗi khiến startup fail, không fallback
sang memory. Shutdown/khởi tạo public MCP lỗi vẫn đóng database connection.

Versioned SQL migrations được đăng ký trong `sqlite-database.ts`:
- `0001_storage_baseline`: schema migration metadata/index;
- `0002_devices`: immutable device ID/owner, metadata, timestamps và owner index;
- `0003_device_credentials`: chỉ lưu digest/generation và global used-ID ledger;
- `0004_pairing_sessions`: pairing digest/state/expiry, code tombstones, durable
  completion reservation/recovery/ACK metadata.

Không sửa migration đã phát hành, không drop/recreate dữ liệu cũ khi upgrade.

## Repository và security boundary

`DeviceRepository`, `DeviceCredentialRepository`,
`PairingSessionRepository` và `PairingCredentialCompletionRepository`
vẫn là interfaces của domain/service. SQLite adapter dùng cùng một migrated
database connection. Pairing claim dùng synchronous device insert bên trong
transaction BEGIN IMMEDIATE của pairing adapter; không `await` giữa
device insert và cập nhật session.

Persist device identity/metadata, credential digest/lifecycle, pairing digest
và completion/recovery metadata. Không persist WebSocket, live status,
`DeviceSessionRegistry`, raw secret, MCP runtime, local workspace hoặc
online/offline derived state. Crash trong lúc chưa ACK sẽ khôi phục qua
credential rotate và phát secret mới; secret cũ không được log hoặc lưu.

## Test matrix

- `sqlite-database.test.ts`: fresh/reopen/migration upgrade/order/rollback/
  concurrent bootstrap và require data directory.
- `sqlite-device-repository.test.ts`: shared device contract, owner isolation,
  immutable ID, duplicate hai connections, reopen và V1→V4 upgrade.
- `sqlite-device-credential-repository.test.ts`: issue/revoke/rotate/CAS,
  monotonic generation, raw secret không persist, reauthenticate qua reopen.
- `sqlite-pairing-repository.test.ts`: shared InMemory/SQLite full repository
  contract, single-use/expiry, post-insert fault-injection SQLite transaction
  rollback qua close/reopen và resume credential/ACK qua restart.
- `sqlite-server-storage.test.ts`: production mode fail-closed,
  assembly đúng repository, runtime mới với database connection mới dùng
  cùng volume, authenticated bridge reconnect và owner-scoped routing.

Chạy từ root:

```sh
bun run check
bun run typecheck
bun test
bun run test:local
bun run test:m2
bun run test:m3
bun run test:m4
bun run test:m5
```

CI Linux quality/full suite và Windows M1–M5 acceptance phải đều xanh.
Việc kiểm chứng **Coolify container recreate thật** là checklist vận hành
tách biệt trong tài liệu deployment, không được khai báo đã chạy nếu chưa
có quyền truy cập Coolify/VPS.
