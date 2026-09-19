# Playbook làm việc với project doctmcp

## Mục đích

Tài liệu này là hướng dẫn thực hành để contributor và AI coding agent làm việc nhất quán trong repository `doctmcp`.

Nếu `AGENTS.md` trả lời câu hỏi **"những rule nào bắt buộc phải tuân theo?"**, thì playbook này trả lời:

- bắt đầu một task từ đâu;
- phải đọc tài liệu nào;
- nên sửa module nào;
- cần test gì;
- khi nào phải cập nhật spec/decision;
- review PR theo cách nào;
- khi nào một thay đổi thực sự hoàn tất.

Playbook không thay thế architecture/spec/decision. Khi có xung đột, dùng thứ tự ưu tiên trong `docs/agent-workflow.md`.

---

## 1. Mental model tối thiểu phải nhớ

Luồng mục tiêu của hệ thống:

```text
ChatGPT / MCP client
        |
        | MCP
        v
Public Server
        |
        | custom WebSocket transport
        | local chủ động kết nối ra ngoài
        v
Local Runtime
        |
        | MCP server + permission engine
        v
Local tools
```

Ba nguyên tắc không được làm mờ:

1. **MCP là data plane cho tool discovery/call/result.**
2. **Protocol riêng của doctmcp chỉ dành cho control plane ngoài MCP.**
3. **Permission quan trọng phải được enforce tại local trước khi side effect xảy ra.**

Không tạo một RPC song song để làm lại `tools/list`, `tools/call`, tool result hoặc MCP error.

---

## 2. Bắt đầu một phiên làm việc trong 5 phút

Trước khi sửa code:

```sh
git status
git branch --show-current
git fetch origin
```

Nếu bắt đầu task mới, branch nên được tạo từ `main` mới nhất:

```sh
git switch main
git pull --ff-only
git switch -c <type>/<scope>-<short-name>
```

Ví dụ:

```text
feat/m3-device-session
fix/bridge-disconnect
test/m2-malformed-frame
docs/project-playbook
```

Sau đó đọc theo thứ tự:

1. issue/PR đang xử lý;
2. `AGENTS.md`;
3. tài liệu domain liên quan;
4. spec/plan/decision gần nhất;
5. code hiện tại;
6. test hiện tại của cùng behavior.

Không bắt đầu bằng việc viết code rồi mới tìm architecture sau.

---

## 3. Chọn tài liệu cần đọc theo loại task

| Task | Tài liệu tối thiểu |
|---|---|
| Local MCP tool | `docs/architecture.md`, `docs/permissions.md`, `docs/tools/*`, test M1 |
| WebSocket bridge | `docs/protocol.md`, spec M2, test M2 |
| Pairing/device auth | `docs/pairing.md`, `docs/security.md`, spec/plan M3 liên quan |
| Device/session routing | `docs/architecture.md`, `docs/protocol.md`, M3 spec/plan |
| Permission/shell/filesystem | `docs/permissions.md`, `docs/security.md`, tool contract |
| Shared schema | tài liệu domain sở hữu contract + `packages/schemas` |
| Control-plane contract | `docs/protocol.md` + `packages/protocol` |
| Thay đổi kiến trúc | `docs/architecture.md`, decision hiện tại, `docs/agent-workflow.md` |
| Review PR | issue/spec của PR + diff + test/CI + tài liệu bị ảnh hưởng |

Nếu task liên quan nhiều domain, đọc toàn bộ tài liệu thuộc các boundary bị chạm tới.

---

## 4. Repo map: sửa ở đâu

### `apps/agent`

Sở hữu local runtime:

- MCP server local;
- local tools;
- permission enforcement;
- outbound bridge transport;
- local device credential/runtime state khi thuộc phía local.

Không đặt public routing hoặc public API business logic vào đây.

### `apps/server`

Sở hữu public side:

- WebSocket gateway;
- bridge client transport;
- device/session registry phía server;
- routing tới đúng local device/session;
- public MCP endpoint khi milestone tương ứng được triển khai.

Không import implementation nội bộ của `apps/agent`.

### `packages/protocol`

Chỉ chứa contract control plane ngoài MCP, ví dụ:

- handshake;
- authentication;
- pairing metadata;
- heartbeat;
- bridge/session metadata.

Không dùng package này để tạo RPC thay thế MCP.

### `packages/schemas`

Sở hữu runtime validation dùng chung qua boundary.

Chỉ đưa schema vào đây khi thực sự được chia sẻ giữa nhiều package/app hoặc nằm trên boundary cần validate độc lập.

### `packages/test-utils`

Chứa helper test có giá trị dùng lại thực sự.

Không chuyển helper vào đây chỉ vì muốn giảm vài dòng duplicate.

### `docs`

Là nguồn sự thật dài hạn về:

- kiến trúc;
- protocol;
- security;
- permission;
- spec;
- plan;
- acceptance/test strategy;
- decision.

Chat không thay thế tài liệu repo cho quyết định dài hạn.

---

## 5. Workflow chuẩn khi triển khai một issue

### Bước 1 — Chốt scope

Từ issue, xác định rõ:

- mục tiêu;
- acceptance criteria;
- phần không nằm trong scope;
- boundary bị ảnh hưởng;
- security impact;
- test cần có.

Nếu issue thiếu chi tiết nhưng spec hiện có đủ để suy ra an toàn, bám theo spec.

Nếu thiếu một quyết định có thể làm đổi kiến trúc, ghi decision/spec trước khi tự chọn ngầm.

### Bước 2 — Tìm code và test hiện tại

Trước khi thêm module mới, tìm xem behavior tương tự đã tồn tại chưa.

Ưu tiên:

- mở rộng abstraction hiện có;
- tái sử dụng schema/validator đúng ownership;
- thêm test cạnh test suite hiện tại.

Tránh tạo layer mới chỉ vì tên task nghe như một subsystem mới.

### Bước 3 — Viết test đỏ khi behavior test độc lập được

Ưu tiên test-first cho:

- MCP contract;
- permission;
- protocol parser/schema;
- transport lifecycle;
- auth/pairing;
- reconnect/heartbeat;
- routing;
- filesystem/shell safety.

Test phải chứng minh behavior, không chỉ assert implementation detail.

### Bước 4 — Implement nhỏ nhất để test xanh

Giữ thay đổi sát acceptance criteria.

Không tiện tay refactor module không liên quan nếu refactor đó không cần để hoàn thành task an toàn.

### Bước 5 — Kiểm tra error path

Mỗi feature phải tự hỏi:

- input sai thì sao;
- peer disconnect thì sao;
- timeout thì sao;
- credential invalid/revoked thì sao;
- permission denied thì sao;
- duplicate/replay thì sao;
- cleanup chạy hai lần thì sao.

Không coi happy path là đủ cho transport/security-sensitive code.

### Bước 6 — Cập nhật tài liệu

Dùng bảng ở mục 9 để xác định tài liệu phải sửa.

### Bước 7 — Verify mới

Tối thiểu:

```sh
bun run check
bun run typecheck
bun test
```

Nếu scope cụ thể:

```sh
bun run test:local
bun run test:m2
```

Chạy suite liên quan trực tiếp trước, rồi full suite trước khi hoàn tất.

Không dùng kết quả từ phiên trước làm bằng chứng hiện tại.

### Bước 8 — Self-review

Trước khi mở PR:

- đọc toàn bộ diff;
- tìm code thừa/debug log;
- kiểm tra docs có overclaim capability không;
- kiểm tra test có thật sự fail trước fix không;
- kiểm tra error path;
- kiểm tra naming và ownership;
- kiểm tra dependency mới có thực sự cần không.

---

## 6. Workflow chuẩn khi review PR

Review phải dựa trên issue/spec/decision, không chỉ dựa vào việc code "trông ổn".

Thứ tự review khuyến nghị:

1. đọc title/body/linked issue;
2. xác định acceptance criteria;
3. đọc diff theo boundary;
4. đọc test trước khi kết luận behavior đã được khóa;
5. kiểm tra CI;
6. đối chiếu architecture/security/protocol;
7. kiểm tra docs;
8. review lại toàn diff sau khi có fix.

### Mức độ finding

Dùng severity thực dụng:

- **P1 — Blocker**: lỗi correctness/security/data loss/protocol làm feature không thể merge an toàn.
- **P2 — Important**: behavior sai hoặc thiếu coverage đáng kể, có thể gây lỗi production hoặc phá acceptance criteria.
- **P3 — Improvement**: maintainability/clarity/edge case ít rủi ro, nên sửa nhưng không cùng mức với blocker.

Không tạo finding cho preference thuần style nếu Biome/rule hiện tại đã chấp nhận và không ảnh hưởng maintainability.

### Một finding tốt phải có

- file/đoạn bị ảnh hưởng;
- behavior cụ thể đang sai;
- tình huống tái hiện;
- hậu quả;
- hướng sửa ngắn gọn;
- test nên thêm nếu phù hợp.

Không chỉ viết "cần xử lý edge case".

---

## 7. Workflow khi xử lý review feedback

Với mỗi finding:

1. xác minh finding còn đúng trên head mới;
2. sửa root cause, không chỉ patch symptom;
3. thêm regression test nếu behavior có thể test;
4. rà các chỗ tương tự cùng pattern;
5. chạy suite liên quan;
6. chạy full verification;
7. cập nhật PR body nếu số test/behavior/documentation đã thay đổi.

Sau khi sửa, review lại toàn PR từ đầu ở các boundary quan trọng; không chỉ nhìn commit fix cuối.

