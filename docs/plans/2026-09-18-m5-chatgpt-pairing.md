# M5 — CLI local và ghép nối ChatGPT Implementation Plan

**Trạng thái:** Local implementation, acceptance suites và quality checks đã hoàn tất. Full Linux suite và Windows target CI đang chờ push nhánh.

> **For agentic workers:** REQUIRED SUB-SKILL: Dùng `superpowers:executing-plans` để thực hiện plan này theo từng task. Mỗi task giữ checkbox để ghi trạng thái.

**Goal:** Người dùng cấu hình local CLI một lần, pair device với principal OAuth đang đăng nhập trong ChatGPT, rồi gọi MCP tools trên local runtime qua M4.

**Architecture:** Thêm pairing control-plane frames riêng, được dispatch qua cùng Bun listener nhưng route `/pairing` và `/bridge` có state/schema/handler tách biệt. Server dùng pairing và credential-completion lifecycle hiện có, gắn delivery với channel proof tạm thời, và chỉ công bố metadata an toàn qua MCP. CLI validate workspace config, pair/lưu credential trước, sau đó chạy MCP runtime qua bridge reconnect controller hiện hành.

**Tech Stack:** Bun 1.4.2, TypeScript 7 strict, Bun workspaces, Zod 4.6.2, MCP TypeScript SDK 2.0.0, Biome 2.5.13, `bun test`.

**Spec:** [`docs/specs/2026-09-18-m5-chatgpt-pairing-design.md`](../specs/2026-09-18-m5-chatgpt-pairing-design.md)

## Global Constraints

- Dùng Bun 1.4.2, TypeScript 7 strict, Bun workspaces, Biome và `bun test`.
- Tài liệu và thông báo do dự án viết bằng tiếng Việt; code, protocol fields, command và API identifier giữ nguyên tiếng Anh.
- Tool execution chỉ dùng MCP `tools/list` / `tools/call`; pairing messages chỉ là control plane.
- Local chỉ mở outbound connection; không mở listener inbound cho agent.
- `ownerId` chỉ đến từ OAuth principal đã xác minh; không nhận qua MCP arguments.
- Credential secret 256-bit không bao giờ đi qua MCP response/log/audit; local phải lưu credential trước khi ACK.
- Workspace capability mặc định `false`; permission luôn được kiểm tra trong local runtime.
- Không thêm dependency nếu Bun hoặc dependency hiện tại giải quyết được nhu cầu.
- Không coi in-memory repository/guard là persistence hoặc rate-limit dùng được cho deployment nhiều instance.
- Giữ nguyên test M1–M4, `bun run check`, `bun run typecheck`, full suite Linux CI và Windows acceptance CI.

---

## File map

