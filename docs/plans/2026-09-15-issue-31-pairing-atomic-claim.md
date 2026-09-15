# Issue #31 — Pairing session/code lifecycle + atomic claim

## Mục tiêu

Hoàn tất M3.2 mà không kéo long-lived credential/authenticated reconnect của #32 vào scope.

## Scope triển khai

- [x] Shared schema/type cho `PairingSession`, state và create/claim input.
- [x] Pairing code CSPRNG, 60-bit entropy, format human-readable, TTL 5 phút.
- [x] Canonical normalization + SHA-256 digest lookup; không persist raw code.
- [x] `PairingService` cho create/get/claim/cancel/expire.
- [x] `PairingSessionRepository` abstraction + deterministic in-memory adapter.
- [x] Device creation chạy bên trong atomic claim boundary.
- [x] Generic public error cho malformed/unknown/expired/reused/cancelled code.
- [x] `PairingClaimAttemptGuard` boundary cho rate-limit/anti-bruteforce milestone sau.
- [x] Unit/concurrency/security tests.
- [x] Cập nhật pairing/security docs.

## Quyết định kỹ thuật

### Pairing code

- alphabet 32 symbol: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`;
- 12 symbol, render `XXXX-XXXX-XXXX`;
- 60 bit entropy;
- `crypto.getRandomValues()`;
- TTL mặc định 5 phút;
- canonical lookup bỏ dash/whitespace và uppercase;
- persist SHA-256 digest với prefix `doctmcp-pairing:v1:`.

### Atomicity

In-memory adapter serialize mọi mutation bằng một async critical section. Trong `claim`, flow là:

```text
enter atomic boundary
  -> lookup digest
  -> expire/reject nếu cần
  -> verify pending
  -> DeviceRepository.create(...)
  -> mark claimed + deviceId
leave atomic boundary
```

Không có `check -> await create -> mark` bên ngoài boundary.

Production adapter sau này phải dùng transaction/row-lock/CAS tương đương và giữ pairing transition + device creation trong cùng atomic unit-of-work.

### Error oracle

Malformed, unknown, expired, reused và cancelled code cùng trả:

```text
PAIRING_CODE_UNAVAILABLE
```

Raw code không được copy vào error, guard hoặc persisted session.

## Verification bắt buộc trước merge

```sh
bun run check
bun run typecheck
bun test
bun run test:m2
```

Regression M3.2 phải chứng minh thêm:

- concurrent claim chỉ tạo một device;
- exact expiry boundary bị reject;
- invalid device metadata không mutate pairing/device store;
- failed device creation không consume pairing code;
- normalization deterministic;
- raw code không xuất hiện trong structured error/session snapshot;
- M2 acceptance vẫn xanh.

## Out of scope

- long-lived device credential;
- credential hash/revoke/rotate;
- authenticated WebSocket reconnect;
- heartbeat/session registry;
- multi-device routing;
- public MCP endpoint/login UI.
