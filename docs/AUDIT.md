# 代码审计与可行性评估

> 审计对象：`classroom`（ClassRoom v1.1.3）
> 审计日期：2026-10-27
> 审计范围：`packages/shared`、`packages/server`、`packages/client-core`、`apps/desktop`、`scripts`、部署配置
> 方法：静态阅读 + 全量类型检查 + 单元回归 + 本地端到端冒烟 + 生产构建；不包含真机摄像头、真实屏幕采集、跨公网弱网和千人压测

---

## 0. 结论摘要

### 0.1 当前版本能做什么

当前代码是一个**可上线的 1 老师 + 4 学生小班课 MVP**，已经具备：

- 账号注册/登录、刷新令牌轮换、课堂创建与 6 位码入会
- WebRTC Mesh 音视频、屏幕共享、连接诊断、TURN 中继
- 服务端权威的协同白板（画笔/荧光笔/橡皮/形状/文本/撤销/锁定/翻页/光标/PDF 课件）
- 实时聊天、课堂记录、参与时长统计
- Windows/macOS Electron 客户端，nginx + Fastify + SQLite + coturn 部署

它**不是** ClassIn 的完整替代品：没有 SFU、不能支撑大班课/千人同房，没有录播、分组讨论、机构层级与 Web/iOS/Android 端。

> **时效说明**：本文件的 §0~§8 是 2026-10-27 对 v1.1.3 基线的审计。
> 2026-10-28 已补齐账号角色、课程/课节/排课、花名册与助教、课件库、题库、作业、通知、管理后台、课堂互动与课堂记录；
> 这些新增能力的实现、权限模型与复验结果见 **§9**。媒体/SFU、录制、分组、移动端等边界没有变化。

### 0.2 本轮审计结论

| 维度 | 结论 |
|---|---|
| 架构合理性 | 小班 MVP 范围内合理：分层清楚、共享 reducer、服务端权威、协议类型完备。边界也很明确：Mesh + 单进程 + SQLite + 内存房间态，决定了它只能停在 5 人小班 |
| 技术栈适配性 | 桌面端 Electron/React/Konva 适配良好；服务端“零原生依赖”是部署优势，但 `node:sqlite` + 单进程不适合多实例和千人规模 |
| 代码质量 | 关键路径有明确注释和边界处理；白板收敛规则、Perfect Negotiation、固定 transceiver 槽位是亮点。主要问题是**缺少自动化覆盖**和**若干并发/生命周期边角** |
| 安全性 | 基础加固到位（scrypt、JWT scope、refresh 轮换、CSP、contextIsolation、sandbox、签名 URL）；仍缺租户/RBAC、加入频率限制、文件内容校验、令牌吊销、审计日志 |
| 性能 | 5 人小班可接受；白板全量快照、2 秒全量落库、单进程广播是规模瓶颈；千人同房不可行 |
| 可运维性 | 有 systemd/nginx/coturn 部署脚本和健康检查；缺指标、追踪、错误聚合、压测、灰度、备份演练 |
| 测试 | 本轮 26 项单元 + 40 项冒烟 + 类型检查 + 构建全绿；但远端音频、刷新死锁、真实 CSP、真机采集、弱网、千人容量没有端到端证据 |

### 0.3 可行性判断

| 目标 | 可行性 | 说明 |
|---|---|---|
| 继续做 1+4 小班课 | ✅ 已具备 | 先补 P1 稳定性与安全项即可商用 |
| 1+16 互动小班 | ⚠️ 需改造 | 必须从 Mesh 迁移到 SFU（推荐 LiveKit），同时改白板广播与考勤 |
| 1+1000 大班/讲座 | ⚠️ 需重构 | 需要 SFU 集群 + 观众只订阅模式 + CDN/边缘；当前单进程/内存态无法支撑 |
| 完整对标 ClassIn | ✅ 可分阶段 | 以 8~10 人团队估算约 10~12 个月；单人开发约 24 个月以上 |
| 千人同房且人人 <300ms 双向互动 | ❌ 不建议 | 物理带宽和成本都不经济；可行目标是“主讲/连麦 <300ms，1000 旁听 <500ms（WebRTC）或 1~3s（LL-HLS）” |

---

## 1. 审计范围与验证结果

### 1.1 代码规模

- 4 个 workspace，约 1.3 万行 TypeScript/TSX（含脚本）
- 服务端无原生依赖：`node:sqlite` + `crypto.scrypt`
- 桌面端主包约 2.1 MB（pdfjs + Konva 在内），PDF worker 约 1.26 MB

### 1.2 本轮实际执行

| 命令 | 结果 | 说明 |
|---|---|---|
| `npm run typecheck` | ✅ 4/4 workspace 通过 | shared / server / client-core / desktop |
| `npm run test:unit` | ✅ 26/26 | 白板 reducer、页上限、快照回退、RoomRegistry、CSP |
| `npm test`（临时库 8099 端口） | ✅ 40/40 | 新增并发 refresh、考勤隐私、删除当前页回退等断言 |
| `npm run build -w @classroom/desktop` | ✅ | main 11.98 kB / preload 1.86 kB / renderer 2,113 kB |
| `npm run test:rtc` | ⏸ 本轮未重跑 | 历史 40/40；需真机/合成摄像头环境 |
| `npm run test:wb` | ⏸ 本轮未重跑 | 历史 31/31 |
| `npm run test:file` / `test:pdf` / `test:media` / `test:ink` / `test:pressure` / `test:turn` | ⏸ 本轮未重跑 | 历史均通过；合并前应回归 |

### 1.3 未验证项（必须诚实标注）

