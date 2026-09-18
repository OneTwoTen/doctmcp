# Acceptance M3 — pairing, reconnect và routing

## Chạy riêng M3

```sh
bun run test:m3
```

Script gom test M3.1–M3.7: device repository/schema; pairing expiry, reuse và concurrent claim; credential issue/verify/revoke/rotate/recovery; auth trước MCP traffic; session registry/heartbeat/invalidation; local reconnect; owner-scoped routing; secret redaction; vertical routed MCP acceptance.

## Vertical acceptance

`apps/server/src/m3-acceptance.test.ts` dùng production server runtime, hai Local MCP Runtime, reconnect controller và WebSocket thật:

1. Pair hai local runtime cho cùng owner, cấp riêng device identity và credential.
2. Xác nhận credential A không authenticate được nếu khai báo `deviceId` B.
3. Cả hai device cùng tên đi online; router resolve session đúng bằng `deviceId`.
4. MCP Client dùng `BridgeClientTransport` trên routed session, chạy `initialize`, `tools/list`, `tools/call system/info` và `workspace/list`.
5. Workspace riêng xác nhận response đến từ đúng local runtime.
6. Ngắt A theo transient timeout; reconnect tạo session mới nhưng giữ nguyên device identity/credential, sau đó MCP call chạy lại được.
7. Wrong owner, unknown device và offline device có kết quả xác định.
8. Cleanup lỗi, socket, controller, runtime hoặc temp workspace làm test thất bại.

## Bản đồ security regression

| Boundary | Test chính |
|---|---|
| Pairing expired/reused/concurrent claim | `apps/server/src/pairing.test.ts`, `pairing-credential-completion.test.ts` |
| Credential gắn đúng device, revoke/rotate, recovery và CAS | `device-credential.test.ts`, `pairing-credential-*.test.ts`, `server-runtime.test.ts` |
| Auth trước MCP frame, invalid/cross-device credential | `gateway.test.ts`, `m3-acceptance.test.ts`, `m3-auth-acceptance.test.ts` |
| Heartbeat, stale session, replacement và invalidation | `device-session-registry.test.ts`, `gateway-heartbeat.test.ts`, `server-runtime-device-session.test.ts` |
| Reconnect backoff, terminal auth, stop và stale callback | `apps/agent/src/local-bridge-reconnect*.test.ts`, `m3-reconnect-acceptance.test.ts` |
| Owner scope, offline route, stale generation, duplicate tên | `device-routing.test.ts`, `device-routing-runtime.test.ts`, `m3-acceptance.test.ts` |
| Secret redaction và safe DTO/error | credential/pairing test, `local-bridge-reconnect-security.test.ts`, device-routing tests |

## Verification hiện tại

Ngày 2026-09-18, trên Windows với Bun **1.4.1** (repository yêu cầu **1.4.2**):

- `bun run test:m3`: 127 test, 475 assertion — pass.
- `bun run test:local`: 6 test, 188 assertion — pass.
- `bun run test:m2`: 6 test, 24 assertion — pass.
- `bun run check` và `bun run typecheck` — pass.
- `bun test`: 292 pass, 32 fail (1215 assertion). Tất cả 32 lỗi xảy ra khi test `filesystem.read`/`filesystem.write` tạo symlink trong fixture trên Windows; hệ điều hành trả `EPERM`. Đây là giới hạn quyền symlink của môi trường local, không phải lỗi assertion. Không bỏ qua hoặc disable các test này.

Workflow CI chạy `test:local`, `test:m2`, `test:m3`, `test:m4` và `test:m5` trên Windows, đồng thời trigger khi push nhánh `codex/**`. Run cho nhánh thay đổi vẫn pending tới khi push; M3 implementation và suite mục tiêu đã chạy local, nhưng chưa ghi nhận CI như thể đã chạy.