---

## 8. Test matrix theo loại thay đổi

| Thay đổi | Test tối thiểu |
|---|---|
| MCP tool | discovery/call, valid input, invalid input, domain error |
| Permission | allow + deny + path/command boundary |
| Filesystem | normalize/canonicalize, root escape, missing path, permission deny |
| Shell | timeout, output limit, cwd policy, env policy, permission deny |
| WebSocket transport | send/receive, close, malformed, oversized, pending request disconnect |
| Pairing | valid, invalid, expired, already claimed, atomicity |
| Credential auth | valid, invalid, revoked, rotated, replay/reconnect nếu áp dụng |
| Heartbeat/session | online, timeout/offline, reconnect, duplicate session policy |
| Routing | đúng device/session, missing/offline device, stale session |
| Shared schema | valid/invalid fixtures ở boundary |
| Docs-only | link/path correctness; không cần thêm test giả tạo |

Security-sensitive path phải có negative test.

---

## 9. Khi nào phải cập nhật tài liệu nào

| Khi thay đổi | Cập nhật |
|---|---|
| Architecture/module boundary | `docs/architecture.md` + decision nếu là quyết định dài hạn |
| MCP/control-plane boundary | `docs/protocol.md` |
| Pairing/device lifecycle | `docs/pairing.md` |
| Permission behavior | `docs/permissions.md` |
| Threat/trust boundary | `docs/security.md` |
| Tool contract | `docs/tools/*` |
| Acceptance behavior M1/M2/... | tài liệu trong `docs/testing/` tương ứng |
| Feature lớn | `docs/specs/` |
| Công việc nhiều bước | `docs/plans/` |
| Milestone/status thay đổi | `docs/roadmap.md`, README/index nếu cần |
| Quyết định dài hạn đổi | thêm/cập nhật decision note + History |

Không cập nhật README để tuyên bố feature đã xong nếu acceptance test/code chưa chứng minh.

---

## 10. Quy tắc riêng cho local tools

Tool phải độc lập với ChatGPT và public server.

Tool implementation nên nhận dependency rõ ràng thay vì đọc global state tùy tiện khi điều đó giúp test được permission/filesystem/process boundary.

Trước side effect:

1. validate input;
2. normalize/canonicalize tài nguyên;
3. evaluate permission;
4. áp safety limit;
5. mới thực thi.

Error trả về phải đủ structured để MCP caller hiểu được loại lỗi mà không cần parse log string.

---

## 11. Quy tắc riêng cho bridge và WebSocket

Transport chỉ vận chuyển MCP message và control-plane message đã được thiết kế.

Cần đặc biệt giữ:

- FIFO theo guarantee đã chốt;
- wire-size limit;
- malformed frame handling;
- close/error propagation;
- pending request cleanup;
- idempotent cleanup;
- không leak listener/timer;
- không bind public client vào session chưa ready/authenticated.

Local luôn là phía chủ động mở kết nối remote theo architecture hiện tại.

---

## 12. Quy tắc riêng cho pairing/auth/session

Không trộn các khái niệm:

- device identity;
- pairing code;
- device credential;
- authenticated connection;
- live session;
- routing state.

Mỗi loại có lifecycle và threat riêng.

Các invariant quan trọng cần được test khi feature tương ứng tồn tại:

- pairing code dùng một lần;
- claim phải atomic;
- credential có thể revoke/rotate;
- session stale không được tiếp tục nhận routing;
- reconnect không tạo trạng thái mơ hồ;
- auth failure không làm lộ credential hoặc secret trong log.

---

## 13. Dependency policy

Trước khi thêm package mới, kiểm tra:

1. Bun/runtime API đã đủ chưa;
2. dependency hiện có đã giải quyết chưa;
3. package mới có được dùng ở runtime hay chỉ test;
4. package có kéo theo abstraction lớn hơn nhu cầu không;
5. có làm tăng attack surface không.

Với MCP, ưu tiên SDK TypeScript chính thức.

Không tự viết parser/protocol layer nếu SDK hiện có đã định nghĩa semantics cần thiết.

---

## 14. Git, commit và PR

### Branch

Một branch nên phục vụ một mục tiêu rõ ràng.

Không tiếp tục feature mới trên branch đã merge chỉ vì branch vẫn còn local.

### Commit

Ưu tiên commit có nghĩa:

```text
feat(agent): ...
feat(server): ...
fix(protocol): ...
test(m2): ...
docs: ...
```

Không cần chia nhỏ đến mức commit trung gian làm repo fail build/test.

### PR body

PR nên nêu:

- mục tiêu;
- thay đổi chính;
- behavior/security đáng chú ý;
- test đã chạy;
- docs đã cập nhật;
- issue liên quan.

