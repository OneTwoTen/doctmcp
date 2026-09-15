# Bảo mật

`doctmcp` có thể đọc/ghi file và thực thi lệnh trên máy local, vì vậy security là yêu cầu kiến trúc từ đầu, không phải phần bổ sung sau.

## Trust boundary

Các ranh giới chính:

- MCP client/ChatGPT → public server.
- Public server → authenticated device/session.
- Custom transport → local MCP runtime.
- Local MCP runtime → permission engine.
- Local tool → filesystem/process/network/resource của hệ điều hành.

Mỗi boundary phải validate dữ liệu ở mức phù hợp. Không dựa vào việc lớp phía trước đã validate để bỏ kiểm tra ở lớp sau khi hậu quả có thể ảnh hưởng máy local.

## Nguyên tắc nền

- Không expose local MCP runtime trực tiếp ra Internet chỉ để public server kết nối vào.
- Local chủ động mở outbound connection tới public server.
- Ngoài local development, dùng TLS/WSS cho kết nối remote.
- Không ghi log token, pairing code thực, private key hoặc credential đầy đủ.
- Permission quan trọng phải được enforce tại local runtime.
- Path filesystem phải normalize/canonicalize trước khi áp allow/deny policy.
- Tool có side effect phải có timeout/cancellation hoặc giới hạn tương ứng khi khả thi.
- Credential thiết bị phải có khả năng revoke/rotate trước khi dùng production.

## MCP không thay thế permission

MCP mô tả capability và tool call, nhưng việc một tool tồn tại trong `tools/list` không đồng nghĩa mọi request đều được phép thực thi.

Local runtime phải kiểm tra permission trước khi gọi implementation thật.

Ví dụ:

```text
tools/call filesystem.read
        │
        ▼
validate input
        │
        ▼
canonicalize path
        │
        ▼
permission check
        │
        ├─ deny -> structured tool error
        │
        └─ allow -> read file
```

## Giả định public server có thể bị compromise

Public server không được coi là boundary duy nhất bảo vệ hệ điều hành local.

Nếu public server bị compromise, permission local vẫn phải hạn chế được capability theo policy đã cấu hình. Đây là lý do permission không được chỉ đặt ở server.

## Filesystem

Yêu cầu tối thiểu:

- canonical path check;
- deny ưu tiên hơn allow;
- chống path traversal;
- kiểm tra symlink/canonical target khi policy phụ thuộc path;
- giới hạn kích thước đọc/ghi khi cần;
- không expose thư mục secret theo mặc định.

## Shell

`shell.exec` là capability nhạy cảm nhất trong M1.

Trước khi coi tool này đủ an toàn cho remote use cần có ít nhất:

- timeout;
- output size limit;
- cwd policy;
- environment filtering;
- permission/approval policy;
- structured exit status;
- không tự động log toàn bộ command output nếu có thể chứa secret.

Không dựa vào blacklist vài command nguy hiểm như lớp bảo vệ duy nhất.

## Device identity và ownership

M3.1 khóa các invariants sau:

- `deviceId` là immutable routing identity; `deviceName` không phải authorization/routing key;
- `ownerId` là opaque principal server-side và không được đổi qua device metadata update;
- owner-scoped store API phải chặn lookup/update chéo owner;
- caller phải coi UUID v4 `deviceId` là opaque, không dùng format hoặc thứ tự ID làm authorization;
- `Device` không chứa authoritative `online` state, bridge session object hoặc MCP SDK session id.

Identity đã authenticated ở server vẫn **không** bypass permission local của M1.

## Pairing security — M3.2

Pairing code là credential ngắn hạn, dùng một lần. Nó không được tái sử dụng làm device token dài hạn.

Contract hiện tại:

- TTL mặc định 5 phút;
- 12 symbol trên alphabet 32 ký tự dễ đọc = 60 bit entropy;
- generator dùng `crypto.getRandomValues()`, không dùng `Math.random()`;
- raw pairing code chỉ trả về lúc create session;
- store lookup bằng SHA-256 digest của canonical code với domain prefix;
- claim tại `expiresAt` hoặc muộn hơn bị coi là expired;
- claim thành công invalidate code ngay lập tức;
- cancelled/expired/reused/unknown/malformed code đều map ra generic `PAIRING_CODE_UNAVAILABLE` ở service boundary;
- production log/structured error không được chứa raw code.

Code normalization cho phép case-insensitive và bỏ whitespace/dash. Đây chỉ là UX normalization, không làm thay đổi entropy của code được sinh.

### Atomic claim

Pairing claim và device creation không được tách thành chuỗi write độc lập kiểu:

```text
check pending -> await create device -> mark claimed
```

nếu không có transaction/lock/CAS bao quanh toàn bộ sequence.

`InMemoryPairingSessionRepository` dùng async critical section và gọi `DeviceRepository.create()` bên trong atomic claim boundary. Hai claim đồng thời cùng một code chỉ một request được phép tạo device.

Production persistence phải dùng database transaction, row lock, compare-and-swap hoặc cơ chế tương đương. Nếu database adapter không thể đặt pairing transition + device creation trong cùng atomic unit-of-work thì adapter đó chưa đáp ứng M3.2 security contract.

### Anti-bruteforce boundary

`PairingClaimAttemptGuard` là abstraction để HTTP/auth layer sau này áp rate limit theo trusted owner/user và network context mà không sửa domain flow.

Guard chỉ nhận:

- `ownerId`;
- code digest hoặc `null` nếu malformed;
- optional remote address.

Raw pairing code không được truyền vào guard để tránh bị observability/rate-limit layer log ngoài ý muốn.

M3.2 chưa triển khai full user auth/IP rate-limit infrastructure. Endpoint production sau này vẫn bắt buộc có rate limit phù hợp vì pairing code là human-readable credential.

## Device credential — M3.3+

Device credential phải:

- gắn với immutable device identity;
- revoke được;
- rotate được;
- không xuất hiện đầy đủ trong log;
- không được gửi qua chat nếu không có lý do thật sự cần thiết.

Raw long-lived credential không thuộc `Device` record. M3.3 phải dùng credential store/service riêng và lấy ownership từ server-side `Device`, không tin `ownerId` do local tự khai báo.

Pairing code không được promote thành long-lived credential.

## Audit

Khi thêm audit, mặc định chỉ nên lưu metadata cần thiết:

- user/session;
- device;
- tool;
- thời điểm;
- duration;
- success/failure;
- error code không nhạy cảm.

Không mặc định lưu toàn bộ nội dung file, command output hoặc argument có thể chứa secret.

## Security testing

Feature security-sensitive phải có denied-path test.

Ví dụ:

- path ngoài allow root;
- path nằm trong deny root;
- expired/reused/cancelled pairing code;
- concurrent pairing claim;
- malformed pairing input không mutate state;
- raw pairing code không xuất hiện trong structured error/snapshot;
- revoked device credential;
- shell timeout;
- oversized output;
- invalid bridge handshake;
- owner A lookup/update device của owner B.
