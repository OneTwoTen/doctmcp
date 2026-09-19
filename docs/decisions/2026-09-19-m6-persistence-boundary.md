# M6 — Persistence repository boundary

Trạng thái: SQLite adapters #48–#50 đã merge; production wiring #51 triển khai theo decision này. Coolify recreate thực tế cần xác nhận theo checklist deployment.

## Phạm vi dữ liệu

| Domain | Contract hiện có | In-memory adapter hiện có | SQLite adapter dự kiến |
| --- | --- | --- | --- |
| Device identity/metadata | `DeviceRepository` | `InMemoryDeviceRepository` | `SqliteDeviceRepository` (#48) |
| Device credential lifecycle | `DeviceCredentialRepository` | `InMemoryDeviceCredentialRepository` | `SqliteDeviceCredentialRepository` (#49) |
| Pairing session | `PairingSessionRepository` | `InMemoryPairingSessionRepository` | `SqlitePairingSessionRepository` (#50) |

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

Bộ test nằm riêng tại `apps/server/tests/contracts/`, tách khỏi `apps/server/src/` và không được import bởi production entrypoint. `persistent-repository-contract-suite.ts` chạy trên cả InMemory và SQLite adapters (owner isolation, credential CAS, pairing concurrency/expiry/rollback). SQLite integration tests đóng/mở DB file thật, gồm transaction fault-injection sau device insert. Production assembly ở #51 dùng chung một connection cho cả bốn repository, không trộn SQLite pairing với in-memory device.

**Fault-injection gate cho #50:** Test rollback do `DeviceRepository.create` ném lỗi trước khi insert là cần nhưng chưa đủ để chứng minh atomic claim. Khi có SQLite pairing adapter, bắt buộc chạy integration test trên cùng SQLite device/pairing repositories và file database thật: cố ý gây lỗi *sau khi insert device thành công nhưng trước hoặc tại bước cập nhật pairing thành claimed* (ví dụ trigger `RAISE(ABORT, ...)` riêng trong test hoặc hook fault-injection tại storage boundary). Sau lỗi, close/reopen database qua một connection mới và xác nhận pairing vẫn pending, không có orphan device; bỏ fault, retry claim phải tạo đúng một device và chuyển pairing thành claimed. Cần kiểm tra tương tự lỗi commit/rollback nếu adapter có đường xử lý riêng. Test này không được thay thế bằng mock/in-memory hoặc thử lỗi duplicate device chỉ xảy ra trước insert.

Các PR #52–#57 đã qua CI Linux/Windows. #51 cần check/typecheck/full test, M1–M5 acceptance và restart/reopen test; kiểm chứng Coolify container recreate thực tế vẫn là bước vận hành riêng, không được suy ra từ CI.