| File | Trách nhiệm |
|---|---|
| `packages/schemas/src/pairing-control.ts` | Schema runtime cho attach, attached, credential, ack, error và close của pairing socket. |
| `packages/schemas/src/index.ts` | Export pairing schemas/types. |
| `packages/schemas/src/pairing-control.test.ts` | Boundary tests cho field, size, encoding và event transition input. |
| `apps/server/src/gateway.ts` | Dispatch `/bridge` hiện có và auxiliary WebSocket route riêng trên cùng listener. |
| `apps/server/src/gateway.test.ts` | Chứng minh multiplex không làm đổi bridge; pairing route reject path/method/message sai. |
| `apps/server/src/pairing-channel.ts` | Bounded in-memory channel proof registry, socket binding, delivery ACK timeout và cleanup. |
| `apps/server/src/pairing-channel.test.ts` | Proof, expiry, duplicate attach, delivery, ACK và disconnect/race tests. |
| `apps/server/src/pairing-abuse-guard.ts` | Bounded rate guard cho claim theo authenticated owner và start-session capacity. |
| `apps/server/src/pairing-abuse-guard.test.ts` | Window, retry, capacity và reset tests; không giữ raw code/proof. |
| `apps/server/src/public-pairing-endpoint.ts` | `POST /pairing/sessions`, request bounds, response redaction và route dispatch. |
| `apps/server/src/public-pairing-endpoint.test.ts` | Start/validation/rate-limit/TLS boundary tests. |
| `apps/server/src/public-mcp-endpoint.ts` | Authenticated `devices_pair`, an toàn output/audit, nối completion với pairing channel. |
| `apps/server/src/public-mcp-endpoint.test.ts` | MCP schema/call/auth/owner/errors/secret redaction tests. |
| `apps/server/src/server-runtime.ts` | Compose PairingService, completion lifecycle, channel coordinator và gateway route; stop cleanup. |
| `apps/server/src/server-runtime.test.ts` | Runtime lifecycle integration/cleanup regressions. |
| `apps/server/src/index.ts` | Route mux khớp public pairing API, OAuth discovery/MCP API và bridge path; export startup wiring. |
| `apps/agent/src/pairing-client.ts` | HTTPS start + WSS attach/delivery/ACK client; không xử lý MCP tool calls. |
| `apps/agent/src/pairing-client.test.ts` | Real local server socket tests cho attach, schema, storage-before-ACK và failures. |
| `apps/agent/src/cli-config.ts` | Strict config parser/loader, workspace validation và credential path. |
| `apps/agent/src/cli-config.test.ts` | Config valid/invalid, default deny, paths và secrets. |
| `apps/agent/src/cli.ts` | `connect` command; bootstrap workspace/runtime, pair nếu cần, graceful stop. |
| `apps/agent/src/cli.test.ts` | CLI arguments/output/lifecycle qua injected I/O và runtime factories. |
| `apps/agent/src/index.ts` | Public exports cho CLI/config/pairing client có thể test. |
| `apps/agent/package.json`, `package.json` | Agent/root Bun scripts cho chạy `connect`. |
| `apps/server/src/m5-acceptance.test.ts` | Vertical pairing → MCP list/call → exact local workspace flow qua HTTP/WebSockets thật. |
| `package.json` | `test:m5` command và CI target. |
| `.github/workflows/ci.yml` | Windows chạy M5 acceptance; Ubuntu full test tiếp tục kiểm tra toàn repository. |
| `docs/pairing.md`, `docs/security.md`, `docs/roadmap.md`, `docs/README.md`, `README.md`, `docs/testing/m5-chatgpt.md` | Contract, trạng thái milestone, giới hạn deployment và hướng dẫn cấu hình ChatGPT/OAuth thủ công. |

## Task 1: Pairing control-plane contract

**Files:**
- Create: `packages/schemas/src/pairing-control.ts`
- Create: `packages/schemas/src/pairing-control.test.ts`
- Modify: `packages/schemas/src/index.ts`
- Modify: `packages/protocol/src/index.ts`

**Interfaces:**
- `pairingChannelMessageSchema` là discriminated union cho `pairing.attach`, `pairing.attached`, `pairing.credential`, `pairing.ack`, `pairing.error`, `pairing.close`.
- `pairingChannelMessageSchema` export type `PairingChannelMessage`.
- `pairingChannelProofSchema` chỉ chấp nhận 43 ký tự base64url không padding; channel proof không được canonicalize hoặc echo trong lỗi.
- Credential/ACK fields gồm UUID pairing/device/credential IDs và integer version >= 1; credential secret dùng shared device credential schema.

- [x] **Step 1: Viết test đỏ cho từng frame hợp lệ và field lỗi.** Bao phủ attach thiếu proof, proof có padding, credential ID lỗi, credential length sai, ack version <= 0, field thừa và message type không biết.
- [x] **Step 2: Chạy test để xác nhận contract chưa tồn tại.**

Run: `bun test packages/schemas/src/pairing-control.test.ts`

Expected: FAIL vì `pairingChannelMessageSchema` chưa được export.

