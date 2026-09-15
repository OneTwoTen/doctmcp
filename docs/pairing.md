# Pairing thiết bị

Pairing thuộc M3, sau khi M1 local MCP và M2 server → local đã hoạt động ổn định.

## Trạng thái hiện tại

M3.1 đã khóa **device identity + persistence contract**. Pairing session/code thật bắt đầu ở M3.2 (#31), credential/authenticated bridge ở M3.3 (#32).

## Mục tiêu

Cho phép một local runtime mới được liên kết với đúng user mà không truyền credential dài hạn qua đoạn chat và không yêu cầu máy local expose port public.

## Luồng dự kiến

```text
local runtime -> public server: tạo pairing session
public server -> local runtime: pairing code + expiry
user -> ChatGPT/UI: nhập pairing code
ChatGPT/UI -> public server: claim pairing code
public server: xác minh user + code + expiry
public server -> local runtime: cấp device identity/credential
local runtime: lưu credential an toàn
```

Pairing code phải:

- ngắn hạn;
- dùng một lần;
- được invalidate ngay sau khi claim thành công;
- không được dùng làm device credential dài hạn.

## Device identity — đã khóa ở M3.1

Mỗi thiết bị có immutable `deviceId` dùng cho routing và authorization. M3.1 sinh ID bằng `crypto.randomUUID()` nên format hiện tại là UUID v4.

Ví dụ:

```text
deviceId: 2f7ab9a3-b0df-47d8-a396-bde6da7b5c80
deviceName: DoCT-MAC
```

`deviceName` chỉ là metadata hiển thị và có thể đổi. Không route bằng device name vì tên có thể trùng hoặc thay đổi.

`Device` hiện persist:

- immutable `deviceId`;
- immutable opaque `ownerId`;
- mutable `deviceName`;
- mutable `platform`, optional `appVersion`, optional `runtimeVersion`;
- `createdAt`, `updatedAt`.

`Device` không persist authoritative `online` boolean, bridge/MCP session id hoặc raw credential.

Persistence contract nằm sau `DeviceRepository`; M3.1 chỉ có deterministic in-memory adapter cho test. Production database chưa được chọn.

## Ownership boundary — đã khóa ở M3.1

Owner-scoped repository API yêu cầu cả `ownerId` + `deviceId`. Device của owner A không được lookup/update qua API scoped của owner B.

`ownerId` trong M3 vẫn là opaque principal do caller/control-plane đáng tin cậy cung cấp; implementation login/OAuth đầy đủ thuộc milestone sau.

## Credential sau pairing — M3.3

Device credential riêng phải:

- gắn với một `deviceId` cụ thể;
- revoke được;
- rotate được;
- không được ghi log đầy đủ;
- được lưu local bằng cơ chế phù hợp hệ điều hành ở giai đoạn production.

Pairing code không được tái sử dụng làm device token. Raw credential cũng không thuộc `Device` record; credential lifecycle có store/service riêng ở M3.3.

## UX CLI dự kiến

```text
$ doctmcp pair

Pairing code: G7FK-P2QM
Expires in 5 minutes.
```

UX cuối cùng chưa cần khóa ở M3; CLI chỉ là giao diện đầu tiên dễ test.

## Test cần có khi triển khai pairing/auth

- claim code hợp lệ;
- code hết hạn;
- code đã dùng;
- code sai user/session;
- credential sau pairing authenticate được;
- revoked credential bị từ chối;
- rotate credential làm credential cũ mất hiệu lực theo policy đã chốt.
