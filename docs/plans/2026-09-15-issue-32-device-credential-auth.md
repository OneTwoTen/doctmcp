# Issue #32 — Device credential lifecycle + authenticated bridge handshake

## Mục tiêu

Hoàn tất M3.3: sau pairing, server cấp credential dài hạn gắn với `deviceId`; local dùng credential đó để authenticate WebSocket bridge mà không pair lại.

## Trạng thái

Implementation nằm trên branch `codex/m3-3-device-credential-auth`, PR #39 và đang chờ final verification/merge. Các finding review về recovery race, active-session invalidation, gateway send cleanup và lifecycle linearization đã được xử lý bằng code + regression tests.

## Scope đã hoàn tất

- Credential store/service tách khỏi `Device`.
- Raw credential dùng CSPRNG 256-bit; server chỉ persist digest có domain prefix.
- `credentialId + version` làm generation/CAS boundary; credential id không reuse.
- Pairing completion không persist raw secret.
- Durable state: `pending -> recovering -> pending(new generation) -> delivered`.
- Recovery reserve exact target id trước rotate và recover được qua crash rotate/finalize.
- Explicit revoke/rotate không bị recovery đảo ngược.
- ACK owner/generation-aware; duplicate delivered ACK idempotent.
- Production runtime dùng per-device `DeviceCredentialLifecycleCoordinator` để serialize initial issue, recovery finalize và explicit rotate/revoke.
- Mutation intent được đánh dấu trước async generation snapshot để handshake in-flight không thắng do event-loop gap.
- Same-process cached completion được revalidate với active generation trước khi trả raw credential.
- Pending ACK của generation đã bị revoke/rotate bị reject.
- Authenticated `bridge.hello` gửi credential trong frame, không trong URL/query.
- Ready lease + final credential revalidation trước `bridge.hello.ack`.
- Revoke/rotate/recovery rotation đóng active authenticated session.
- Legacy unauthenticated mode chỉ bật explicit trong test/M2 compatibility path.
- Native outbound WebSocket send failure cleanup session; validation error không tear down healthy socket.

## Lifecycle linearization

Durable recovery reservation xử lý crash consistency nhưng không đủ cho concurrent runtime mutation. Final design dùng một lifecycle stream theo `deviceId`:

```text
initial delivery
  mark mutation intent
  -> device lifecycle lock
  -> issue credential
  -> setPending(exact generation)
  -> validate generation vẫn active
  -> unlock

recovery delivery
  mark mutation intent
  -> same lifecycle lock
  -> reserve/advance recovery
  -> rotate expected source -> reserved target
  -> finishRecovery
  -> validate generation vẫn active
  -> unlock

explicit rotate/revoke
  start expected-generation snapshot
  + mark mutation intent immediately
  -> same lifecycle lock
  -> CAS exact snapshotted generation
  -> close active sessions
  -> unlock
```

Điều này chặn explicit mutation chen giữa recovery rotate và `finishRecovery()`, đồng thời vẫn giữ semantics concurrent rotate/revoke: hai request cùng snapshot một generation chỉ một CAS có thể commit.

## Multi-instance contract

`InMemoryDeviceCredentialLifecycleCoordinator` chỉ an toàn trong một server process. Production nhiều instance dùng chung credential/completion stores phải inject coordinator dựa trên shared/distributed per-device lease hoặc database lock tương đương.

Coordinator không thay thế persistence CAS:

- coordinator serialize high-level sequence;
- CAS bảo vệ authoritative state và crash/retry correctness.

## Stale completion và ACK

Production runtime serialize completion API cùng lifecycle coordinator và revalidate exact active `credentialId + version` trước khi trả completion.

Sau explicit rotate/revoke:

- cached raw credential cũ không được trả lại;
- pending ACK của generation cũ bị reject;
- duplicate ACK của state `delivered` vẫn success/no-op kể cả credential sau đó bị revoke/rotate.

## Verification

Regression suite có coverage cho:

- initial issue bị block tại `setPending` trong khi explicit rotate chờ lifecycle lock;
- recovery bị block tại `finishRecovery` trong khi explicit rotate chờ lifecycle lock;
- concurrent explicit rotate/revoke chỉ một request thắng;
- revoke thắng handshake đã verify snapshot cũ nhưng chưa ready;
- stale same-process completion và stale pending ACK sau explicit rotate;
- crash sau rotate trước recovery finalize;
- explicit external rotate/revoke không bị recovery supersede;
- authenticated MCP end-to-end;
- outbound send-failure cleanup;
- Windows shell regression.

Verification implementation trước commit docs: Biome ✅, typecheck ✅, **222/222 tests**, 909 assertions, 34 files. Final head/CI được cập nhật ở PR #39.

## Out of scope

- authoritative device-session registry / duplicate connection policy / heartbeat / online state (#33);
- reconnect/backoff (#34);
- multi-device routing (#35);
- public MCP endpoint/user OAuth (M4);
- OS keychain packaging.
