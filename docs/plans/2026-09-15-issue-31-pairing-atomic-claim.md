# Issue #31 — Pairing session/code lifecycle + atomic claim

## Mục tiêu

Hoàn tất M3.2 mà không kéo long-lived credential/authenticated reconnect của #32 vào scope.

## Trạng thái

**Hoàn tất và đã merge qua PR #38** (`3b136d76`). Issue #31 đã đóng; task active tiếp theo của M3 là #32 — device credential lifecycle + authenticated bridge handshake.

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
  -> read authoritative repository clock
  -> lookup digest
  -> expire/reject nếu cần
  -> verify pending
  -> DeviceRepository.create(...)
  -> mark claimed + deviceId
leave atomic boundary
```

Không có `check -> await create -> mark` bên ngoài boundary. Expiry được quyết định bằng clock đọc sau khi đã acquire atomic boundary, nên timestamp stale từ caller không thể bypass TTL.

Production adapter sau này phải dùng transaction/row-lock/CAS tương đương và giữ pairing transition + device creation trong cùng atomic unit-of-work.

### Error oracle

Malformed, non-string, unknown, expired, reused và cancelled code cùng trả:

```text
PAIRING_CODE_UNAVAILABLE
```

Raw code không được copy vào error, guard hoặc persisted session.

## Verification hoàn tất trước merge

Final head PR: `a19bfc5`.

GitHub Actions CI #144, Bun 1.4.2:

- `bun run check`: pass;
- `bun run typecheck`: pass;
- `bun test`: **184 pass / 0 fail**, 22 test files;
- pairing regression: **19/19 pass** (15 service/repository + 4 schema);
- M2 acceptance: **6/6 pass** trong full suite;
- Windows `shell.exec` regression: pass.

Regression M3.2 chứng minh:

- concurrent claim chỉ tạo một device;
- exact expiry boundary bị reject;
- repository clock trong atomic boundary thắng stale caller timestamp;
- non-string pairing code không gây runtime `TypeError`;
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

## History

| Ngày | Thay đổi | Lý do | Trạng thái |
|---|---|---|---|
| 2026-09-15 | Khởi tạo plan M3.2 và triển khai pairing lifecycle | Ánh xạ acceptance criteria issue #31 sang code/test/docs | implemented |
| 2026-09-15 | Khóa atomic claim, generic unavailable error và anti-bruteforce hook | Chặn double claim và giảm secret/oracle leakage | implemented |
| 2026-09-15 | Review phát hiện stale claim timestamp và non-string runtime input | Khóa expiry validation trong atomic boundary và service runtime boundary | fixed |
| 2026-09-15 | CI #144 trên head `a19bfc5` xanh: 184/184 test, M2 6/6, Windows regression | Final verification trước merge | verified |
| 2026-09-15 | PR #38 squash-merge thành `3b136d76`; issue #31 tự đóng | Hoàn tất M3.2 và chuyển task active sang #32 | completed |
