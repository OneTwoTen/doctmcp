# Development

## Yêu cầu

- Bun 1.4.2
- Git

## Cài dependencies

```bash
bun install
```

Lần cài đầu tiên sẽ tạo `bun.lock`; lockfile cần được commit sau khi dependency graph được resolve bằng Bun 1.4.2.

## Chạy component

```bash
bun run dev:server
bun run dev:agent
```

Các entrypoint hiện chỉ là bootstrap placeholder. Networking thật sẽ được triển khai theo issue riêng để giữ thay đổi dễ review.

## Kiểm tra

```bash
bun run check
bun run typecheck
bun test
```

Trước khi merge behavior mới, ưu tiên tạo test mô tả behavior mong muốn trước rồi mới viết implementation.

## Quy ước branch/commit

Dùng branch nhỏ theo issue và commit message có mục đích rõ ràng, ví dụ `feat(agent): add pairing client` hoặc `fix(protocol): reject unsupported version`.
