# M6 — Persistence repository boundary

Trạng thái: đang triển khai (#45, #46). Tài liệu này mô tả contract hiện có và các yêu cầu bắt buộc cho SQLite adapter dự kiến; không tuyên bố SQLite đã được đưa vào production.

## Phạm vi dữ liệu

| Domain | Contract hiện có | In-memory adapter hiện có | SQLite adapter dự kiến |
| --- | --- | --- | --- |
| Device identity/metadata | `DeviceRepository` | `InMemoryDeviceRepository` | #48 |
| Device credential lifecycle | `DeviceCredentialRepository` | `InMemoryDeviceCredentialRepository` | #49 |
| Pairing session | `PairingSessionRepository` | `InMemoryPairingSessionRepository` | #50 |

Các interface được export từ `apps/server/src/device-repository.ts`, `device-credential.ts` và `pairing.ts`. Service/runtime tiếp tục nhận interface qua dependency injection; không import `bun:sqlite` vào domain/service. Các test in-memory M1–M5 và signature public MCP hiện tại giữ nguyên.

Không persist `DeviceSessionRegistry`, WebSocket/socket object, live status, MCP client/transport, permission/runtime local hoặc workspace filesystem. Sau restart, thiết bị cần reconnect; online/offline luôn suy ra từ session đang sống.

## Repository semantics

**Devices:** `deviceId` không đổi, unique và canonical; `getForOwner`, `listByOwnerId`, `updateForOwner`, `isOwnedBy` phải enforce owner boundary trong query. `getById` chỉ được sử dụng trong luồng nội bộ đã có trust boundary phù hợp. Thứ tự `listByOwnerId` là `createdAt` rồi `deviceId`. Snapshot không chia sẻ mutable state với storage.

**Credentials:** chỉ persist digest (SHA-256 theo contract hiện tại) cùng metadata, trạng thái và generation; không persist raw secret hoặc đưa digest vào DTO/log. `issue` chỉ thành công nếu device không có credential active; `rotate` và `revoke` dùng compare-and-swap trên `credentialId` + `version`, mutation cạnh tranh chỉ một thắng. Credential ID đã dùng không được tái sử dụng; version tăng qua revoke/reissue hoặc rotate. `verify` chỉ chấp nhận digest của credential active.

**Pairing:** chỉ lưu digest của pairing code, session ID, timestamps, trạng thái, local correlation và device ID sau claim. `claim` đọc authoritative clock tại atomic boundary, kiểm tra pending/expiry, tạo device và chuyển session sang claimed như **một đơn vị atomic**. Nếu device creation thất bại, session vẫn pending, không để lại partial device/session. Claim đồng thời chỉ một thành công; code đã claim/expired/cancelled không được sử dụng lại. `cancel`, `expire`, `pruneExpired` giữ contract single-use và retention hiện có; cleanup không cần distributed scheduler.

## Transaction boundary và bootstrap

SQLite device repository và pairing repository phải dùng **cùng database connection/transaction owner** cho claim. Không giải quyết bằng cách đọc pairing bên ngoài transaction rồi ghi device ở transaction khác. `BEGIN IMMEDIATE` hoặc cơ chế khóa/CAS tương đương phải serialize claim; rollback cả device insert lẫn session update khi bất kỳ bước nào lỗi. Không đưa DB transaction hoặc SQL API lên service layer. SQLite migration, WAL, path từ `DOCTMCP_DATA_DIR` và startup failure nằm trong #47.

## Pairing credential completion sau restart

Luồng M5 còn có `PairingCredentialCompletionRepository`: reservation/pending/recovering/delivered là metadata liên quan việc cấp credential và ACK, khác với socket/secret cache in-memory. Chỉ persist devices/credentials/pairing sessions **chưa đủ** để chứng minh recovery chính xác khi restart giữa claim, issue, delivery và ACK. Trong #50/#51 phải kiểm chứng từng crash window, xác định state tối thiểu cần durable hoặc thay đổi recovery protocol được test tương đương; tuyệt đối không persist raw secret. Không coi M6 đạt DoD về pairing recovery trước khi trường hợp này được giải quyết.

## Contract tests và triển khai

`persistent-repository-contract-suite.ts` định nghĩa bộ test dùng lại cho cả in-memory và SQLite (thiết bị/owner scoping, duplicate, credential CAS, expired/reused/concurrent claim, rollback khi tạo device lỗi). `persistent-repository-contract.test.ts` chạy trên adapter in-memory; #48–#50 sẽ bổ sung SQLite factory độc lập và kiểm thử reopen trên file database thật. Không trộn SQLite pairing với in-memory device repository trong các test transaction.

Verification bắt buộc trước khi đánh dấu #46 hoàn tất: `bun run check`, `bun run typecheck`, `bun test`; #47–#51 bổ sung SQLite integration, migration upgrade và Coolify restart/recreate acceptance theo issue.
