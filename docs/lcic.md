# 腾讯云课堂（LCIC）并列入口

> 临时桥接，随时可能下线。正式课堂仍然是自建教室，本模块不参与课程、课节、作业、白板与考勤。

## 1. 为什么是「并列模式」

腾讯云 **实时互动-教育版（LCIC，原低代码互动课堂）** 已在计费页公告：**2026-10-30 起停止新购与新用户使用**，存量付费客户可继续使用，但不承诺续费。

因此这里只做最小集成：

- 课程详情页多一个「进入腾讯课堂」按钮；
- 音视频、白板、聊天、成员名单全部由腾讯侧提供；
- 本地只保存「我方用户 ↔ 腾讯用户」和「课程 ↔ 腾讯房间」两张映射表；
- 腾讯课堂下线时，把按钮和本模块删掉即可，自建课堂完全不受影响。

## 2. 工作流程

```
浏览器/桌面端                 服务端                         腾讯云 LCIC
     │  GET /lcic/status        │                              │
     │─────────────────────────>│  enabled?                    │
     │  POST /lcic/courses/:id/launch                           │
     │─────────────────────────>│ 权限校验（老师/成员/管理员）   │
     │                          │ RegisterUser / LoginUser ───>│
     │                          │ CreateRoom（每课程一间，24h）─>│
     │<── { url, expiresAt } ───│                              │
     │ openExternal(url) 交给系统浏览器 ────────────────────────>│ 课堂页面
```

- 桌面端走 `window.desktop.openExternal(url)`，用系统浏览器打开；浏览器端新标签打开。
- 服务端**不代理**任何音视频或课堂内容，也不把腾讯 token 写入日志。
- 前端不缓存 launch 返回的 URL；每次点击重新签发。

## 3. 开启与关闭

在服务器 `.env`（或进程环境变量）中配置：

```bash
LCIC_ENABLED=true
LCIC_SDK_APP_ID=<腾讯云 SDKAppId>
LCIC_SECRET_ID=<子账号 SecretId>
LCIC_SECRET_KEY=<子账号 SecretKey>
LCIC_CLASS_DOMAIN=class.qcloudclass.com
LCIC_ROOM_TTL_HOURS=24
```

- 三项凭据（AppId / SecretId / SecretKey）全部存在且 `LCIC_ENABLED` 不为 `false` 时才启用。
- 关闭：设 `LCIC_ENABLED=false` 或清空任意凭据，重启服务。前端按钮消失，`launch` 返回 `503 lcic_not_configured`。
- **密钥只放环境变量或服务器 `.env`，不要提交仓库、不要打进安装包。** 建议使用仅含 LCIC 权限的子账号密钥，并在联调结束后轮换。
- 当前生产入口是 `http://<PROD_SERVER_IP>:9999`。launch 响应里带短期 token，**正式使用前应先把入口切到 HTTPS**，否则 token 可能在链路上被截获。

启用后可用下面的接口自检：

```bash
curl -H "Authorization: Bearer <access_token>" \
  https://<server>/api/v1/lcic/status
# {"enabled":true,"sdkAppId":"..."}
```

## 4. 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/lcic/status` | 登录后返回 `{ enabled, sdkAppId }`；关闭时 `sdkAppId` 为 `null` |
| POST | `/api/v1/lcic/courses/:courseId/launch` | 课程老师/成员/管理员可调用，返回 `{ provider, url, roomId, userId, expiresAt }` |

- `launch` 限流 30 次/分钟/IP。
- 非课程成员返回 404（不泄露课程是否存在）。
- 腾讯接口失败返回 `502 lcic_failed`，前端展示腾讯错误码；服务端日志只记录 `lcicCode` 与 `lcicRequestId`。

## 5. 数据表（迁移 `003_lcic.sql`）