1. **远端音频修复没有完整 Electron 双窗口 E2E 证据**：代码路径、类型检查、构建通过；真实“关摄像头/切白板后声音不断”需要在两台真机或 Playwright Electron 中验证。
2. **刷新死锁修复没有在真实网络中断/401 场景复现验证**：已用静态分析确认旧实现的自等待环，并在代码层改为 raw fetch + 单飞 + 超时。
3. **真实摄像头/屏幕采集**：开发环境无摄像头、无屏幕录制权限；历史用 Chromium 合成设备验证。
4. **真实公网弱网/跨运营商**：只验证了本机与 TURN relay 链路，没有弱网矩阵。
5. **千人容量**：没有压测数据；当前架构不支持千人同房。
6. **真实 PDF 中文/复杂排版**：历史测试 PDF 缺 CJK 字体，渲染器本身正常。

---

## 2. 当前架构评估

### 2.1 拓扑

```
┌──────────────────────────────┐
│ Electron 客户端（1 老师 + 4 学生）│
│ React 19 + Konva + WebRTC     │
└──────────────┬───────────────┘
               │ HTTPS / WSS
               ▼
        nginx (80/9999)
               │
               ▼
   Fastify 5 + Socket.IO 4（单进程）
       │               │
       │               └── RoomRegistry（内存权威白板/成员态）
       │
       ├── SQLite（WAL，rooms/doc_json、users、participants、messages、files）
       └── 本地 uploads 目录
               
       WebRTC Mesh：客户端之间 P2P；跨 NAT 时走 coturn 中继
```

### 2.2 模块职责

| 模块 | 职责 | 评价 |
|---|---|---|
| `packages/shared` | 协议类型、白板元素模型、几何/命中、`applyOp`/`applyTrusted`、上限常量 | **最强的一层**：双端共用同一份收敛逻辑，避免协议漂移 |
| `packages/client-core` | REST 客户端、socket 封装、ICE、PeerManager、WhiteboardClient | 与框架解耦，利于未来 Web 复用 |
| `packages/server` | Fastify 路由、Socket.IO 信令/白板、SQLite 仓储、JWT/scrypt、TURN 凭据 | 单进程模块化，边界清楚；规模受限 |
| `apps/desktop` | Electron 主进程/预加载/React 渲染、权限、屏幕采集、CSP | 安全基线好；只有桌面端 |
| `scripts` | 冒烟、RTC/白板/PDF/文件/压感测试、部署 | 覆盖真实协议路径，但缺 CI 和覆盖率门槛 |

### 2.3 设计亮点（应保留）

1. **服务端权威白板 + 双端共享 reducer**：`applyOp` 负责校验/改写，`applyTrusted` 负责落状态；`seq`/`rev`/`order` 三条线清晰。
2. **固定 transceiver 槽位（0 音频 / 1 摄像头 / 2 屏幕）**：屏幕共享随时开、不重新协商；首轮协商由 id 较小的一方唯一发起，避免 glare。
3. **Perfect Negotiation + ICE restart**：`makingOffer`/`ignoreOffer`/`polite` 三守卫正确；断网 3 秒才 ICE restart，避免抖动反复打断。
4. **令牌作用域隔离**：access 15 分钟只调 REST，rtc 2 小时只握手 socket；refresh 7 天且哈希落库、轮换。
5. **Electron 安全基线**：`contextIsolation`、`sandbox`、`webSecurity`、CSP、预加载白名单、`safeStorage`。
6. **签名 URL**：图片可直接进 `<img>`/Konva，不需要把 access token 放进 URL。
7. **零原生依赖部署**：`node:sqlite` + scrypt 让 `npm install` 在低版本 glibc 的云主机上可直接跑。

### 2.4 架构边界（决定规模上限）

| 边界 | 现状 | 后果 |
|---|---|---|
| 媒体拓扑 | 全互联 Mesh，`MAX_PARTICIPANTS=5` | 每多一人，所有人的上行/CPU 线性增加；>5 人迅速不可用 |
| 房间状态 | `RoomRegistry` 进程内 Map | 只能单实例；重启丢成员/ICE 状态；无法水平扩展 |
| 数据库 | SQLite 单写者 | 小班够用；多实例、高并发写、分析查询受限 |
| 白板持久化 | 每 2 秒全量 `doc_json` 落库 | 文档大时写放大；崩溃最多丢 2 秒；同步包可能超 2 MB |
| 文件 | 本地磁盘 + 12 小时签名 URL | 不能多实例共享；不能吊销；无生命周期/杀毒 |
| 实时广播 | 单进程 Socket.IO | 无 Redis adapter；无法跨节点广播 |
| 可观测性 | pino 日志 + 客户端诊断面板 | 无指标/追踪/错误聚合；容量与故障不可量化 |
| 终端 | 仅 Windows/macOS Electron | 无 Web/iOS/Android；无自动更新 |

---

## 3. 问题清单与修复状态

严重级别定义：

- **P0**：会导致课堂不可用、数据丢失或明确安全漏洞，必须立即处理
- **P1**：高频场景下功能错误/明显体验退化，或阻断规模化
- **P2**：边角错误、性能浪费、可维护性问题
- **P3**：优化建议/文档/清理

### 3.1 本轮已修复

#### A-01（P0）远端音频绑定在 `<video>` 上，关摄像头/切白板即失声

