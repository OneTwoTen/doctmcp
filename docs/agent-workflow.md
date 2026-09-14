# Quy trình làm việc với AI agent

## Mục đích

Tài liệu này là workflow chung cho các công việc nhiều bước, feature mới hoặc thay đổi kiến trúc trong repository `doctmcp`.

Mục tiêu là giữ quyết định, implementation và bằng chứng kiểm tra đồng bộ mà không biến mọi thay đổi nhỏ thành quy trình tài liệu nặng.

## Thứ tự ưu tiên

Khi có xung đột, ưu tiên:

1. Yêu cầu trực tiếp mới nhất của người dùng.
2. `AGENTS.md` gần phạm vi cần sửa nhất và `AGENTS.md` ở root.
3. Decision/spec đã được duyệt gần nhất.
4. Architecture/rule domain tương ứng.
5. Plan hiện hành.
6. Quy ước mặc định của công cụ.

Chat context không phải nguồn sự thật dài hạn nếu repository đã có decision/spec cập nhật hơn.

## Phân loại công việc

### Cục bộ

Ví dụ:

- sửa lỗi format;
- thêm một test nhỏ;
- sửa documentation typo;
- thay đổi cục bộ không làm đổi contract/architecture.

Có thể triển khai trực tiếp và verify tương xứng.

### Feature nhiều bước

Ví dụ:

- thêm một nhóm MCP tool;
- thêm permission engine;
- thêm custom transport;
- thêm pairing lifecycle.

Nên có design ngắn, acceptance criteria và plan task/test trước implementation.

### Kiến trúc

Ví dụ:

- thay đổi ranh giới MCP/control plane;
- đổi transport chính;
- thay đổi trust boundary;
- đổi thứ tự milestone làm ảnh hưởng nhiều subsystem.

Phải có decision note hoặc spec ghi rõ problem, lựa chọn, trade-off và ảnh hưởng.

## Các phase

### 1. Context

Đọc:

- `AGENTS.md`;
- `docs/architecture.md`;
- `docs/roadmap.md`;
- tài liệu domain liên quan;
- decision/history gần nhất nếu có;
- code/test hiện tại của phạm vi cần sửa.

Không suy ra capability đã có chỉ từ roadmap hoặc TODO.

### 2. Design

Mô tả ngắn:

- mục tiêu;
- phạm vi;
- phần không làm;
- contract/flow chính;
- security impact;
- acceptance criteria;
- test strategy.

Nếu quyết định còn thiếu làm thay đổi đáng kể kiến trúc, phải ghi rõ thay vì âm thầm chọn.

### 3. Spec/plan khi cần

Feature/subsystem đủ lớn nên tạo:

```text
docs/specs/YYYY-MM-DD-<feature>-design.md
docs/plans/YYYY-MM-DD-<feature>.md
```

Chỉ tạo thư mục/artifact khi có nội dung thật. Không tạo placeholder rỗng.

Spec nên trả lời:

- vấn đề gì cần giải quyết;
- actor/flow;
- architecture/contract;
- error/security cases;
- testing;
- acceptance criteria.

Plan phải ánh xạ acceptance criteria sang task và verification cụ thể.

### 4. Test-first khi phù hợp

Với behavior có thể kiểm thử độc lập, ưu tiên test đỏ trước implementation.

Đặc biệt với doctmcp:

- MCP tool: test discovery/call/input/error;
- permission: test allow + deny;
- filesystem/shell: test boundary và giới hạn an toàn;
- transport: test hai chiều, disconnect/error;
- pairing/auth: test invalid/expired/revoked path.

Không viết test chỉ để assert static string hoặc implementation detail không quan trọng.

### 5. Implementation

Giữ thay đổi theo task nhỏ và đúng boundary:

- tool implementation không phụ thuộc ChatGPT/public server;
- MCP semantics không bị duplicate sang `packages/protocol`;
- control plane không chứa business logic của local tool;
- server và local không import implementation của nhau.

### 6. Verification

Chạy kiểm tra mới, tương xứng với scope.

Tối thiểu cho TypeScript change:

```sh
bun run check
bun run typecheck
bun test
```

Cross-layer feature phải có integration test của flow chính tương ứng.

Không dùng kết quả CI cũ, output của phiên trước hoặc suy đoán thay cho verification mới.

### 7. Review

Rà diff so với:

- yêu cầu người dùng;
- architecture/decision hiện hành;
- acceptance criteria;
- security boundary;
- test coverage;
- tài liệu liên quan.

Tìm scope creep, duplicate protocol, dependency không cần thiết và capability được mô tả quá mức so với code thật.

### 8. History/decision

Decision/spec/plan quan trọng nên có mục cuối:

```markdown
## History

| Ngày | Thay đổi | Lý do | Trạng thái |
|---|---|---|---|
| YYYY-MM-DD | Khởi tạo tài liệu | Mô tả ngắn | draft / approved / in-progress / complete / blocked |
```

Không viết đè lịch sử cũ khi quyết định thay đổi đáng kể; thêm dòng mới.

## Điều kiện dừng

Dừng phần bị ảnh hưởng và nêu blocker khi:

- thiếu quyết định làm thay đổi lớn phạm vi/kiến trúc;
- code và decision/spec hiện hành mâu thuẫn;
- verification thất bại nhưng chưa xác định nguyên nhân;
- có nguy cơ làm lộ secret hoặc mất dữ liệu;
- thay đổi vượt quyền/scope được người dùng cho phép.

Không dừng chỉ vì task dài; vẫn hoàn thành phần có thể làm chắc chắn và ghi rõ phần bị chặn.

## Ngôn ngữ tài liệu

Tài liệu nội bộ dự án viết tiếng Việt. Giữ nguyên tiếng Anh cho:

- code;
- command;
- API/MCP identifier;
- protocol field;
- filename/path;
- tên dependency/framework;
- thuật ngữ mà dịch ra làm mất nghĩa kỹ thuật.
