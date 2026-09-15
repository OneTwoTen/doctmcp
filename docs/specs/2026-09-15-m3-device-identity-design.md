# M3.1 — Device identity và persistence contract

## Trạng thái

**Implemented và verified trong issue #30; chờ merge PR tương ứng.**

Tài liệu này khóa domain foundation cho M3. Pairing code, credential, authenticated WebSocket, heartbeat và routing vẫn thuộc các issue sau.

## Mục tiêu

Mọi phần của M3 dùng cùng một device identity và cùng persistence boundary, tránh việc pairing, auth và routing tự định nghĩa `deviceId`, owner hoặc mutable metadata theo cách khác nhau.

## Device domain

`Device` gồm:

```text
deviceId      immutable UUID v4, routing identity
ownerId       immutable opaque principal id
deviceName    mutable display metadata
metadata      mutable { platform, appVersion?, runtimeVersion? }
createdAt     immutable creation time
updatedAt     mutable update time
```

`Device` **không chứa**:

- pairing code/session;
- raw device credential hoặc credential hash;
- WebSocket/bridge session object;
- MCP SDK session id;
- authoritative `online` boolean.

Online/offline ở M3.4 phải được suy ra từ live authenticated session + heartbeat, không persist vào `Device` làm source of truth.

## Device ID

M3.1 dùng `crypto.randomUUID()` để sinh UUID v4 bằng CSPRNG của runtime.

Lý do:

- có sẵn trong Bun, không thêm dependency;
- đủ entropy cho identity;
- không encode owner hoặc business metadata;
- caller phải coi ID là opaque và không dựa vào format/timestamp để authorization.

UUID v4 hợp lệ được canonicalize về lowercase ngay tại shared schema boundary. Nhờ đó cùng một UUID viết hoa/thường không thể trở thành hai repository key khác nhau, và duplicate detection/lookup luôn dùng một representation duy nhất.

Bridge session id, MCP SDK session id và `deviceId` tiếp tục là ba namespace/semantics khác nhau.

## Validation boundary

Runtime schema dùng chung nằm tại `packages/schemas/src/device.ts`.

- `deviceId`: UUID v4, canonical lowercase sau parse.
- `ownerId`: opaque string, không tự trim/biến đổi identity.
- `deviceName`: trim và giới hạn độ dài.
- `metadata`: object strict; hiện chỉ nhận `platform`, optional `appVersion`, optional `runtimeVersion`.
- unknown field bị reject để credential hoặc metadata không chủ ý không bị nhét vào record.
- update chỉ nhận mutable field; không có `deviceId`/`ownerId` trong patch contract.

## Persistence boundary

`DeviceRepository` nằm ở public server/control-plane và không phụ thuộc database cụ thể.

Contract hiện có:

```text
create(input)
getById(deviceId)
getForOwner(ownerId, deviceId)
listByOwnerId(ownerId)
updateForOwner(ownerId, deviceId, patch)
isOwnedBy(ownerId, deviceId)
```

Owner-scoped API trả `null`/`false` khi device không thuộc owner, nên caller không vô tình lookup/update chéo owner qua API này.

`InMemoryDeviceRepository` là adapter deterministic cho unit/integration test. Production database adapter **chưa được chọn trong M3.1**; interface cố ý chỉ dùng TypeScript/domain type để không leak ORM/database-specific type lên bridge/domain layer.

## Snapshot và mutation semantics

Repository không trả shared internal record.

- object và nested metadata được freeze ở snapshot;
- `Date` được tạo mới khi đọc;
- update validate patch + clock trước khi mutate record;
- failed update không để lại partial mutation;
- `updatedAt` không được đi lùi so với state hiện tại;
- update thành công thay record state nội bộ rồi trả snapshot mới;
- list sort theo `createdAt`, sau đó `deviceId`, để cùng state luôn cho thứ tự deterministic.

## Lifecycle state

M3.1 chưa thêm `active/deleted/revoked` vào `Device` vì policy device-level disable/delete chưa được khóa và credential revoke thuộc M3.3. Không thêm state giả chỉ để dự đoán issue sau.

Khi M3.3/M3.6 cần device-level lifecycle, phải mở rộng schema/repository bằng decision rõ ràng và test interaction với active session.

## Security boundary

- Ownership nằm trên server-side `Device`, không tin owner metadata do local gửi.
- Raw long-lived credential không được lưu trong `Device`.
- Device name không dùng làm routing/authorization identity.
- Immutable identity không bypass permission local của M1.

## Test strategy

M3.1 cover:

- UUID v4/device metadata schema và UUID canonicalization;
- duplicate generated id kể cả khác casing;
- rename/metadata update giữ nguyên `deviceId` + `ownerId`;
- failed update không partial mutate và clock không đi lùi;
- owner isolation cho get/list/update/check;
- deterministic list;
- defensive snapshot không leak shared reference;
- malformed metadata/device id bị reject ở boundary.

M1/M2 regression phải tiếp tục xanh.

Verification của **final PR head** được lấy từ GitHub Actions/PR checks của PR #37. PR chỉ được merge khi `bun run check`, `bun run typecheck`, `bun test`, M2 acceptance và Windows `shell.exec` regression đều xanh; PR body ghi lại run/count cụ thể gần nhất để tránh tài liệu thiết kế bị stale theo mỗi commit docs.

## History

| Ngày | Thay đổi | Lý do | Trạng thái |
|---|---|---|---|
| 2026-09-15 | Khóa Device domain, UUID v4 và repository abstraction | Foundation cho pairing/auth/routing M3 | verified, pending merge |
| 2026-09-15 | Canonicalize UUID và làm update atomic/monotonic | Sửa findings review trước merge | review fixes complete; final-head CI là merge gate |