- [x] **Step 3: Thêm schema strict, không thêm stateful behavior.** Dùng `z.discriminatedUnion("kind", [...])`, `.strict()` cho từng event; export type và schema qua `packages/schemas/src/index.ts` rồi re-export qua `packages/protocol/src/index.ts`.

```ts
export const pairingChannelMessageSchema = z.discriminatedUnion("kind", [
  pairingAttachSchema,
  pairingAttachedSchema,
  pairingCredentialSchema,
  pairingAckSchema,
  pairingErrorSchema,
  pairingCloseSchema,
]);
export type PairingChannelMessage = z.infer<
  typeof pairingChannelMessageSchema
>;
```

- [x] **Step 4: Chạy schema tests và typecheck.**

Run: `bun test packages/schemas/src/pairing-control.test.ts packages/schemas/src/pairing.test.ts`

Expected: mọi test pass, `bun run typecheck` không báo type lỗi.

- [x] **Step 5: Commit contract.** `feat(protocol): add pairing channel control frames` (`42152eb`).

## Task 2: Multiplex WebSocket control route an toàn

**Files:**
- Modify: `apps/server/src/gateway.ts`
- Modify: `apps/server/src/gateway.test.ts`
- Modify: `apps/server/src/index.ts`

**Interfaces:**
- Thêm `GatewayWebSocketRoute` với `path`, `maxMessageBytes`, `open(connection)`, `message(connection, frame)`, `close(connection)`; `connection` có `send(text)` và `close(code, reason)`.
- `CreateBridgeGatewayOptions.websocketRoutes?: readonly GatewayWebSocketRoute[]`.
- `BridgeGatewayHttpHandler(request, {remoteAddress}?)`; gateway lấy `remoteAddress` chỉ từ `serverInstance.requestIP(request)?.address`, không diễn giải forwarded headers.
- Route phụ được chọn bằng pathname trước khi upgrade; `/bridge` tiếp tục đi đúng bridge handshake/parser cũ.
- Gateway từ chối duplicate path, route trùng `/bridge`, non-GET upgrade và auxiliary frame vượt `maxMessageBytes`; cleanup route callback idempotent.

- [x] **Step 1: Viết tests đỏ cho route phụ trên cùng listener.** Tạo fake route `/pairing`, mở WebSocket, gửi một string frame, xác nhận callbacks nhận đúng thứ tự; xác nhận `/bridge` vẫn handshake theo schema bridge; duplicate/overlapping path bị từ chối khi tạo gateway.
- [x] **Step 2: Chạy gateway tests để thấy fail.**

Run: `bun test apps/server/src/gateway.test.ts`

Expected: fail vì gateway chưa có `websocketRoutes`.

- [x] **Step 3: Thêm discriminated socket data và dispatcher.** Lưu route id/connection id riêng với bridge `GatewayConnection`; `open/message/close` được serialize theo connection, auxiliary frame không đi vào `parseIncomingFrame` hoặc `bridgeMessageSchema`.
- [x] **Step 4: Chạy toàn bộ gateway/M2 regression.**

Run: `bun test apps/server/src/gateway.test.ts apps/server/src/gateway-heartbeat.test.ts apps/server/src/gateway-send-failure.test.ts apps/server/src/m2-acceptance.test.ts`

Expected: tất cả pass; cleanup `stop()` đóng cả bridge lẫn auxiliary socket đúng một lần.

- [x] **Step 5: Commit gateway mux.** `feat(server): multiplex pairing websocket route`

## Task 3: Channel proof, start bounds và credential delivery

**Files:**
- Create: `apps/server/src/pairing-channel.ts`
- Create: `apps/server/src/pairing-channel.test.ts`
- Create: `apps/server/src/pairing-abuse-guard.ts`
- Create: `apps/server/src/pairing-abuse-guard.test.ts`
- Modify: `apps/server/src/pairing.ts`
- Modify: `apps/server/src/server-runtime.ts`
- Modify: `apps/server/src/server-runtime.test.ts`
- Modify: `apps/server/src/index.ts`