Không ghi số test cũ nếu head mới đã thay đổi suite.

### Sau merge

Xóa branch đã merge nếu không còn sử dụng:

```sh
git switch main
git pull --ff-only
git branch -d <branch>
git push origin --delete <branch>
git fetch --prune
```

Chỉ dùng `-D` khi đã xác minh branch thực sự không còn commit cần giữ.

---

## 15. Checklist security trước khi merge

Tự hỏi:

- Có secret/token/private key nào bị commit hoặc log không?
- Server compromise có vô tình được cấp quyền local rộng hơn trước không?
- Permission có được enforce tại local trước side effect không?
- Input từ network có runtime validation không?
- Path có canonicalize trước permission check không?
- Shell có timeout/output/cwd/env policy phù hợp không?
- Credential có lifecycle revoke/rotate phù hợp với scope không?
- Malformed/oversized input có bị reject sớm không?
- Cleanup có giải phóng timer/socket/pending request không?

Nếu câu trả lời chưa rõ, chưa nên coi feature security-sensitive là hoàn tất.

---

## 16. Anti-pattern cần tránh

Không làm các việc sau:

- tạo `command.request/command.result` để duplicate MCP;
- để public server import tool implementation local;
- enforce permission chỉ ở server;
- dùng string log làm protocol;
- thêm schema shared nhưng thực tế chỉ một module dùng;
- tạo module/dir placeholder cho roadmap tương lai;
- viết test chỉ assert tên/static constant;
- bỏ validation để làm test xanh;
- swallow error để tránh test fail;
- đổi architecture ngầm trong một PR feature nhỏ;
- mô tả roadmap như capability production;
- merge khi chỉ chạy subset test trong khi thay đổi cross-layer.

---

## 17. Definition of done thực hành

Một task được coi là hoàn tất khi tất cả điều phù hợp dưới đây đúng:

- acceptance criteria đã được map sang code/test;
- code nằm đúng ownership/boundary;
- success path và error path quan trọng đã test;
- negative/security test đã có nếu cần;
- tài liệu liên quan đã cập nhật;
- không còn debug artifact;
- `bun run check` pass;
- `bun run typecheck` pass;
- `bun test` pass;
- acceptance suite chuyên biệt pass nếu scope liên quan;
- diff đã được self-review;
- PR body phản ánh đúng head hiện tại.

"Code chạy trên máy tôi" không phải Definition of Done.

---

## 18. Mẫu báo cáo khi hoàn tất task

Khi báo cáo kết quả cho người dùng/reviewer, ưu tiên format ngắn:

```text
Đã hoàn thành <task>.

Thay đổi chính:
- ...
- ...

Verification:
- bun run check
- bun run typecheck
- bun test
- <suite riêng nếu có>

Docs:
- ...

PR/branch:
- ...
```

Nếu còn blocker, nêu blocker thật và phần đã hoàn thành; không mô tả phần chưa làm như đã xong.

---

## 19. Checklist dành riêng cho AI coding agent

Trước khi sửa:

- [ ] Đã đọc issue và acceptance criteria?
- [ ] Đã đọc `AGENTS.md`?
- [ ] Đã đọc domain docs/spec/decision liên quan?
- [ ] Đã xác định ownership của code cần sửa?
- [ ] Đã tìm implementation/test tương tự?

Trong khi sửa:

- [ ] Có đang duplicate contract không?
- [ ] Có làm lệch MCP/control-plane boundary không?
- [ ] Có thêm dependency không cần thiết không?
- [ ] Có negative test cho behavior nhạy cảm không?
- [ ] Có scope creep không?

Trước khi trả kết quả:

- [ ] Đã chạy verification mới?
- [ ] Đã đọc lại toàn diff?
- [ ] Đã cập nhật docs?
- [ ] Đã kiểm tra PR body/status có còn đúng?
- [ ] Có branch cũ đã merge cần dọn không?

---

## 20. Nguồn sự thật cuối cùng

Playbook này mô tả **cách làm việc**, không sở hữu contract kiến trúc cụ thể.

Nguồn sự thật vẫn là:

- `AGENTS.md` cho rule repository;
- decision/spec được duyệt gần nhất cho quyết định/contract;
- `docs/architecture.md` cho module boundary;
- `docs/protocol.md` cho MCP/control-plane boundary;
- `docs/security.md` và `docs/permissions.md` cho security;
- `docs/roadmap.md` cho milestone;
- code + test hiện tại cho capability thực sự đã tồn tại.

Khi tài liệu và code mâu thuẫn, không âm thầm chọn một bên: xác minh issue/decision mới nhất và sửa nguồn sự thật liên quan trong cùng scope.

## History

| Ngày | Thay đổi | Trạng thái |
|---|---|---|
| 2026-09-19 | Tạo project playbook chi tiết cho contributor và AI coding agent | active |
