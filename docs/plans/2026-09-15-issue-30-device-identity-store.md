# Plan issue #30 — Device identity/domain model và persistence contract

## Mục tiêu

Hoàn tất foundation M3.1 mà không kéo pairing, credential hoặc authenticated WebSocket vào scope.

## Tasks

- [x] Thêm shared runtime schema/type cho `Device`, create input và mutable update input.
- [x] Chốt `deviceId` UUID v4 CSPRNG và document opaque identity semantics.
- [x] Thêm `DeviceRepository` không phụ thuộc database/ORM.
- [x] Thêm deterministic `InMemoryDeviceRepository` cho test.
- [x] Enforce owner-scoped get/list/update/check.
- [x] Trả defensive snapshot, không expose shared internal record.
- [x] Test duplicate id, immutable identity, mutable metadata/name, owner isolation, deterministic list và invalid metadata.
- [x] Cập nhật `docs/pairing.md`, `docs/security.md` và M3.1 spec.

## Verification

Bắt buộc trước khi merge:

```sh
bun run check
bun run typecheck
bun test
bun run test:m2
```

GitHub Actions của PR là nguồn verification mới nếu môi trường agent hiện tại không có Bun 1.4.2.

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
| 2026-09-15 | Tạo plan và triển khai scope M3.1 | implementation complete, pending verification |