**Interfaces:**
- `PairingChannelCoordinator.register(session, proof)`, `attach(sessionId, proof, socket)`, `deliver(completed)`, `acknowledge(message)`, `cancel(sessionId)`, `close()`.
- `PairingChannelSocket.send(message: PairingChannelMessage): Promise<void>` và `close(code: number, reason: string): void`.
- `deliver(completed: CompletedPairingCredential): Promise<void>` chỉ resolve sau khi nhận ACK khớp session/device/credential/version và gọi `acknowledgeDelivery` của runtime.
- `PairingAbuseGuard.beforeStart(remoteAddress?)`, `beforeClaim({ownerId, codeDigest, remoteAddress?})`; guard chỉ lưu bucket/counters theo owner/IP, digest hoặc window, không lưu raw code/proof.
- Default guard có capacity cố định, TTL cleanup và injectable clock; production multi-instance phải inject shared adapter.

- [x] **Step 1: Viết tests đỏ cho guard.** Cùng owner vượt burst bị từ chối generic, owner khác vẫn có quota riêng, pending capacity không vượt cấu hình, reset chỉ sau window, raw code không được giữ trong snapshot/log.
- [x] **Step 2: Viết tests đỏ cho coordinator.** Proof đúng attach một lần; proof sai/session sai/expired/duplicate attach bị từ chối; delivery gửi đúng socket; reconnect cùng proof gửi lại đúng generation đang pending; ACK trùng generation mismatch không resolve; disconnect/timeout resolve bằng safe error; `close()` clear timers và raw secret buffer.
- [x] **Step 3: Chạy tests mới để xác nhận fail.**

Run: `bun test apps/server/src/pairing-abuse-guard.test.ts apps/server/src/pairing-channel.test.ts`

Expected: FAIL vì coordinator/guard chưa tồn tại.

- [x] **Step 4: Triển khai giới hạn và coordinator.** Hash proof bằng SHA-256 có domain prefix; kiểm tra digest constant-time bằng helper so sánh fixed-length; bound pending session/socket, body/frame size, delivery timeout; cancel/expire dọn channel; không log message/secret.
- [x] **Step 5: Ghép lifecycle credential runtime.** `createDoctmcpServerRuntime` tạo coordinator sau completion service, cấp `acknowledgeDelivery` qua boundary runtime hiện có; `stop()` đóng channel trước gateway và cleanup idempotent. Guard được inject qua runtime; default pairing claim guard không còn `ALLOW_ALL` cho public runtime.
- [x] **Step 6: Chạy tests service/runtime và M3 pairing regression.**

Run: `bun test apps/server/src/pairing-abuse-guard.test.ts apps/server/src/pairing-channel.test.ts apps/server/src/pairing-credential-completion.test.ts apps/server/src/server-runtime.test.ts apps/server/src/server-runtime-credential-lifecycle.test.ts`

Expected: pass; prior pairing claim/recovery/revoke semantics vẫn nguyên.

- [x] **Step 7: Commit channel lifecycle.** `feat(server): add bounded pairing credential delivery`

## Task 4: HTTP start route và MCP `devices_pair`

**Files:**
- Create: `apps/server/src/public-pairing-endpoint.ts`
- Create: `apps/server/src/public-pairing-endpoint.test.ts`
- Modify: `apps/server/src/public-mcp-endpoint.ts`
- Modify: `apps/server/src/public-mcp-endpoint.test.ts`
- Modify: `apps/server/src/index.ts`
- Modify: `apps/server/src/server-runtime.ts`

**Interfaces:**
- `POST /pairing/sessions` nhận strict JSON `{deviceName, channelProof}`; thành công trả `{pairingSessionId, pairingCode, expiresAt}` đúng một lần.
- `createPublicPairingEndpoint({pairingService, channelCoordinator, abuseGuard})` trả `fetch(Request, requestInfo)` và `close()`.
- Public MCP endpoint nhận `pairingCredentialCompletionService`, `pairingChannelCoordinator`; `devices_pair` input `{pairingCode, deviceName}`; output `{deviceId, deviceName, status: "paired", nextStep}`.
- `devices_pair` derive `ownerId` từ `AuthInfo`; sau claim gọi coordinator `deliver(completed)` và chỉ trả success sau persistence ACK.
- MCP audit ghi `devices_pair`, ownerId opaque, outcome/error code; không ghi code, arguments, result, credential hay proof.

