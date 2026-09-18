# M3.6 Device Routing Implementation Plan

**Trạng thái:** Implementation và target verification hoàn tất trong nhánh `codex/m3-multidevice-routing`; `check`, `typecheck`, unit/integration routing tests, M1/M2 acceptance đều xanh. Full-suite giới hạn symlink Windows được ghi tại [`docs/testing/m3-acceptance.md`](../testing/m3-acceptance.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm owner-scoped device directory và resolver chọn authenticated bridge session bằng `deviceId` cho M4.

**Architecture:** `DeviceRoutingService` ghép `DeviceRepository`, `DeviceSessionRegistry` và active credential repository. API trả DTO không chứa secret/session internals; route chỉ trả session khi owner và exact credential generation vẫn khớp.

**Tech Stack:** Bun 1.4.2, TypeScript 7 strict, Bun test, Biome, MCP TypeScript SDK hiện có.

**Spec:** [`docs/specs/2026-09-17-m3-multidevice-routing-design.md`](../specs/2026-09-17-m3-multidevice-routing-design.md)

## Global Constraints

- Giữ ranh giới MCP data plane và doctmcp control plane trong `docs/protocol.md`.
- Route tool traffic chỉ qua MCP SDK và `BridgeClientTransport`; không thêm command RPC.
- `DeviceRepository`, `DeviceSessionRegistry` và credential repository tiếp tục là abstraction; không thêm database/dependency.
- Owner scope và credential generation phải được kiểm tra tại server trước khi session được trả.
- Tài liệu dự án viết bằng tiếng Việt.

---

### Task 1: Device directory snapshot an toàn

**Files:**
- Create: `apps/server/src/device-routing.ts`
- Create: `apps/server/src/device-routing.test.ts`
- Modify: `apps/server/src/index.ts`

**Interfaces:**
- Consumes: `DeviceRepository.listByOwnerId/getForOwner`, `DeviceSessionRegistry.getStatus/getActive`, `DeviceCredentialRepository.getActive`.
- Produces: `DeviceRoutingService.listDevices(ownerId)`, `getDevice(ownerId, deviceId)`, `RoutedDeviceSnapshot`.

- [x] Viết test tạo hai device cùng owner có cùng tên và một device khác owner; xác nhận list chỉ trả hai device đúng thứ tự từ repository và trạng thái `online/offline` theo session + active credential generation.
- [x] Chạy `bun test apps/server/src/device-routing.test.ts`; test mới phải fail vì `device-routing.ts` chưa tồn tại.
- [x] Thêm snapshot DTO chỉ gồm device metadata, status và liveness timestamps; map unknown/wrong owner thành `DEVICE_NOT_FOUND`.
- [x] Chạy lại test file và xác nhận test directory pass; chạy `bun run typecheck`.

### Task 2: Resolve session và chặn stale credential

**Files:**
- Modify: `apps/server/src/device-routing.ts`
- Modify: `apps/server/src/device-routing.test.ts`

**Interfaces:**
- Produces: `DeviceRoutingService.resolve(ownerId, deviceId): Promise<ResolvedDeviceSession>`.
- `ResolvedDeviceSession` trả snapshot safe cùng `BridgeGatewaySession` abstraction; không lộ native WebSocket.
- Domain errors: `DEVICE_NOT_FOUND`, `DEVICE_OFFLINE`, `DEVICE_CREDENTIAL_UNAVAILABLE`, `ROUTING_UNAVAILABLE`.

- [x] Viết test resolve device A trong hai device đang online và xác nhận returned session chính xác là session đã đăng ký dưới `deviceId` A.
- [x] Viết denied-path tests cho unknown id, sai owner, offline device, revoked credential và credential generation cũ sau rotation.
- [x] Chạy test mới để xác nhận các behavior routing chưa tồn tại đều fail vì API chưa có.
- [x] Implement owner lookup trước; yêu cầu active credential và exact generation match; chỉ sau đó mới trả live session.
- [x] Chạy `bun test apps/server/src/device-routing.test.ts` và `bun run typecheck`.

### Task 3: Ghép router vào production runtime

**Files:**
- Modify: `apps/server/src/server-runtime.ts`
- Create: `apps/server/src/device-routing-runtime.test.ts`
- Modify: `apps/server/src/index.ts`

**Interfaces:**
- Produces: `DoctmcpServerRuntime.deviceRouter: DeviceRoutingService`.
- Router dùng chính repository, credential store và session registry đang được runtime quản lý.

- [x] Viết runtime test pair/authenticate nhiều device, resolve đúng owner/device, disconnect/revoke rồi xác nhận route bị từ chối.
- [x] Chạy runtime test để thấy failure vì runtime chưa expose router.
- [x] Compose router bằng các authoritative dependency hiện có và expose service qua runtime barrel.
- [x] Chạy `bun test apps/server/src/server-runtime.test.ts apps/server/src/device-routing.test.ts`, `bun run typecheck` và `bun run test:m2`.

### Task 4: Cập nhật trạng thái và kiểm định M3.6

**Files:**
- Modify: `docs/roadmap.md`
- Modify: `docs/architecture.md`
- Modify: `docs/README.md`
- Modify: `docs/pairing.md`
- Modify: `docs/specs/2026-09-17-m3-multidevice-routing-design.md`
- Modify: `biome.json` để giữ nguyên line ending của file trên Windows và Linux.

- [x] Ghi M3.4 và M3.5 đã có trên main; ghi M3.6 đã triển khai và M3.7 là task M3 còn lại.
- [x] Thêm mục M3.6 vào architecture/docs index, nêu rõ API status/route và lỗi owner/offline.
- [x] Chạy `bun run check`, `bun run typecheck`, `bun test`, `bun run test:local` và `bun run test:m2` mới; ghi nhận giới hạn Windows symlink của full suite.
- [x] Review diff với issue #35, `docs/security.md`, `docs/protocol.md` và xác nhận không có route fallback hoặc data secret trong DTO.
