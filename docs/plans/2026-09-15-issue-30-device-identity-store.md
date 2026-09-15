# Plan issue #30 — Device identity/domain model và persistence contract

## Mục tiêu

Hoàn tất foundation M3.1 mà không kéo pairing, credential hoặc authenticated WebSocket vào scope.

## Tasks

- [x] Thêm shared runtime schema/type cho `Device`, create input và mutable update input.
- [x] Chốt `deviceId` UUID v4 CSPRNG và document opaque identity semantics.
- [x] Canonicalize UUID về lowercase trước persistence/lookup.
- [x] Thêm `DeviceRepository` không phụ thuộc database/ORM.
- [x] Thêm deterministic `InMemoryDeviceRepository` cho test.
- [x] Enforce owner-scoped get/list/update/check.
- [x] Trả defensive snapshot, không expose shared internal record.
- [x] Bảo đảm failed update không partial mutate và `updatedAt` không đi lùi.
- [x] Test duplicate id, immutable identity, mutable metadata/name, owner isolation, deterministic list, invalid metadata/device id và clock failure.
- [x] Cập nhật `docs/pairing.md`, `docs/security.md` và M3.1 spec.

## Verification

Bắt buộc trước khi merge:

```sh
bun run check
bun run typecheck
bun test
bun run test:m2
```

GitHub Actions/PR checks của **final PR head** là nguồn verification merge gate. PR body ghi run/count cụ thể gần nhất; plan không hard-code một CI run cũ vì mỗi commit sửa docs/code sẽ tạo head mới.

Ngoài full suite, regression M3.1 phải chứng minh:

- UUID khác casing vẫn resolve cùng một identity và duplicate detection không bị bypass;
- invalid/backward clock làm update reject mà record giữ nguyên;
- malformed device id có error code deterministic;
- M2 acceptance và Windows `shell.exec` regression không bị ảnh hưởng.

## Ngoài phạm vi

- pairing session/code;
- device credential/hash/revoke/rotate;
- WebSocket authentication;
- heartbeat/online state;
- reconnect/backoff;
- routing multi-device;
- production database adapter.

## History

| Ngày | Thay đổi | Trạng thái |
|---|---|---|
| 2026-09-15 | Tạo plan và triển khai scope M3.1 | implementation complete |
| 2026-09-15 | CI baseline xác nhận check/typecheck/full tests và M2 regression | verified |
| 2026-09-15 | Sửa review findings về UUID canonicalization và atomic update | pending final-head CI |