- [x] **Step 1: Viết HTTP tests đỏ.** Method sai → 405; path sai → 404; body quá lớn/malformed/field thừa → generic 400; success chỉ tạo một session và không trả channel proof; capacity/rate guard → 429; không tin `X-Forwarded-For` từ request bất kỳ.
- [x] **Step 2: Viết MCP tests đỏ.** `tools/list` có `devices_pair`; no bearer/scope sai chặn trước tool; valid owner claims và chờ ACK; tool result không có `credential`; đối số `ownerId` bị schema strict reject; owner A/B isolation và code errors giữ generic.
- [x] **Step 3: Chạy endpoint tests để thấy fail.**

Run: `bun test apps/server/src/public-pairing-endpoint.test.ts apps/server/src/public-mcp-endpoint.test.ts`

Expected: FAIL vì route/tool chưa được expose.

- [x] **Step 4: Triển khai endpoint.** Start route chỉ tạo session pending, register proof digest và không đăng nhập owner; derive remote address từ `Bun.Server.requestIP` qua gateway-supplied request context; không tin proxy header trừ trust proxy được cấu hình rõ.
- [x] **Step 5: Đăng ký MCP tool.** Thêm description tiếng Việt yêu cầu model hỏi code từ người dùng; `ownerId` luôn closure từ verified auth; safe output chỉ sau ACK; `recordAudit` chỉ nhận mã outcome/error.
- [x] **Step 6: Compose public fetch mux.** `apps/server/src/index.ts` dispatch `/pairing/sessions` trước public MCP handler, discovery và `/mcp` tiếp tục nguyên trạng; `/bridge` và `/pairing` upgrade vẫn do gateway route mux xử lý.
- [x] **Step 7: Chạy endpoint/M4 regression.**

Run: `bun test apps/server/src/public-pairing-endpoint.test.ts apps/server/src/public-mcp-endpoint.test.ts apps/server/src/public-mcp-auth.test.ts apps/server/src/routed-device-mcp-client-registry.test.ts`

Expected: pass; OAuth gate M4 và alias routing không đổi.

- [x] **Step 8: Commit public pairing API.** `feat(server): expose authenticated MCP device pairing`

## Task 5: Local pairing client và credential persistence

**Files:**
- Create: `apps/agent/src/pairing-client.ts`
- Create: `apps/agent/src/pairing-client.test.ts`
- Modify: `apps/agent/src/index.ts`
- Modify: `apps/agent/src/device-credential-provider.ts` chỉ nếu test cần inject provider; không đổi file format ngoài version bump có spec.

**Interfaces:**
- `LocalPairingClient.start({serverUrl, deviceName, credentialProvider, webSocketFactory?, fetch?})` tạo proof 32 byte, POST start, mở WSS `/pairing`, attach đúng session/proof và chỉ resolve khi attach ACK.
- `LocalPairingClient.waitForCredential(): Promise<LocalDeviceCredential>` validate pairing.credential schema, ghi `{deviceId, credential}` qua provider, rồi gửi ACK khớp generation.
- `LocalPairingClient.close()` abort fetch/socket, hủy timer và xóa reference tới proof/credential; không log frame content.

- [x] **Step 1: Viết tests đỏ cho local client.** Fake fetch/WS chứng minh proof random 43-char base64url, URL chuyển HTTPS→WSS đúng path, code chỉ lộ qua callback sau `attached`, credential malformed không lưu, storage error không ACK, save resolve trước ACK, sai session/version/duplicate credential bị từ chối, close cleanup.
- [x] **Step 2: Chạy client tests để thấy fail.**

