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

Verification trên PR #37, CI #126:

- `bun run check`: pass;
- `bun run typecheck`: pass;
- `bun test`: 161 pass / 0 fail trên 20 file;
- `apps/server/src/m2-acceptance.test.ts`: 6/6 pass trong full suite, tương đương regression coverage của `test:m2`;
- Windows `shell.exec` regression: pass.

Môi trường agent không có Bun 1.4.2 local; GitHub Actions là nguồn verification mới của branch.

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
| 2026-09-15 | CI #126 xác nhận check/typecheck/full tests và M2 regression | verified, pending merge |
