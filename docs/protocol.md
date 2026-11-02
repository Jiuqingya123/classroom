# 通信协议

所有类型定义在 `packages/shared/src/protocol/`，**改协议必须同时改这里与实现**。

## 1. 分层

```
REST   /api/v1/*          业务读写（账号、课堂、ICE 配置、文件）
Socket /socket.io         实时通道（房间状态、信令、白板 op、聊天）
```

Socket 与 HTTP 共用 8080 端口。Socket 握手用 `rtc` 令牌（2 小时），REST 用 `access` 令牌（15 分钟）——
两者 scope 不同，互不通用，避免长令牌被拿去调业务接口。

## 2. 握手

```ts
io(baseUrl, { path: '/socket.io', auth: { token: rtcToken } })
```

服务端 `io.use` 中间件校验 `scope === 'rtc'`，失败返回 `connect_error: unauthorized`。
身份信息写入 `socket.data.user`，**服务端永不信任客户端传来的 role**。

## 3. 房间

```ts
// C→S
'room:join'   { roomId, code? } → ack JoinRoomResult
'room:leave'  ()
'room:end'    (ack)                       // 仅房主
'presence:media' { hasVideo, hasAudio, sharing, handRaised }

// S→C
'peer:joined'    { participant }
'peer:left'      { userId, reason }
'presence:media' { userId, hasVideo, hasAudio, sharing, handRaised }
'presence:reject'{ reason: 'sharing_occupied' }
'room:ended'     { by }
'room:error'     { code, message }
```

进房鉴权优先级：房主 > 曾经加入过（`room_participants` 有记录）> 入会码匹配。
第三档让「重开客户端再进同一节课」不需要重新问老师要码。

### 屏幕共享互斥

`room.sharingUserId` 在内存里做房间级互斥。5 人 Mesh 下若允许多人共享，
每人 4 路上行 × 1080p ≈ 28Mbps，家宽必崩，所以第二个人会被 `presence:reject` 拒绝。

## 4. 白板

```ts
// C→S
'wb:op'       { pageId, opId, ops: WbOp[] }
'wb:resync'   { pageId }
'wb:preview'  { pageId, strokeId, type, color, width, points }   // 绘制中，不入 seq
'wb:presence' { pageId, x, y, tool }                             // ≤20Hz
'wb:lock'     { studentsCanDraw }                                // 仅老师
'wb:page'     { pageId }                                         // 翻页

// S→C
'wb:sync'      { pageId, seq, pages, elements, studentsCanDraw }  // join/resync 全量
'wb:op'        { pageId, seq, by, opId, ops, revs }
'wb:op:reject' { opId, reason, elements }                        // 回拉权威值
'wb:preview'   { ...payload, userId, done }
'wb:presence'  { cursors: WbCursor[] }
'wb:lock'      { studentsCanDraw, by }
'wb:page'      { pages }
```

### 四条收敛规则

1. **创建**：`order` 由服务端 `generateKeyBetween()` 分配，客户端传的被忽略 → 新元素永不撞车。
2. **修改**：`rev` 乐观锁，先到服务端者胜；后到者收 `reject` 并回拉，UI 给 200ms 提示（不静默吞掉）。
3. **自由笔迹**：`pointerup` 之前只发 `wb:preview`（无状态、不入 seq、不落库），
   抬手时才发一条 `add`。这一条把高频 op 削掉 90%，是 Mesh + 5 人下能跑顺的关键。
4. **删除**：软删 `deleted: true`，之后针对它的 patch 一律 reject → 不会「已删元素被改活」。

实现在 `packages/shared/src/model/reduce.ts`，服务端与客户端**跑同一份代码**：
服务端用它校验并改写 op（`applyOp`），客户端用 `applyTrusted` 应用广播。
这是「两端收敛」而不是「两端碰巧看起来一样」的前提。

### 拒绝原因要分清

`locked` 是「元素被老师锁定」，`forbidden` 是「这不是你画的」。两者的处置完全不同，
所以 reducer 里拆成两个分支，客户端也给出不同提示。早期版本一律返回 `locked`，
导致学生看到「元素被锁定」而实际上只是不能改别人的东西。

### 错误约定（补充）

一批 op 中某条失败**不回滚已成功的那些**：白板每条 op 本就是独立的，让它们照常广播，
doc 与客户端才不会分叉。ack 返回 `ok:false` 只是告诉发起方这一条被拒了。

### z 序键（fractional index）