- **现象**：远端声音只在视频 tile 的 `<video>` 元素里播放；关摄像头、切到白板视图或网格卸载时，`<video>` 被移除，声音随之中断。
- **根因**：`PeerView` 只有一个 `stream`，音频和视频共用同一个 `<video>`；音频生命周期被视频 UI 绑定。
- **修复**：
  - `PeerView` 拆成 `cam` / `mic` / `screen` 三条流，远端 `ontrack` 按轨道类型分别存入（[`apps/desktop/src/renderer/store/room.ts:40`](../apps/desktop/src/renderer/store/room.ts#L40)、[`room.ts:177`](../apps/desktop/src/renderer/store/room.ts#L177)）。
  - 新增常驻 `RemoteAudioSink`，挂在房间页顶层，不随视频舞台条件渲染（[`RoomPage.tsx:20`](../apps/desktop/src/renderer/pages/RoomPage.tsx#L20)、[`RoomPage.tsx:299`](../apps/desktop/src/renderer/pages/RoomPage.tsx#L299)）。
  - 视频元素统一 `muted`，声音只由音频 sink 输出（[`VideoTile.tsx:50`](../apps/desktop/src/renderer/room/VideoTile.tsx#L50)）。
- **验证**：类型检查、构建通过；单元/冒烟无法覆盖真实播放，**待双窗口 Electron E2E 确认**。

#### A-02（P0）CSP 拦截课件白板背景图

- **现象**：PDF 导入后页面背景空白；浏览器控制台报 `img-src` 违规。
- **根因**：安全策略只允许 `'self' data: blob:`，而课件图片是 `http://server/files/...` 签名 URL；同时 `connect-src` 放行了任意 `https:`/`wss:`，安全面过宽。
- **修复**：
  - 抽出纯函数 `buildCsp(serverUrl, isDev)`（[`apps/desktop/src/main/csp.ts:4`](../apps/desktop/src/main/csp.ts#L4)）。
  - `img-src` 精确加入当前服务器 origin；`connect-src` 收紧为 `'self'` + API/WS + 开发态 localhost（[`csp.ts:12`](../apps/desktop/src/main/csp.ts#L12)）。
  - `security.ts` 改为复用该函数，避免两份策略漂移。
- **验证**：`test:unit` 中 6 项 CSP 断言通过（生产/开发、图片源、WS、禁用 eval）。

#### A-03（P1）刷新令牌时自等待死锁

- **现象**：access token 过期后，多个请求同时 401，刷新逻辑可能永久挂起或重复刷新。
- **根因**：`tokenHolder.refresh` 内部调用 `ApiClient`，而 `ApiClient` 在 401 时又调用 `tokenHolder.refresh`，形成自等待环；且没有单飞和超时。
- **修复**：
  - 刷新改为直接 `fetch`，绕过 `ApiClient`（[`session.ts:60`](../apps/desktop/src/renderer/store/session.ts#L60)）。
  - 模块级 `refreshInflight` 单飞；12 秒 `AbortController` 超时（[`session.ts:8`](../apps/desktop/src/renderer/store/session.ts#L8)、[`session.ts:65`](../apps/desktop/src/renderer/store/session.ts#L65)）。
  - `ApiClient` 只有“请求原本带了 access token”才尝试刷新；所有请求增加 20 秒超时（[`api.ts:53`](../packages/client-core/src/net/api.ts#L53)、[`api.ts:77`](../packages/client-core/src/net/api.ts#L77)）。
- **验证**：代码层确认自等待环已消除；**未在真实断网/401 场景复现**。

#### A-04（P1）白板 op 被拒/限流后留下“幽灵笔迹”

- **现象**：客户端乐观应用 op 后，服务端拒绝或限流，UI 上留下服务端不存在的元素；后续 resync 才消失。
- **修复**：
  - 任何 `wb:op` ack 失败（包括 `rate_limited`）触发 120ms 防抖的权威全量 resync（[`room.ts:130`](../apps/desktop/src/renderer/store/room.ts#L130)、[`room.ts:213`](../apps/desktop/src/renderer/store/room.ts#L213)）。
  - 服务端为 `wb:resync` 增加 1/s、burst 3 的限流桶，避免失败风暴把 resync 变成放大攻击入口（[`context.ts`](../packages/server/src/realtime/context.ts)）。
- **验证**：冒烟测试覆盖 resync 返回的页与元素；单元测试覆盖客户端快照回退。

#### A-05（P1）删除当前页后 `activePageId` 悬空

- **现象**：老师删除正在展示的页，晚加入的学生拿到已删页 ID，白板空白；resync 也可能指向不存在的页。
- **修复**：
  - 服务端 `ensureActivePage()`：当前页不存在时回退第一页（[`wb.ts:82`](../packages/server/src/realtime/handlers/wb.ts#L82)）。
  - 接受 op 后若活动页被删，广播 `wb:page` 回退（[`wb.ts:172`](../packages/server/src/realtime/handlers/wb.ts#L172)）。
  - `wb:resync` 与 `wb:presence` 都走该回退（[`wb.ts:205`](../packages/server/src/realtime/handlers/wb.ts#L205)）。
  - 客户端 `applySync`/`applyBroadcast` 同样回退；`RoomRegistry` 恢复时也校验（[`WhiteboardClient.ts:125`](../packages/client-core/src/wb/WhiteboardClient.ts#L125)、[`RoomRegistry.ts:143`](../packages/server/src/realtime/RoomRegistry.ts#L143)）。
- **验证**：5 项单测 + 3 项冒烟（删除当前页、广播回退、resync 不含已删页）。

#### A-06（P1）白板落库丢最后一笔/旧快照覆盖新快照

- **根因**：`dirty` 在写盘前被清空；同一房间并发 `saveDoc` 可能乱序；失败后没有重试。
- **修复**：
  - 每房间串行化写盘（`persisting` 集合）；写盘期间的新 op 会在完成后再次排队（[`wb.ts:39`](../packages/server/src/realtime/handlers/wb.ts#L39)）。
  - 失败时恢复 `dirty` 并在 2 秒后重试；成功后才允许下一次（[`wb.ts:60`](../packages/server/src/realtime/handlers/wb.ts#L60)）。
  - `wb:lock` 也标记 dirty 并落库（[`wb.ts:277`](../packages/server/src/realtime/handlers/wb.ts#L277)）。
- **验证**：类型检查/冒烟；**没有专门的故障注入测试**。剩余风险：全量快照写放大、崩溃最多丢 2 秒。

#### A-07（P1）房间并发首次加载产生两个运行时

- **现象**：两个 socket 同时首次进入冷房间，`getOrLoad` 都查库并各自构造 `RoomRuntime`，后写入的覆盖先写入的，导致白板/成员状态分叉。
- **修复**：`await` 后二次检查 `this.rooms.get(roomId)`，若已有则复用并丢弃本次加载（[`RoomRegistry.ts:71`](../packages/server/src/realtime/RoomRegistry.ts#L71)）。
- **验证**：单测“并发首次加载复用同一个运行时”。

#### A-08（P1）白板锁定状态重启后丢失

- **根因**：`studentsCanDraw` 只在内存，序列化/恢复时没有带上。
- **修复**：`serializeDoc` 写入、`hydrate` 读取（默认 `true`）（[`RoomRegistry.ts:143`](../packages/server/src/realtime/RoomRegistry.ts#L143)、[`RoomRegistry.ts:160`](../packages/server/src/realtime/RoomRegistry.ts#L160)）。
- **验证**：单测“恢复时保留白板锁定状态”“序列化包含锁定状态”。

#### A-09（P1）客户端新建页超过 50 页产生幽灵页

- **现象**：客户端先本地加页，再发 `page.add`；服务端因 `MAX_PAGES` 拒绝，客户端文档里多出服务端不存在的页。
- **修复**：
  - `addPage` 达到上限直接返回（[`WhiteboardClient.ts:447`](../packages/client-core/src/wb/WhiteboardClient.ts#L447)）。
  - 批量导入按剩余额度截断（[`WhiteboardClient.ts:485`](../packages/client-core/src/wb/WhiteboardClient.ts#L485)）。
  - UI 在 50 页时禁用加页并提示（[`WhiteboardPanel.tsx:192`](../apps/desktop/src/renderer/wb/WhiteboardPanel.tsx#L192)）。
- **验证**：4 项单测（上限、禁止发送、批量截断）。

#### A-10（P1）`page.reorder` 接受重复页 ID

- **现象**：重复 ID 会让同一页在 `doc.pages` 中出现多次，后续渲染/序列化异常。
- **修复**：`new Set(op.order).size !== op.order.length` 直接拒绝（[`reduce.ts`](../packages/shared/src/model/reduce.ts)）。
- **验证**：2 项单测（拒绝重复、页序不变）。

#### A-11（P1）上传文件可绑定到任意课堂

- **现象**：任意已登录用户上传时传别人的 `roomId`，文件就会授权给该课堂参与者，形成越权读取。
- **修复**：带 `roomId` 上传时校验课堂存在，且调用者是房主或已加入该课堂（[`files.ts:59`](../packages/server/src/routes/files.ts#L59)）。
- **验证**：类型检查 + 冒烟；**没有专门的越权测试**，建议补集成测试。

#### A-12（P1）并发 refresh 可同时成功（本轮新发现）

- **现象**：同一 refresh token 的两个并发请求都能通过 `findValid`，各自换出一套新令牌；旧令牌轮换形同虚设。
- **根因**：`findValid` 与 `revoke` 是两次独立 SQL，中间有 `await` 让出事件循环。
- **修复**：
  - `revoke` 改为原子条件更新 `WHERE id=? AND revoked_at IS NULL`，并返回是否真正撤销（[`tokens.ts`](../packages/server/src/db/repos/tokens.ts)）。
  - `authService.refresh` 只有撤销成功才签发新令牌，否则 401（[`authService.ts:112`](../packages/server/src/services/authService.ts#L112)）。
- **验证**：冒烟新增“并发 refresh 只有一个成功”（状态 200/401），40/40 通过。

#### A-13（P1）考勤隐私与重复计时（本轮新发现）

- **隐私**：`GET /rooms/:id/report` 的注释写“学生看自己的那份”，实现却把全班参与记录返回给任何参与过的学生。
- **重复计时**：同一用户换连接/重连时，旧 socket 因“已被顶替”提前返回，不关闭旧的 `room_participants` 行；新连接又插入一条 open 行，在线人数与考勤时长把重叠时间算两遍。
- **修复**：
  - 非房主只返回自己的记录（[`rooms.ts`](../packages/server/src/routes/rooms.ts)）。
  - 进房时先关闭该用户在本房间的未关闭记录，再插入新记录（[`room.ts`](../packages/server/src/realtime/handlers/room.ts)）。
  - 在线人数改为 `COUNT(DISTINCT user_id)`（[`participants.ts`](../packages/server/src/db/repos/participants.ts)）。
- **验证**：冒烟新增“老师报告包含全班考勤”“学生报告只包含自己”，40/40 通过。

#### A-14（P2）服务崩溃后遗留未关闭的参与记录

- **现象**：重启后 `room_participants` 里上次运行的 open 行仍在，在线人数虚高、考勤时长失真。
- **修复**：启动时 `closeAllOpen(Date.now())`（[`index.ts:10`](../packages/server/src/index.ts#L10)、[`participants.ts:72`](../packages/server/src/db/repos/participants.ts#L72)）。
- **验证**：类型检查 + 冒烟落库校验；建议增加重启场景集成测试。

#### A-15（P2）GC 回收脏房间导致未落库白板丢失

- **修复**：`collectGarbage` 跳过 `dirty` 房间（[`RoomRegistry.ts:225`](../packages/server/src/realtime/RoomRegistry.ts#L225)）。
- **验证**：单测“脏房间不会被 GC 回收”“干净且空闲的房间会被回收”。

#### A-16（P2）白板按钮是禁用占位

- **修复**：ControlBar 改为真实切换视频/白板视图（[`ControlBar.tsx`](../apps/desktop/src/renderer/room/ControlBar.tsx)、[`RoomPage.tsx:358`](../apps/desktop/src/renderer/pages/RoomPage.tsx#L358)）。

#### A-17（P2）白板每帧对所有节点重复 `updateNode`

- **现象**：预览/光标每帧触发重绘时，未变化的元素也反复设置属性，元素多时浪费 CPU。
- **修复**：`nodeEls` 记录元素引用、`nodeZ` 记录 z 序、`lastTool` 记录工具变化；未变化节点跳过（[`Whiteboard.tsx:124`](../apps/desktop/src/renderer/wb/Whiteboard.tsx#L124)、[`Whiteboard.tsx:338`](../apps/desktop/src/renderer/wb/Whiteboard.tsx#L338)）。
- **验证**：构建 + 手动路径；无性能基准，建议补 500/2000 元素渲染基准。

#### A-18（P2）无 token 的 401 被误当成“需要刷新”

- **修复**：仅当请求原本带 access token 时才尝试 refresh（[`api.ts:77`](../packages/client-core/src/net/api.ts#L77)），避免登录失败被 refresh 掩盖。

#### A-19（P2）`wb:resync` 可被高频调用

- **修复**：新增 `wbSync` 桶（1/s，burst 3）（[`context.ts`](../packages/server/src/realtime/context.ts)）。

#### A-20（P2）重连时使用过期 rtc token

- **修复**：`reconnect_attempt` 时从 session 读取最新 rtc token 再握手（[`room.ts:529`](../apps/desktop/src/renderer/store/room.ts#L529)）。

#### A-21（P2）文档与测试数量漂移

- **修复**：README/HANDOFF 的冒烟数量更新为 40 项；新增 `npm run test:unit`。后续文档必须与脚本断言数同步。

### 3.2 未修复问题（按优先级）

> 这些不是“本轮遗漏”，而是需要架构升级或产品立项的已知边界。路线图见 [`CLASSIN-ROADMAP.md`](CLASSIN-ROADMAP.md)。

#### R-01（P0）Mesh 5 人上限，无法支撑大班/千人

- **证据**：`MAX_PARTICIPANTS = 5`（[`limits.ts:4`](../packages/shared/src/const/limits.ts#L4)）；`PeerManager` 为每个远端建一条 `RTCPeerConnection`，本地音视频/屏幕分别 replaceTrack 到所有 peer。
- **影响**：6 人以上上行带宽、编码 CPU、混流复杂度线性增长；1000 人同房在 Mesh 下完全不可行。
- **建议**：迁移 LiveKit SFU；保留现有白板/聊天信令，媒体层替换；大班用“主讲发布 + 观众只订阅 + 连麦申请上台”。

#### R-02（P0）单进程 + SQLite + 内存房间态，无法水平扩展/高可用

- **证据**：`RoomRegistry` 进程内 Map；SQLite 单文件；Socket.IO 未挂 Redis adapter；本地 uploads。
- **影响**：多实例会各持一份房间态；重启丢成员/ICE；部署重启 1~2 秒 502；无法滚动升级。
- **建议**：Postgres + Redis（房间态/限流/pub-sub）+ S3/MinIO + Socket.IO Redis adapter + sticky session；服务无状态化；蓝绿/滚动发布；备份与 PITR。

#### R-03（P1）角色可自选，缺租户/RBAC/SSO

- **证据**：注册时 `role = input.role === 'teacher' ? 'teacher' : 'student'`（[`authService.ts:67`](../packages/server/src/services/authService.ts#L67)），任何注册用户都能成为老师并建房；权限只区分 teacher/student，课堂权限只看 `hostId`。
- **影响**：无法做机构、校区、班级、助教、巡课、管理员；公开注册场景下可被滥用。
- **建议**：机构/租户模型 + 邀请制/审核制 + RBAC（admin/teacher/TA/student/parent）+ SSO(OIDC/SAML) + 审计日志。

#### R-04（P1）ClassIn 核心教学模块缺失

- 录播回放、作业收发/批改、考勤报表导出、答题卡/随堂测、计时器、分组讨论、大班/小班模式、课件库、排课、通知、学情分析均未实现。
- **建议**：按路线图 Phase 2~4 分模块交付；不要在当前单进程上加“假大班”。

#### R-05（P1）无可观测性与容量数据

- **证据**：只有 pino 日志和客户端诊断面板；没有 Prometheus/OpenTelemetry/Sentry；没有压测脚本。
- **影响**：无法回答“1000 人能不能扛”“卡顿在哪一段”“发布后是否回退”。
- **建议**：先接指标/追踪/错误聚合，再做容量基线；每次发布跑 k6 + LiveKit load test。

#### R-06（P1）关键修复缺真实 E2E 证据

- 远端音频、刷新死锁、CSP 背景图、真实摄像头/屏幕、跨公网弱网均未在完整 Electron 双窗口环境验证。
- **建议**：引入 Playwright Electron + 两个 `BrowserWindow`/两个用户上下文，使用 Chromium 假摄像头/假屏幕，断言远端音频 `audioLevel`、CSP 图片加载、401 刷新链路。

#### R-07（P1）文件安全与生命周期不足

- **证据**：只校验声明的 MIME；没有 magic bytes/图片解码上限/病毒扫描/配额/清理；文件落本地磁盘；签名 URL 12 小时且不可吊销；文件 HMAC 复用 `JWT_SECRET`。
- **建议**：对象存储 + 独立文件签名密钥 + 短 TTL + 吊销列表/版本号 + 上传后异步扫描 + 图片重编码 + 配额与生命周期。

#### R-08（P1）认证/权限加固不足

- 登出只撤销 refresh，access/rtc 在 TTL 内仍有效；无邮箱验证、找回密码、登录失败锁定、2FA、JWT 密钥轮换；`POST /rooms/join` 与 socket `room:join` 没有按 IP/用户的尝试限流，6 位码可被慢速枚举。
- **建议**：令牌版本号/黑名单、登录风控、join 限流、密钥 kid 轮换、2FA（教师/管理员）。

#### R-09（P1）聊天能力过窄

- 仅文本、500 字、历史 200 条；无图片/文件/表情/@/私聊/公告/敏感词/禁言/审核；无分页。
- **建议**：消息类型扩展 + 对象存储 + 审核/禁言 + 分页 + 保留策略。

#### R-10（P1）白板规模化与能力缺口

- 全量 sync 上限 2 MB，单页 4000 元素/单笔 2 万点时可超限，Socket.IO 会静默断开；删除墓碑永久累积；每 2 秒全量落库；无图片插入 UI（协议支持 image，`imageCache` 未填充）；无 PPTX/DOCX 导入；无导出；删除不可撤销；对象级橡皮。
- **建议**：分块快照 + 增量 op log + 定期压缩；大班只允许主讲/助教写；服务端转换 PPTX/PDF；导出 PNG/PDF；图片工具接入现有文件 API；评估 Yjs 仅用于多主编辑场景。

#### R-11（P1）屏幕共享能力不足

- `audio: false`（[`media.ts:274`](../apps/desktop/src/renderer/lib/media.ts#L274)），无系统声音；同一时刻只允许一人共享；15fps/1080p 上限；无共享批注、暂停、质量切换。
- **建议**：Electron/系统支持时采集 loopback 音频；LiveKit 屏幕轨 simulcast；主讲可授权多人共享；共享画布上叠加批注层。

#### R-12（P1）课堂管理能力不足

- 无等待室、全员静音、举手队列/上台审批、助教/联席主持人、移除学生、锁定课堂、主持人转移；学生可自行开麦/共享（仅受共享互斥限制）。
- **建议**：房间策略 + 权限服务 + 服务端强制；对应 LiveKit `canPublish`/`MutePublishedTrack`/`RemoveParticipant`。

#### R-13（P1）仅桌面端，缺 Web/iOS/Android 与自动更新

- **建议**：Web 复用 React + LiveKit；移动端 RN + LiveKit SDK + Skia 白板；桌面加 electron-updater + 代码签名/公证。

#### R-14（P1）备份/保留/合规未形成闭环

- 部署文档只建议备份 `data/`；无 PITR、无恢复演练、无数据保留/删除策略、无录制同意/水印、无审计日志。
- **建议**：RPO/RTO 目标、每日备份 + 每周恢复演练、PIPL/GDPR/COPPA/FERPA 评估、数据分级与保留策略。

#### R-15（P2）测试体系缺 CI 门槛与覆盖率

- 现有脚本强依赖本地服务和 Electron 环境；CI 只做 typecheck + 打包；无覆盖率阈值、无集成/E2E/压测/混沌流水线。
- **建议**：Vitest + coverage；Testcontainers 集成；Playwright/Detox E2E；k6/LiveKit load test；PR 必跑。

#### R-16（P2）数据库 schema 有未使用表

- `room_pages`、`wb_snapshots` 建了但代码未使用；白板分页元数据仍在 `doc_json`。
- **建议**：要么用于分页/快照，要么在迁移中删除，避免误导。

#### R-17（P2）渲染包体积与首屏

- renderer 2.1 MB、PDF worker 1.26 MB；pdfjs/Konva 全量在主 chunk。
- **建议**：路由级 code split、pdfjs 动态 import、Konva 懒加载；构建体积预算。

#### R-18（P3）可访问性/i18n/品牌化

- 无键盘导航审计、无屏幕阅读器标注、无多语言、无机构品牌主题。
- **建议**：按目标市场排期，不要阻塞核心教学功能。

#### R-19（P3）文档与运维脚本

- 需要补：故障演练手册、TURN/证书轮换、容量规划、日志字段规范、发布回滚清单。
- **建议**：随 Phase 1 的 observability 一起交付。

---

## 4. 性能与容量评估

### 4.1 当前实测/估算

| 场景 | 现状 | 判断 |
|---|---|---|
| 1 房间 5 人 Mesh | 每人 4 路上行（麦克风/摄像头/屏幕给 4 个 peer）；摄像头 250 kbps、屏幕 1~2.5 Mbps | 可用；屏幕共享时上行压力最大 |
| 10 房间 50 人 | 服务端只转发信令/白板；SQLite 写少 | 理论可用，未压测 |
| 200 房间 1000 人（每房 5 人） | 1000 个 socket、200 份白板内存 doc、SQLite 写 | 理论可连接；单进程/单库无 SLO，未验证 |
| 1 房间 1000 人 | Mesh 不可能；单进程广播也不可能 | **不支持** |
| 白板单页 4000 元素 | 全量 sync/落库；2 MB socket 上限 | 高风险，可能断连/写放大 |
| 渲染 2000 元素 | Konva 命令式 + 节点缓存 | 未做基准；预计可交互但需 code split/分层 |

### 4.2 主要瓶颈

1. **媒体上行/CPU**：Mesh 下每个客户端编码 N-1 路；屏幕共享码率高。
2. **白板全量同步/落库**：文档越大，`JSON.stringify`、socket 帧、SQLite 写越大。
3. **单进程事件循环**：白板 op 广播、序列化、SQLite 同步调用都在主线程。
4. **SQLite 单写者**：多房间高频写会排队；WAL 缓解读但不解决写。
5. **TURN 带宽**：跨 NAT 时中继流量按参与者对数增长。
6. **客户端包体积/首屏**：pdfjs/Konva 全量加载。
7. **缺少限流/背压**：大班场景下 op 扇出会放大。

### 4.3 目标容量（路线图验收口径）

| 指标 | 小班目标 | 大班目标 |
|---|---|---|
| 单房间参与者 | 1 老师 + 16 学生（全部互动） | 1~4 主讲 + 1000 观众（观众只订阅） |
| 同房媒体延迟 p95 | <300 ms（同区域） | 主讲/连麦 <300 ms；观众 WebRTC <500 ms 或 LL-HLS 1~3 s |
| 加入房间 p95 | <2 s | 95% 观众 <10 s |
| 白板 op 端到端 p95 | <150 ms | 观众 <500 ms（50 ms 批量合并） |
| 白板 op ack p95 | <100 ms | <150 ms |
| 断线重连 | <5 s | <5 s（观众可重新拉流） |
| 可用性 | 99.9% | 99.9%（大班 99.95%） |
| 错误率 | <0.1% | <0.1% |
| 连续运行 | 2 小时无内存增长/无断流 | 2 小时 + 1000 观众 soak |

> “千人同房且人人双向 <300ms”不作为目标：1000 个发布者需要 1000 路上行和 SFU 1000×999 的转发，成本与端侧 CPU 都不经济。大班的产品形态应是“主讲 + 少量连麦 + 大量旁听”。

---

## 5. 安全评估

### 5.1 已具备

- 密码 `scrypt`，格式含参数；不存在用户时也做等量耗时校验，降低邮箱枚举。
- access/rtc 双作用域；socket 只认 rtc；REST 只认 access。
- refresh 哈希落库、轮换、原子撤销（本轮修复）。
- Electron：`contextIsolation`、`sandbox`、`webSecurity`、CSP、`safeStorage`、预加载白名单。
- CORS 白名单；认证接口限流；白板/信令/聊天 per-socket 限流。
- 文件签名 URL、`X-Content-Type-Options: nosniff`；上传绑定课堂权限。
- 考勤报告隐私过滤（本轮修复）。

### 5.2 待补

| 项 | 风险 | 建议 |
|---|---|---|
| 角色自选 | 任意用户可注册为老师并建房 | 邀请制/审核制 + 机构 RBAC |
| 加入码爆破 | 6 位码，REST/socket 无尝试限流 | 按 IP+用户限流、失败退避、验证码/审批 |
| 登出吊销 | access/rtc 在 TTL 内仍可用 | token version/黑名单、短 TTL、主动断开 socket |
| 文件内容 | 只信 MIME，无 magic bytes/解码上限/杀毒 | 内容嗅探 + 重编码 + 扫描 + 隔离域 |
| 签名 URL | 12 小时不可吊销，复用 JWT secret | 独立密钥 + kid + 短 TTL + 吊销 |
| 密钥轮换 | 单一 JWT_SECRET | kid 多版本、定期轮换、密钥管理服务 |
| 审计 | 无登录/管理/下载审计 | 结构化审计日志 + 保留 |
| 2FA/风控 | 无 | 教师/管理员强制 2FA、登录风控 |
| 依赖安全 | 无 SCA/SBOM | npm audit/Trivy/Dependabot + SBOM |
| 合规 | 无录制同意/数据保留/未成年人策略 | PIPL/GDPR/COPPA/FERPA 评估与产品化 |

---

## 6. 测试覆盖评估

### 6.1 现有覆盖

| 层 | 覆盖 | 缺口 |
|---|---|---|
| 共享 reducer | 页增删/排序/上限、activePage 回退 | 复杂 patch 冲突、超大笔迹、压感异常的组合矩阵 |
| RoomRegistry | 恢复、锁定、seq、并发加载、GC | 真实 SQLite 故障注入、重启恢复 |
| 客户端白板 | sync/broadcast 回退、页上限、批量导入 | 断线重连期间的 op 队列、乱序/重复广播 |
| 服务端 | 认证、房间、聊天、共享互斥、踢旧连接、考勤隐私、并发 refresh | 加入码爆破、文件越权、上传内容、持久化失败 |
| 媒体 | 历史 RTC 40 项、合成摄像头/屏幕 | 远端音频 UI、真实设备、弱网、TURN 跨公网 |
| 渲染 | 构建 + 手工 | 2000 元素性能基准、视觉回归 |
| 安全 | CSP 单测 | CSP 真实页面加载、Electron 沙箱逃逸基线 |

### 6.2 建议的测试门槛

- 领域层（shared/server 纯逻辑）行覆盖 ≥80%，分支 ≥70%
- 关键协议路径（白板 op、认证、考勤、文件授权）必须有集成测试
- 每个 P0/P1 修复必须带回归用例（单元或冒烟）
- PR 必跑：typecheck + unit + smoke（临时库）+ build
- 发布前必跑：RTC/白板/PDF/文件/媒体 + Playwright E2E + 2 小时 soak
- 大班发布前必跑：1000 观众/200 房间压测 + 混沌演练

---

## 7. 可行性结论与建议顺序

### 7.1 结论

- **当前代码质量足以支撑小班 MVP 继续迭代**，不建议推倒重写。
- **不能在当前架构上直接加“大班/千人”**：Mesh、单进程、SQLite、内存房间态四个边界必须一起改。
- **最经济的路径**是保留 `shared` 白板模型、`client-core` 协议层和桌面 UI，媒体层替换为 LiveKit，服务端逐步拆出媒体/作业/考勤/录制模块。
- **完整对标 ClassIn 是产品工程，不是单点技术问题**：需要 8~10 人团队、约 10~12 个月、分阶段验收。

### 7.2 建议的立即行动（两周内）

1. 补 Playwright Electron 双窗口 E2E：远端音频、CSP 图片、401 刷新、关摄像头/切白板。
2. 加 CI：typecheck + unit + smoke + build；补 `test:rtc`/`test:wb` 的夜间任务。
3. 接入 Prometheus/OpenTelemetry/Sentry 基线：连接数、房间数、op 延迟、落库失败、TURN relay 比例。
4. 加入 join 限流、登出吊销、文件 magic bytes 校验。
5. 做一次 LiveKit 技术验证（1 老师 + 16 学生 + 100 观众），拿到真实 CPU/带宽/延迟数据，再决定 Phase 2 规模。
6. 补考勤导出与教师控制（全员静音、举手队列、移除学生），先把“能上课”做扎实。

---

## 8. 附录：关键文件索引

| 主题 | 文件 |
|---|---|
| 协议与上限 | `packages/shared/src/protocol/*`、`packages/shared/src/const/limits.ts` |
| 白板 reducer | `packages/shared/src/model/reduce.ts` |
| 白板客户端 | `packages/client-core/src/wb/WhiteboardClient.ts` |
| WebRTC | `packages/client-core/src/rtc/PeerManager.ts` |
| 服务端实时 | `packages/server/src/realtime/*` |
| 房间状态 | `packages/server/src/realtime/RoomRegistry.ts` |
| 认证 | `packages/server/src/services/authService.ts`、`db/repos/tokens.ts` |
| 文件 | `packages/server/src/routes/files.ts`、`lib/fileToken.ts` |
| 桌面安全 | `apps/desktop/src/main/security.ts`、`csp.ts` |
| 房间 UI/音频 | `apps/desktop/src/renderer/pages/RoomPage.tsx`、`store/room.ts` |
| 测试 | `scripts/unit-test.mts`、`scripts/smoke.mjs`、`scripts/*-test.cjs` |

> 相关文档：[`HANDOFF.md`](HANDOFF.md)（交接与踩坑）、[`protocol.md`](protocol.md)（白板协议）、[`deploy.md`](deploy.md)（部署）、[`CLASSIN-ROADMAP.md`](CLASSIN-ROADMAP.md)（完整开发方案）。

---

## 9. 2026-10-28 教学管理扩展复验

本节记录在 v1.1.3 基线上新增教学管理能力后的复验结论。原审计的媒体/规模结论不变：
**仍是 Mesh 5 人、单进程、SQLite；没有录制、SFU、移动端。**

### 9.1 新增范围

- 账号：手机号/资料/改密、四角色、管理员改角色与最后管理员保护。
- 教学管理：课程、课程成员（学生/助教）、课节排课/调整/取消与冲突检测、花名册、课件库、题库、作业与批改、站内通知、管理后台。
- 课堂：公告、全员静音、计时器、签到、答题卡（单选/多选/判断）、随机点名、奖励、举手队列、上讲台/下台、私聊/公聊、课堂记录。
- 权限：课堂管控按房间判定（房主/管理员/课程老师/课程助教）；全局老师凭码旁听不等于课堂教师。

### 9.2 审查中发现并修复的问题

| 问题 | 修复 |
|---|---|
| 课堂管控只看全局 `role === 'teacher'`，任何老师凭码进房即可接管 | `Member.staff` + `ParticipantDTO.isStaff`，服务端每个控制事件复验房态 |
| 作业附件的签名 URL 可被任意已登录用户换取 | `/files/url` 仅允许提交者或课程管理者换作业附件 |
| 两个管理员并发降级可能都通过“最后管理员”检查 | `setRoleGuarded` 在 `BEGIN IMMEDIATE` 中重读并写 |
| 课节创建/调整的冲突检查与写入非原子 | `insertIfNoConflict/updateIfNoConflict` 事务化 |
| 课节取消、`PATCH cancelled`、`room:end` 收尾不一致 | 统一走 `roomService.end`，同步房间/参与记录/lesson/广播 |
| 已批改作业仍可重交并覆盖成绩 | 提交前拒绝 graded；upsert 只更新内容与提交时间 |
| 学生答题结果页泄露他人作答 | 学生只看到汇总；staff 才看逐人明细 |
| 课件导入并发/页数上报不准 | 导入互斥；以客户端实际插入页数为准 |
| 失败提示被弹窗遮挡 | toast z-index 提升到 modal 之上 |
| 判断题与选择题切换丢失草稿 | 选项/答案草稿分离保存 |

### 9.3 复验结果

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | ✅ 4/4 workspace |
| `npm run test:unit` | ✅ 26/26 |
| `npm test`（核心冒烟） | ✅ 40/40 |
| `node scripts/platform-smoke.mjs` | ✅ 88/88（含房间级 staff 权限回归） |
| `npm run build -w @classroom/desktop` | ✅ |
| `npm run capture` | ✅ 23 张截图（登录/工作台/课程/课表/作业/通知/资料/设备/管理/课堂/答题/白板/课件） |

### 9.4 残余风险

- **媒体规模未变**：Mesh 5 人；不能据此宣称支持大班或千人。
- **无录制/回放**：课堂记录是数据库统计，不是可回放媒体；白板也没有事件回放。
- **无分组/投票/在线考试/家长端/机构层级/批量导入**。
- **无短信/微信登录与通知**；仅邮箱/手机号 + 密码、站内通知。
- **角色变更生效延迟**：JWT 中的角色在 access（15 分钟）/rtc（2 小时）令牌有效期内不变；被改角色的在线用户需刷新令牌或重进课堂才完全生效。课堂 staff 标记在进房时计算，改课程助教后需重进。
- **SQLite 并发上限**：`busy_timeout=5000`，极端多进程写入仍可能 `SQLITE_BUSY`；单机部署可接受，多实例需换 PostgreSQL。
- **文件 URL 不可主动吊销**：签名 URL 到期前仍可访问；没有对象存储级的撤销。
- **课堂记录不是学习分析**：只有时长/消息/白板统计，没有出勤率、正确率、奖励排行等学情报表。
- **UI 验收是截图级**：23 张截图覆盖主要页面与状态，但没有视觉回归基线、不同分辨率或弱网下的系统测试。
