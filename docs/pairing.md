# Pairing thiết bị

## Mục tiêu

Cho phép một local agent mới được liên kết với đúng user mà không truyền credential dài hạn qua đoạn chat.

## Luồng đề xuất

```text
agent -> server: yêu cầu pairing session
server -> agent: pairing code + expiry
user -> ChatGPT/UI: nhập pairing code
ChatGPT/UI -> server: claim pairing code
server: xác minh user + code + expiry
server -> agent: cấp device identity/credential
agent: lưu credential local
```

Pairing code phải ngắn hạn, dùng một lần và được invalidate ngay sau khi claim thành công.

## Credential sau pairing

Pairing code không được tái sử dụng làm device token. Device credential riêng phải có khả năng revoke, rotate và gắn với một `deviceId` cụ thể.

## UX CLI dự kiến

```text
$ doctmcp pair
Pairing code: G7FK-P2QM
Expires in 5 minutes.
```

Tên thiết bị hiển thị chỉ là metadata; định tuyến phải dựa trên immutable device id.
