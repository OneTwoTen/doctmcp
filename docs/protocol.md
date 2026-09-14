# Protocol

Protocol định nghĩa message trao đổi giữa public server và local agent.

## Version

Phiên bản ban đầu là `1`. Agent gửi version trong `agent.hello`. Server phải từ chối rõ ràng nếu không hỗ trợ version đó.

## Message envelope

Các message dùng discriminated union với field `type`.

Các nhóm ban đầu:

- `agent.hello`: agent xác nhận device và protocol version sau khi kết nối.
- `heartbeat`: giữ session và đo trạng thái online.
- `command.request`: server yêu cầu agent thực thi một local tool.
- `command.result`: agent trả kết quả hoặc structured error.

## Command identity

Mỗi command có `commandId` duy nhất. Server dùng id này để correlate result với request đang chờ. Agent phải xử lý duplicate command id an toàn trước khi hỗ trợ retry.

## Tool naming

Tool local nên dùng namespace ổn định, ví dụ:

```text
filesystem.read
filesystem.write
filesystem.list
shell.exec
git.status
system.info
```

Không encode device id, user id hoặc version vào tên tool.

## Error

Không trả stack trace hoặc secret qua protocol mặc định. Error wire tối thiểu gồm `code` và `message`; diagnostics nhạy cảm chỉ ghi vào local/server log phù hợp.