| 表 | 用途 |
|---|---|
| `lcic_users` | 我方 `users.id` → 腾讯 `UserId`、`OriginId`、缓存 token 及过期时间 |
| `lcic_rooms` | 我方 `courses.id` → 腾讯 `RoomId`、房间起止时间 |

腾讯 token 有效期 7 天，服务端缓存 6 天 23 小时；临近过期时用 `LoginUser` 换新 token，不重复注册用户。

## 6. 腾讯侧约束（已实测）

| 项目 | 约束 / 处理 |
|---|---|
| `RegisterUser` | 不能指定 `UserId`，只能传 `OriginId`（唯一）。代码用我方用户 ID 作 `OriginId`，并保存腾讯返回的 `UserId` |
| `LoginUser` | 返回的 token 7 天有效 |
| `CreateRoom.StartTime` | **必须严格晚于当前时间**；代码取 `now + 5s` 抵消时钟误差 |
| 房间时长 | 最长 **24 小时**，超过报 `FailedOperation.ClassTooLong`；默认 24h，到期后下次点击自动新建 |
| `TeacherId` | 建房时指定，课程老师获得老师角色；换老师后旧房间仍是旧老师，需等房间过期或手工删房 |
| 助教 | 目前按学生身份进入，没有助手角色映射 |
| 清理接口 | `DeleteRoom` 只接受 `RoomId`；`DeleteUser` 只接受 `UserId`；两者都不要传 `SdkAppId` |
| 移动端 | Android/iOS 原生接入需要 LCIC 旗舰版 + 包名 license，本集成未做 |

## 7. 已知限制

- 仅 Web / Electron；Android 客户端不显示该入口。
- Electron 内嵌页面打不开腾讯课堂（TRTC SDK 初始化失败），必须用系统浏览器；现有实现就是打开外部浏览器，CSP 不需要改。
- 不参与自建系统的考勤、录制、作业与通知；这些仍走原功能。
- 房间 24 小时到期后会自动新建；跨天且正在进行的课堂可能被拆到新房间。
- 腾讯课堂本身停止服务后，本入口只会报错，不影响课程页其他功能。

## 8. 验证

离线模式（不配置凭据）验证关闭行为：

```bash
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron \
  ./node_modules/tsx/dist/cli.mjs scripts/lcic-test.mts
```

联调模式（会真实注册腾讯用户、建房，结束后自动清理）：

```bash
LCIC_SDK_APP_ID=... LCIC_SECRET_ID=... LCIC_SECRET_KEY=... \
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron \
  ./node_modules/tsx/dist/cli.mjs scripts/lcic-test.mts
```

Node.js ≥ 22 时也可直接 `npm run test:lcic`。联调覆盖：老师两次 `launch` 幂等（同房同用户）、学生进入同一房间、非成员 404、URL 参数完整、清理腾讯侧用户/房间。

## 9. 下线 / 彻底移除

1. **先关闭**：`LCIC_ENABLED=false` 并重启。按钮消失，接口 503，自建课堂不受影响。
2. **彻底移除代码**：
   - 服务端：`routes/lcic.ts`、`services/lcicClient.ts`、`services/lcicService.ts`、`db/repos/lcic.ts`、`db/migrations/003_lcic.sql`
   - 装配：`config.ts`、`app.ts`、`fastify.d.ts`、`routes/index.ts`、`db/repos/index.ts`
   - 共享类型：`packages/shared/src/protocol/teaching.ts` 中的 `LcicStatusDTO` / `LcicLaunchDTO`
   - 前端：课程页按钮、`lcicStatus` 状态与 effect、`.course-hero-actions` 样式（若不再需要）
   - 测试与文档：`scripts/lcic-test.mts`、本文
3. **数据库**：已部署环境不要删除已执行的 `003_lcic.sql`；新增 `004_drop_lcic.sql` 删除 `lcic_users` 与 `lcic_rooms`。
4. **腾讯侧**：删除测试用户与房间，停止使用后在控制台退订，避免继续计费。