Run: `bun test apps/agent/src/pairing-client.test.ts`

Expected: FAIL vì `LocalPairingClient` chưa tồn tại.

- [x] **Step 3: Thêm implementation với injectable I/O.** Không thêm dependency; dùng global `fetch`, `WebSocket`, `crypto.getRandomValues()` mặc định. CLI callback nhận code/expiresAt để in terminal; secrets không thuộc callback.
- [x] **Step 4: Chạy client + provider security regressions.**

Run: `bun test apps/agent/src/pairing-client.test.ts apps/agent/src/device-credential-provider.test.ts`

Expected: pass; credential provider vẫn atomic và không echo secret trong lỗi.

- [x] **Step 5: Commit local pairing transport.** `feat(agent): pair through outbound control channel`

## Task 6: CLI config và `connect` lifecycle

**Files:**
- Create: `apps/agent/src/cli-config.ts`
- Create: `apps/agent/src/cli-config.test.ts`
- Create: `apps/agent/src/cli.ts`
- Create: `apps/agent/src/cli.test.ts`
- Modify: `apps/agent/src/index.ts`
- Modify: `apps/agent/package.json`
- Modify: `package.json`

**Interfaces:**
- `agentConfigSchema`: strict object `{serverUrl, deviceName, credentialPath, workspaces:[{id,name,root,capabilities,deny?}]}`; capability booleans mặc định `false`.
- `loadAgentConfig(path): Promise<AgentConfig>` parse JSON, canonicalize config location và resolve credential path tương đối với config; workspace roots được canonicalize bởi `WorkspaceRegistry.create`.
- `runConnectCli(argv, dependencies): Promise<number>` dependency injection gồm read config, stdout/stderr, signal hooks, pairing client factory, runtime factory, exit; hỗ trợ `connect --config <path>` và `--help`.
- Bun script agent `connect: bun src/cli.ts connect`; root `connect:agent: bun --cwd apps/agent run connect`.

- [x] **Step 1: Viết config tests đỏ.** Missing/extra fields, invalid URL, empty device name, duplicate workspace ID, nonexistent/overlap path, invalid capability type reject; capability omitted → tất cả false; credential path resolves relative to config.
- [x] **Step 2: Viết CLI lifecycle tests đỏ.** Missing credential: connect to pairing channel, print one-time code only after attach, persist and start runtime. Existing credential: skip pair. Ctrl+C: stop reconnect/runtime/client once. Config/pair/storage error: safe message and nonzero exit. Tool/local runtime retains exact configured capabilities.
- [x] **Step 3: Chạy CLI tests để thấy fail.**

Run: `bun test apps/agent/src/cli-config.test.ts apps/agent/src/cli.test.ts`

Expected: FAIL vì config loader/CLI chưa tồn tại.

- [x] **Step 4: Triển khai strict config loader.** Gọi `WorkspaceRegistry.create(config.workspaces)` trước khi mở socket; `credentialPath` mặc định là path riêng dưới user data directory theo OS, config có thể override; khi file chưa tồn tại dùng `FileDeviceCredentialProvider`.
- [x] **Step 5: Triển khai runtime assembly.** Tạo `LocalMcpRuntime`, `LocalBridgeReconnectController` với bridge URL suy ra từ HTTPS server base; đã có credential thì `controller.start()`, chưa có thì pair/save rồi mới `start()`. Signal handler dùng một shared stop promise.
- [x] **Step 6: Thêm script và chạy config/CLI/M1/M3 tests.**

Run: `bun test apps/agent/src/cli-config.test.ts apps/agent/src/cli.test.ts apps/agent/src/m1-acceptance.test.ts apps/agent/src/local-bridge-reconnect-stop.test.ts apps/agent/src/device-credential-provider.test.ts`

Expected: pass; local server catalog/security contract không đổi.

- [x] **Step 7: Commit CLI lifecycle.** `feat(agent): add local connect CLI`

