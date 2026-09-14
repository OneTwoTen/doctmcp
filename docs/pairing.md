# Pairing thiết bị

Pairing thuộc M3, sau khi M1 local MCP và M2 server → local đã hoạt động ổn định.

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

## Device identity

Mỗi thiết bị cần immutable `deviceId` dùng cho routing và authorization.

`deviceName` chỉ là metadata hiển thị và có thể đổi.

Ví dụ:

```text
deviceId: dev_01K...
deviceName: DoCT-MAC
```

Không route bằng device name vì tên có thể trùng hoặc thay đổi.

## Credential sau pairing

Device credential riêng phải:

- gắn với một `deviceId` cụ thể;
- revoke được;
- rotate được;
- không được ghi log đầy đủ;
- được lưu local bằng cơ chế phù hợp hệ điều hành ở giai đoạn production.

Pairing code không được tái sử dụng làm device token.

## UX CLI dự kiến

```text
$ doctmcp pair

Pairing code: G7FK-P2QM
Expires in 5 minutes.
```

UX cuối cùng chưa cần khóa ở M3; CLI chỉ là giao diện đầu tiên dễ test.

## Test cần có khi triển khai

- claim code hợp lệ;
- code hết hạn;
- code đã dùng;
- code sai user/session;
- credential sau pairing authenticate được;
- revoked credential bị từ chối;
- rotate credential làm credential cũ mất hiệu lực theo policy đã chốt.

## Điều chưa cần làm trước M3

Không đưa pairing vào M1/M2 chỉ để “đủ kiến trúc”. Trong M2, test server → local có thể dùng test identity/session đơn giản miễn boundary được cô lập rõ để thay bằng M3 sau này.