键格式 `a` + 基 62 分数串，字典序即数值序。插到两元素之间只需生成一个新键，
不需要重排其余元素的 `order` —— 否则每次插入都要重写整页。

两个坑（都已修）：

- **「无界」不能传空串**。`generateKeyBetween(null, null)` 若把无界传成 `''`，
  midpoint 会把它当成真实键，空页面第一次追加就撞上 `a >= b` 的校验直接抛错。
- **追加必须先试递增**。直接对 `(a, null)` 取中点，每次都会把「到无穷远的一半」吃掉，
  第 7 次开始就得加长字符串，200 次之后键会涨到 40 多个字符。`keyAfter` 先尝试
  就地递增最后一位（`aV → aW → … → az`），顶到 `z` 才加长，平均 62 次追加才涨 1 个字符。
  `npm run check:order` 覆盖了这两种情况。

## 5. 音视频信令

```ts
'rtc:signal' { to: userId, payload: SignalPayload }   // 200 msg/s 限流
// S→C
'rtc:signal' { from: userId, payload }
```

服务端只按 `userId` 路由，**不解析 SDP**，并且强制校验收发双方在同一房间，
杜绝跨课堂串流。信令不做房间广播 —— 5 人课堂广播会让消息量变成 O(N²)，
且每个客户端都要丢弃不属于自己的消息。

### 三个固定槽位

每条 PeerConnection 恰好三个 transceiver，顺序固定，`mid` 即槽位号：

| mid | 用途 | 说明 |
|---|---|---|
| 0 | 音频 | 麦克风 |
| 1 | 视频 | 摄像头 |
| 2 | 视频 | 屏幕共享 |

屏幕共享因此可以**随时开、不重新协商** —— 只对槽位 2 的 sender 做 `replaceTrack`。
双方靠 `transceiver.mid` 识别远端轨道属于摄像头还是屏幕，不需要额外信令。

### 只有一方发起协商

`initiator = selfId < peerId`，只有发起方预建三个 transceiver 并触发 offer；
另一方不建任何 transceiver，等收到 offer 后由 `setRemoteDescription` 创建，
再挂本地轨道并应答。

这一条是硬约束，不是优化。如果两端都预建并各自触发 `negotiationneeded`：

1. 必然 glare；
2. Chromium 在隐式回滚后**不会释放已关联的 transceiver**，会再开一组 m-line；
3. 最终 SDP 里出现 6 条 m-line，两端连接状态分叉（一端 `connected`、一端 `new`）。

实测就是靠这条规则把 6 条 m-line 收回 3 条、把 `new` 全部变成 `connected`。

### 重协商

首轮协商之后，媒体切换全部走 `replaceTrack`，**不再产生任何 renegotiation**。
需要重协商的只剩 ICE restart（`disconnected` 超过 3 秒或 `failed`）。

`polite = selfId > peerId` 仍然保留作为兜底 —— 万一以后加入了会触发重协商的功能
（比如动态加轨道），Perfect Negotiation 能把碰撞收敛掉。

### 带宽

摄像头 `maxBitrate` 250 kbps、`scaleResolutionDownBy=2`、24fps；屏幕 1 Mbps / 15fps。
每 5 秒读一次 `availableOutgoingBitrate`，低于 400 kbps 降到 1/2，低于 180 kbps 降到 1/4。

### 诊断

`PeerDiag` 里唯一有区分度的字段是选中 candidate pair 的 `candidateType`：

- `host` / `srflx` / `prflx` → P2P 直连成功
- `relay` → 走 TURN 中继，能用但延迟更高
- 全为 `null` 且状态停在 `new` → 信令没通
- 有 candidate 但一直 `connecting` → TURN 端口/证书有问题

## 6. ICE 配置

```
GET /api/v1/rtc/ice-servers  →  { iceServers, ttlSeconds, policy }
```

TURN 凭据由 `HMAC-SHA1(secret, "${expiry}:${userId}")` 生成，TTL 1 小时。
**绝不在客户端硬编码** —— 硬编码会随 dmg 分发给每个学生，等于永久泄露、无法撤销、无法按人封禁。

## 7. 错误约定

REST 统一返回：

```json
{ "error": "bad_code", "message": "入会码不正确", "statusCode": 400 }
```

- `error` 机器可读、稳定，前端据此分支
- `message` 直接展示给人
- 5xx 只返回「服务器内部错误」，内部细节只进日志

Socket 的 ack 统一为 `{ ok, error? }`；无 ack 的单向事件用 `room:error` / `wb:op:reject` 回报。