## Task 7: Vertical M5 acceptance, docs và CI

**Files:**
- Create: `apps/server/src/m5-acceptance.test.ts`
- Create: `docs/testing/m5-chatgpt.md`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `docs/README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/pairing.md`
- Modify: `docs/security.md`
- Modify: `docs/roadmap.md`
- Modify: `apps/server/src/index.test.ts`

**Interfaces:**
- Root `test:m5` chạy pairing schemas, channel/guard, HTTP pairing endpoint, MCP pairing tools, local pairing client, CLI lifecycle và vertical acceptance.
- Acceptance test dùng test OIDC/JWKS verifier, Streamable HTTP MCP client thật, Bun gateway thật, local MCP runtime thật và temporary workspace.

- [x] **Step 1: Viết acceptance đỏ cho full happy path.** CLI start → attach → hiển thị code → MCP `devices_pair` → local persist/ACK → bridge authenticated → `devices_list` → gọi alias đọc file trong workspace.
- [x] **Step 2: Thêm security failure paths.** Owner B không thấy/route device Owner A; wrong/expired/reused code; proof sai; credential không có trong result/log/audit; storage fail không ACK; local permission deny; offline không fallback; device name trùng route theo ID.
- [x] **Step 3: Chạy acceptance trước implementation tài liệu cuối.**

Run: `bun test apps/server/src/m5-acceptance.test.ts`

Expected: FAIL trước khi composition end-to-end hoàn tất; sau các task trước đây pass với server/listener thật.

- [x] **Step 4: Thêm scripts và CI.** `test:m5` trỏ đến đúng file tests M5; Ubuntu job chạy command này rõ ràng ngoài `bun test`; Windows job chạy `test:m5`; không bỏ qua M1–M4 target acceptance.
- [x] **Step 5: Cập nhật tài liệu trạng thái.** Hướng dẫn config/command, URL `/mcp`, OAuth Authorization Code + PKCE S256, `mcp` scope, pairing code, workspace capabilities và manual ChatGPT setup. Nêu rõ live ChatGPT auth cần issuer/domain/workspace hợp lệ; in-memory server chỉ single-instance dev/test.
- [ ] **Step 6: Chạy verification cuối.**

Run: `bun run check`

Expected: Biome không báo lỗi.

Run: `bun run typecheck`

Expected: TypeScript strict không báo lỗi.

Run: `bun run test:local`

Expected: M1 local acceptance pass.

Run: `bun run test:m2`

Expected: M2 transport acceptance pass.

Run: `bun run test:m3`

Expected: M3 lifecycle/routing acceptance pass.

Run: `bun run test:m4`

Expected: M4 OAuth/public MCP acceptance pass.

Run: `bun run test:m5`

Expected: M5 end-to-end acceptance pass.

Run: `bun test`

Expected: full suite pass on Linux runner with symlink support. Windows full-suite local `EPERM` is an environment limitation; Windows CI must pass all listed target suites.

- [ ] **Step 7: Self-review diff, inspect push CI, commit M5 acceptance/docs.** `feat(m5): pair local CLI with ChatGPT`

## Self-review

- Spec coverage: workspace/CLI configuration Task 6; protocol/attachment/proof Task 1–3; start/delivery/ACK Task 3–4; authenticated `devices_pair`/owner isolation/redaction Task 4; local save-before-ACK and reconnect Task 5–6; end-to-end path, CI and documentation Task 7.
- Error coverage: invalid/expired/reused pairing code, invalid proof, duplicate attach, timeout, disconnect, storage failure, stale/duplicate ACK, auth/scope, owner isolation, local permission deny and offline routing have explicit tests.
- Boundary review: `/pairing` is non-MCP control plane; all local tool calls remain MCP; no raw credential crosses MCP; local permission is unchanged.
- Deployment limitation: memory-only adapters do not promise restart recovery or multi-instance routing; docs and final status must say so.
- Current source targets match existing file names checked before plan creation; each new path is listed under a task and file map.
