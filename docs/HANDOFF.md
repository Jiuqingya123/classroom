# 项目交接文档（给下一个 AI / 开发者）

> 读这份文件之前不需要任何历史上下文。看完 + 跑一遍「快速自检」，你就能接手继续开发。
>
> 相关文档：本轮审计与修复清单见 [`AUDIT.md`](AUDIT.md)；对标 ClassIn 的分阶段开发方案见
> [`CLASSIN-ROADMAP.md`](CLASSIN-ROADMAP.md)。

---

## 1. 这是什么

**ClassRoom** —— 一个 ClassIn 风格的在线互动教室，覆盖 Windows / macOS 桌面端与 Android 客户端。

1 位老师 + 最多 4 位学生，跨公网真上课：**音视频（WebRTC Mesh）** + **屏幕共享（桌面端）** + **协同白板（支持 PDF 课件导入）** + **聊天** + **课堂记录**。

当前状态：本轮版本（1.1.3）已于 2026-10-28 部署到公网 `http://<PROD_SERVER_IP>:9999`，
课程、课节、课件、题库、作业、通知、管理后台与课堂互动接口均已上线；本地与公网两套冒烟均通过。
另已完成 Windows 家庭服务器部署包（`dist/ClassRoomServer-1.1.3-win-x64.zip`）和云端专用
frp 中继（TCP 7100 → 127.0.0.1:8091），但**生产流量仍在云端 8090，尚未切流，也未在真实
Windows 上安装**；迁移与回滚见 [`windows-server.md`](windows-server.md)。
全平台客户端已完成类型检查、自动化测试、构建与截图验收。
另有一个**临时的腾讯云课堂（LCIC）并列入口**：课程页可在系统浏览器打开腾讯课堂，不影响自建课堂；
产品已公告 2026-10-30 停止新购，是否启用、如何下线见 [`lcic.md`](lcic.md)。
媒体拓扑仍是 1 老师 + 4 学生 Mesh；录制/回放、分组与大班能力未实现（见 §14-6、§15-5）。
客户端覆盖 **macOS（arm64/x64）、Windows x64（免安装 zip）、Android（APK）**；macOS arm64 已实机启动、登录并验证重启会话恢复，Android 已在 API 35 模拟器端到端验证，Windows 只完成构建未在真实 Windows 上启动（见 §15）。

### 本次交接相对上一版新增（2026-10-27）

| 章节 | 内容 |
|---|---|
| §12 | Windows 客户端适配 + 打包体系重写（nsis/dmg、图标、默认连生产、可重复打包） |
| §13-1~13-6 | 数位板压感：`pressures` 字段、逐点落库、变宽渲染（高漫 / Wacom / Windows Ink） |
| §13-7 | 手写笔「乱飞」根因与输入隔离规则（pen/mouse 双报、pointerId 认主、侧键、失焦） |
| §13-8 | 笔输入诊断面板（白板内 `Ctrl+Shift+D`） |
| §13-9 | 客户端 502 排查结论 + 直连策略 + 服务端日志 |

今天新增/改动的测试：`npm run test:ink`（9）、`npm run test:pressure`（14）、`npm run test:media`（9）、
`node scripts/win-smoke.cjs`（13）、`node scripts/pen-e2e.cjs`（真机端到端，画三笔含干扰用例）。

一句话技术画像：**Electron 45 + React 19 + Vite 8（客户端）；Fastify 5 + Socket.IO 4 + Node 内置 sqlite（服务端）；WebRTC Mesh + 自建 coturn（音视频）；Konva 命令式渲染（白板）。自研协同协议，无任何第三方云依赖。**

---

## 2. 技术栈与依赖面（重要）

| 层 | 技术 | 备注 |
|---|---|---|
| 桌面壳 | Electron 45 | 主进程做窗口/权限/屏幕采集 IPC |
| 渲染层 | React 19 + Vite 8（electron-vite） | zustand 管状态 |
| 白板渲染 | **Konva（纯命令式）** | **刻意不用 react-konva**，见 §7 |
| PDF | pdfjs-dist | worker 走 `?url` 导入 |
| 服务端 | Fastify 5 + Socket.IO 4 | 挂在 `127.0.0.1:8090` |
| 数据库 | **Node 内置 `node:sqlite`**（`DatabaseSync`） | **不是 better-sqlite3**，见 §7 |
| 密码哈希 | **Node 内置 `crypto.scrypt`** | **不是 argon2**，见 §7 |
| 音视频 | WebRTC RTCPeerConnection（Mesh，5 人） | 自建信令 + coturn 中继 |
| 语言 | TypeScript，monorepo（npm workspaces） | 服务端用 `tsx` 直接跑 TS，无编译产物 |

**关键：服务端零原生依赖**。`npm install` 秒级完成，任何 glibc 版本都能跑。这是踩了两个大坑之后的刻意选择（见 §7-3）。

---

## 3. 目录结构

```
.
├── apps/mobile/                # Capacitor Android 工程（复用 desktop 渲染层产物）
│   ├── android/                #   Gradle 工程、MediaPermissionsPlugin、签名配置
│   ├── www/                    #   build:web 的输出（不要手改）
│   └── capacitor.config.ts
├── apps/desktop/               # Electron 客户端 + Web 构建入口
│   ├── src/main/               #   主进程：窗口、IPC、屏幕采集、会话加固
│   ├── src/preload/            #   contextBridge 暴露 window.desktop.*
│   └── src/renderer/           #   React 前端
│       ├── pages/              #     Login / Lobby / RoomPage
│       ├── components/         #     VideoTile / Toolbar / RoomReportModal ...
│       ├── wb/                 #     白板：Whiteboard.tsx(Konva) / Toolbar / WhiteboardPanel
│       ├── store/              #     zustand：session / nav / room
│       ├── lib/                #     api / files(上传) / pdf(渲染) / import(导入编排)
│       └── styles.css
├── packages/
│   ├── shared/                 # 双端共用的协议类型 + 纯函数（无任何 IO 依赖）
│   │   └── src/
│   │       ├── protocol/       #   auth/room/whiteboard/rtc/chat/files/events 类型定义
│   │       ├── model/          #   order(z序) / element / geometry / hit / reduce(核心!)
│   │       └── const/          #   tools(工具面板) / limits(上限)
│   ├── server/                 # Fastify + Socket.IO 服务端
│   │   └── src/
│   │       ├── db/             #   openDb/migrate + repos(users/rooms/participants/messages/tokens/files)
│   │       ├── routes/         #   auth / rooms / rtc / files
│   │       ├── realtime/       #   io / RoomRegistry / handlers(room/rtc/wb) / context(限流)
│   │       ├── services/       #   authService / roomService / turnService
│   │       └── lib/            #   errors / password(scrypt) / fileToken(签名URL) / cors
│   └── client-core/            # 客户端与网络无关的核心逻辑
│       └── src/
│           ├── net/            #   api(HTTP) / socket(ws)
│           ├── rtc/            #   ice / PeerManager / stats / tuning
│           └── wb/             #   WhiteboardClient（白板状态机，Konva 无关）
├── scripts/                    # 全部是自动化验证 / 部署脚本（见 §5）
├── docs/                       # deploy.md(部署) / protocol.md(协同协议) / screenshots/
└── .env.example                # 环境变量模板
```

### 读代码的建议顺序

1. `packages/shared/src/protocol/*` —— 先理解「协议」，所有东西都围绕它。
2. `packages/shared/src/model/reduce.ts` —— 白板协同的核心纯函数（服务端客户端共用）。
3. `packages/server/src/realtime/` —— 服务端事件流。
4. `packages/client-core/src/wb/WhiteboardClient.ts` —— 客户端白板状态机。
5. `apps/desktop/src/renderer/wb/Whiteboard.tsx` —— Konva 渲染层。

---

## 4. 如何跑起来

### 依赖
- Node ≥ 22（本机默认 node 是 20，跑服务端/冒烟用 `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron ...`）
- 服务端：跨平台（零原生依赖，Windows 上实测可直接跑）
- 桌面客户端：macOS 12+ / Windows 10+
- Android：JDK 21 + SDK 35；打包链路见 `docs/build.md` 第 4 节

```bash
npm install        # 根目录，workspaces 一次装全
```

### 本地开发（服务端 + 客户端）

```bash
# 终端 1：服务端
cp .env.example .env     # 开发环境用默认值即可
npm run dev:server       # http://localhost:8080  → GET /healthz

# 终端 2：客户端（Electron 窗口）
npm run dev              # 默认连 localhost:8080
```

> 首次启动会请求摄像头/麦克风权限。如果窗口起不来报 `sandbox initialization failed`，
> 是受限运行环境的问题，加 `-- --no-sandbox`：`npx electron-vite dev -- --no-sandbox`（在 apps/desktop 下）。

### 连线上环境

```bash
npm run dev:remote       # 已配置 CLASSROOM_SERVER_URL=http://<PROD_SERVER_IP>:9999
```

---

## 5. 验证（全部是自动化脚本，已经跑通）

| 命令 | 覆盖 | 结果 |
|---|---|---|
| `npm run typecheck` | 全 workspace 类型检查 | ✅ |
| `npm run test:unit` | 白板 reducer/页上限/RoomRegistry/CSP 单元回归（26 项） | ✅ 26/26 |
| `npm run smoke` | 注册/登录/建房/进房/名单/聊天/踢旧连接/考勤隐私/并发 refresh/下课（40 项） | ✅ 40/40 |
| `npm run check:order` | 白板 z 序键边界 | ✅ |
| `npm run test:file` | 文件上传/签名访问/课堂记录（21 项） | ✅ |
| `npm run test:rtc` | 三端 Mesh 音视频 + 屏幕共享（40 项） | ✅ 40/40 |
| `npm run test:wb` | 三端白板收敛（31 项） | ✅ 31/31 |
| `npm run test:pdf` | PDF 课件导入端到端 | ✅ |
| `npm run test:turn` | **强制 relay** 验证 TURN 中继 | ✅ relay→relay |
| `npm run test:media` | 摄像头采集降级链（9 项，无需硬件） | ✅ 9/9 |
| `node scripts/platform-smoke.mjs` | 教学平台：课程/课节/课件/题库/作业/通知/管理/课堂互动与房间权限（88 项） | ✅ 88/88 |
| Android 模拟器手工 E2E | 登录/会话恢复/进房/相机麦克风/白板/抽屉/课件/下课/课堂记录 | ✅ API 35 Pixel 7 |

> 2026-10-27 审计后：`test:rtc`/`test:wb`/`test:pdf`/`test:file`/`test:media`/`test:ink`/`test:pressure`/`test:turn`
> 本轮未重跑（依赖真机/合成设备/development server），合并前应回归一次。

运行 Electron 测试需要先起 renderer dev server（`npm run dev:remote` 或 `VITE_SERVER_URL=... electron-vite dev`），
并把 `BASE` 指向目标服务端，例如：

```bash
BASE=http://<PROD_SERVER_IP>:9999 npx electron --no-sandbox scripts/wb-test.cjs
```

### 自动化测试的通用机制（很重要）

- `rtc-test.cjs` / `wb-test.cjs` / `pdf-test.cjs` 用 Electron 开多个窗口，通过
  **注入到页面的 `window.__classroomDebug`** 钩子驱动真实 UI 流程。
- 白板收敛测试直接调 `__classroomDebug.wb().addElement/patchElement` 等，走的是和生产完全相同的代码路径。
- 客户端 main 进程在 dev 模式挂载了 `__classroomDebug`（`apps/desktop/src/main/` 里），
  renderer 的 `store/room.ts` 里有对应的暴露。**别删，测试依赖它。**
- TURN 测试 `turn-test.cjs` 用 `iceTransportPolicy:'relay'` 禁止直连，证明中继真的能转发。

---

## 6. 生产部署拓扑（已在 `<PROD_SERVER_IP>` 运行）

```
客户端(Electron) ──http/ws──▶ nginx(0.0.0.0:80 + :9999) ──proxy──▶ Fastify(127.0.0.1:8090)
                                                                    │
                                                    ┌───────────────┼───────────────┐
                                                    ▼                               ▼
                                          SQLite /opt/classroom/data/app.db    coturn(3478/udp+tcp, 中继 49160-49200)
                                          (node:sqlite, WAL)
```

| 项 | 值 |
|---|---|
| 服务器 | 阿里云 ECS，Alibaba Cloud Linux 3，2 vCPU / 1.8G（**glibc 2.32**，有宝塔面板托管其他站点） |
| 主端口 | **9999**（nginx 同时监听 80 作兜底） |
| 应用目录 | `/opt/classroom` |
| 服务 | `systemctl status classroom`（MemoryMax=800M）、`systemctl status coturn` |
| nginx vhost | `/www/server/panel/vhost/nginx/classroom_<PROD_SERVER_IP>.conf` |
| 密钥 | `/opt/classroom/.env`（随机生成，0600） |
| 数据 | `/opt/classroom/data/`（app.db + uploads），重装不动它 |

### 部署脚本

```bash
KEY=/path/to/deploy-key npm run deploy:push   # 增量：打包源码→上传→npm install→重启→健康检查
# 首次部署（服务器上执行）：
#   ssh root@<PROD_SERVER_IP> 'cd /opt/classroom && PUBLIC_PORT=9999 bash deploy.sh'
```

SSH 私钥由部署者本地保管（权限 600），不在仓库里；不传 `KEY` 时走本机 ssh-agent。
2026-10-28 部署记录：数据库与代码备份在 `/opt/classroom-backups/20261028-111253/`，
迁移 `002_teaching_platform.sql` 已应用；远程核心冒烟 35/35、平台 75/75 通过
（本地专属的管理员提权与落库校验在远程模式跳过）。

详细见 `docs/deploy.md`。

---

## 7. 关键设计决策与「为什么」（改了会出事的地方）

### 7-1 白板协同：服务端权威 doc + op 广播（不是 CRDT）

`packages/shared/src/model/reduce.ts` 里有 `applyOp`（服务端校验+改写）和 `applyTrusted`（客户端应用广播）。
**双端跑同一份代码是收敛的前提**，改这里必须两边一起改。

四条收敛规则（`docs/protocol.md` 有完整说明）：
1. 创建：`order` 由服务端分配，客户端传的被忽略。
2. 修改：`rev` 乐观锁，先到服务端者胜，落败方回拉。
3. 自由笔迹：pointerup 前只发 `wb:preview`（不入 seq、不落库），抬手才发一条 add。
4. 删除：软删 `deleted:true`，之后 patch 一律 reject（墓碑，禁止复活）。

**为什么不用 CRDT**：笔迹抬手后不可变、没有合并语义；5 人以内 LWW 足够。

### 7-2 白板用纯 Konva，不用 react-konva

手写预览是 60Hz 更新，走 React 会连带整棵元素树 diff。Stage 只建一次，
`client.subscribe(redraw)` 命令式重绘。React 只管低频 UI（工具栏、文本编辑框、页码）。

### 7-3 数据库和密码哈希是「被逼」换的（换回原生模块会再次踩坑）

服务器 glibc 2.32，而：
- better-sqlite3 官方预编译要 **glibc ≥ 2.33**，从源码编译又被 node-gyp 卡死（Python 版本 + 空 gyp 目标）。
- argon2 同理需要 C++ 工具链。

**结论**：数据库用 `node:sqlite`，密码用 `crypto.scrypt`（格式 `scrypt$N$r$p$salt$hash`）。
服务端零原生依赖，`npm install` 5 秒。**不要轻易把这两个依赖加回来。**

### 7-4 TURN 在 NAT 云主机上的正确配置（踩过坑）

机器网卡是内网 `<PROD_SERVER_PRIVATE_IP>`，公网是 NAT。正确写法：

```
external-ip=<PROD_SERVER_IP>/<PROD_SERVER_PRIVATE_IP>
relay-ip=<PROD_SERVER_PRIVATE_IP>        # 必须是真实网卡地址，绝不能 0.0.0.0
```

- `relay-ip=0.0.0.0` → 对端 CreatePermission 403，表现是「能拿到 relay 候选但连不上」。
- TURN 回退 TCP 挂在 **3478**（两种传输都 3478），不要用 5349（那是 TLS 端口，且被安全组挡）。
- 凭据用 coturn `use-auth-secret` + HMAC 动态签发（`services/turnService.ts`），固定密码不落客户端。

### 7-5 文件访问用签名 URL，不用 access token

图片要进 `<img src>` / Konva.Image，带不了 Authorization 头。
`lib/fileToken.ts` 用 HMAC 签 `fileId.exp`，短链 12 小时有效，泄露只影响单个文件。

---

## 8. 踩过、且容易再踩的坑（速查）

1. **`generateKeyBetween(null, null)` 抛错**：无界必须传 `null` 不能传空串（否则空页第一笔就崩）。
2. **z 序键无限增长**：追加到末尾必须先「就地递增最后一位」，顶到 `z` 才加长；否则 200 次追加键长 40+。
3. **新建页 op 的 pageId 必须是已存在的页**：传新页 id 会被服务端判 `bad_op`。
4. **文本元素第二轮重绘消失**：`width:0` 表示自适应，`setAttr('width', 0)` 会压成 0 宽，要显式设回 `'auto'`。
5. **拒绝原因 `locked` vs `forbidden` 要分清**：锁定 vs 不是你的元素，提示语不同。
6. **跨公网测试超时**：socket 首连约 8~12s（已把客户端 timeout 降到 8s）；自动化测试的等待窗口要给足（已放宽到 30s）。
7. **Electron 主进程 `require('electron').app` 为 undefined**：是环境里 `ELECTRON_RUN_AS_NODE=1` 污染，`env -u ELECTRON_RUN_AS_NODE` 解除。
8. **`.run()` 返回 `changes` 可能是 `bigint`**：node:sqlite 下要 `Number(...)` 再赋值。

---

## 9. 已完成 vs 待办

### 已完成（阶段 0~8）

- 阶段 0：骨架 + 协议层
- 阶段 1：账号体系 / 建房进房 / 摄像头 / 聊天
- 阶段 2：Mesh 音视频 / 屏幕共享 / 连接诊断
- 阶段 3：协同白板（画笔/荧光笔/橡皮/形状/文本/撤销/锁定/翻页/光标）
- 阶段 4：PDF 课件导入 + 课堂记录
- 阶段 5：部署上线（nginx + systemd + coturn）
- 阶段 6：Windows 客户端适配 + 打包体系
- 阶段 7（2026-10-28）：ClassIn 教学管理扩展（课程/课节/课件/题库/作业/通知/管理后台/课堂互动/房间级权限/课堂记录），详见 §14
- 阶段 8（2026-10-28）：全平台客户端（Android Capacitor + 移动端响应式 UI + 原生媒体权限 + Windows/macOS/Android 打包），详见 §15

### 待办（建议的下一步，按优先级）

1. **在真实 Windows 上验收**：`ClassRoom-1.1.3-win-x64.zip` 解压运行、摄像头权限、安装路径；如需安装器，在 Windows 上跑 `npm run dist:win`。详见 `docs/build.md`。
2. **上传目录清理**：`/opt/classroom/data/uploads` 会随课件增长，加 cron。
3. **PDF 手写批注的字形**：自造的测试 PDF 没内嵌 CJK 字体导致乱码（渲染器没问题，是测试 PDF 的问题），真实 PDF 一般自带字体或由 pdfjs 处理。
4. **摄像头/屏幕采集的真机验证**：受限测试环境 `videoWidth=0`，真机画面需在正常桌面会话确认。采集链路的降级逻辑已用 `npm run test:media` 覆盖。
5. **白板撤销重做**：删除是终态（墓碑规则），不支持撤销删除；重做「新增」会换新 id。这是设计取舍，不是 bug。
6. **代码分割**：renderer 单 chunk 约 2.1MB（pdfjs + Konva 都在里面），首屏可优化。
7. **Windows 代码签名**：没买证书，首次运行会弹 SmartScreen「未知发布者」；配 `CSC_LINK` 即可消除，配置不用改。

---

## 10. 环境变量速查

见 `.env.example`。关键项：

| 变量 | 作用 | 默认 |
|---|---|---|
| `PORT` / `HOST` | 服务端监听 | 8080 / 0.0.0.0（生产 8090 / 127.0.0.1） |
| `JWT_SECRET` | 登录态签名 | 开发有兜底值，生产必须设 |
| `ALLOWED_ORIGINS` | CORS 白名单 | 含 `file://`、`null`、localhost、`capacitor://localhost` |
| `TURN_HOST/PORT/SECRET` | TURN 配置 | 空 = 只 STUN |
| `MAX_PARTICIPANTS` | 单房人数 | 5 |
| `LCIC_ENABLED` / `LCIC_SDK_APP_ID` / `LCIC_SECRET_ID` / `LCIC_SECRET_KEY` | 腾讯云课堂并列入口（临时） | 凭据为空即关闭，见 [`lcic.md`](lcic.md) |
| `LCIC_ROOM_TTL_HOURS` | 腾讯房间有效期 | 24（腾讯硬上限） |
| `CLASSROOM_SERVER_URL` / `MAIN_VITE_SERVER_URL` / `VITE_SERVER_URL` | 客户端连的服务端地址 | localhost:8080 |
| `CLASSROOM_KEYSTORE` 等 4 个 | Android release 签名 | 未设置时出未签名包 |

---

## 11. 交接包内容

本仓库打包含（不含 `node_modules`、`packages/server/data`、`apps/desktop/out`、`.env`、`.workbuddy`）：

- 全部源码 + 配置 + `package-lock.json`
- `apps/mobile`（Capacitor Android 工程，不含生成的 `www` 与 `android/.gradle`）
- `docs/`（protocol.md、deploy.md、HANDOFF.md、screenshots/、build.md）
- `scripts/`（全部测试 + 部署脚本）
- `.env.example`

在干净机器上 `npm install && npm run dev:server` + `npm run dev` 即可复现。
Android 需另装 JDK 21 / SDK 35，按 `docs/build.md` 第 4 节构建。

---

## 12. Windows 端适配与打包（本轮改动，2026-10-27）

### 12-1 摄像头「打不开」的真实原因

三条独立的坑，都修了：

1. **macOS 权限预检是死代码**。主进程实现了 `requestMediaAccess`（内部 `askForMediaAccess`），
   但渲染层**从来没调用过**。macOS 上不主动问一次，首次 `getUserMedia` 可能直接拿到
   `NotAllowedError` 而系统授权框不弹 —— 表现就是「点了摄像头没反应」。
   现在进房前先 `Promise.all([requestMediaAccess('camera'), requestMediaAccess('microphone')])`，
   明确被拒就不再白试，直接语音课堂 + 给一条能点开系统设置的提示。
2. **重开摄像头会把麦克风一起弄死**。旧的 `acquireLocalStream` 第一步就 `releaseLocalStream()`
   （停掉所有轨），摄像头申请失败时麦克风已经没了，且 `pm.setLocalStream` 还指着死流。
   现在改成：只停「这次要重新申请的那一类」，新流拿到才替换；失败时把旧轨拼回去。
3. **失败后没有降级**。以前 `deviceId:{exact}` + 720p 一条道走到黑，任何一条约束不满足整次调用就失败。
   现在四级降级：`指定设备+720p → 指定设备 → 无设备+720p → 全默认`，
   全失败还把音视频**拆开**单独申请（麦克风被腾讯会议占用时，摄像头本来是好的）。

另外加了**首帧检测**（`waitForVideoFrames`）：`getUserMedia` 成功不等于有画面，
macOS 上「协商成功但不出帧」会让界面显示一张全黑视频。3.5 秒内 `settings.width` 还是 0
就给提示，而不是让人对着黑屏猜。

`npm run test:media` 用打桩把这 9 种情况全盖住了（含「重开失败麦克风仍存活」的回归）。

### 12-2 Windows 客户端

- 窗口壳：mac 用 `hiddenInset`（红绿灯内嵌），Windows 用**系统原生标题栏** + 隐藏菜单栏。
  没用 `titleBarOverlay` 是因为窗口控件会压在房间顶栏的「视频/白板/⏱/退出」上，
  而 `.topbar`（大厅，浅色）与 `.room-header`（房间，深色）配色不同，一个 overlay 颜色匹配不了两个页面。
- 平台标识写进 `<html data-platform>`，样式据此把 macOS 红绿灯的 88~92px 留白收回去。
- `app.setAppUserModelId('com.hcf.classroom')`：任务栏分组与通知归属。
- 权限文案按平台分叉（Windows 指到「隐私和安全性 → 相机」，不是 macOS 的「隐私与安全性」）。

### 12-3 打包

`apps/desktop/electron-builder.yml` 重写：

- Windows：`nsis` x64，非一键安装、可选目录、装用户级（免 UAC）、卸载保留 AppData
- macOS：`dmg` + `zip`，arm64 与 x64 各一份
- `identity: '-'`（**ad-hoc**）。原来的 `identity: null` 是「完全不签名」，
  那样在 Apple Silicon 上装完会直接报「已损坏」—— 这是个会让人以为包坏了的坑
- 图标：`scripts/make-icon.py` 从一张 1024 PNG 生成 png/ico/icns 三份
- `pdfjs-dist` 从 `dependencies` 移到 `devDependencies`（它只被 vite 打进产物），
  asar 从可能 10MB+ 降到 3.3MB
- `electron` 版本必须精确（`45.0.0`），写 `^45.0.0` 会让 electron-builder 直接报错退出
- 交付包默认连 `http://localhost:8080`（`apps/desktop/.env.production`）；连生产环境用
  `CLASSROOM_SERVER_URL=http://<PROD_SERVER_IP>:9999`，或在登录页「服务器」里改

```bash
npm run dist:win    # Windows 上，产物 apps/desktop/dist/ClassRoom-Setup-1.0.0-x64.exe
npm run dist:mac    # macOS 上，产物 ClassRoom-1.0.0-{arm64,x64}.dmg + .zip
node scripts/win-smoke.cjs   # 启动打包产物 + CDP 断言（13 项）
```

**跨平台打包做不到**：Windows 上跑 `--mac` 会直接报
`Build for macOS is supported only on macOS`。要一次出两端用 `.github/workflows/build.yml`。
详见 `docs/build.md`。

### 12-4 已知限制

- macOS 包目前是 ad-hoc 签名，别人第一次打开要右键 → 打开（或 `xattr -dr com.apple.quarantine`）。
  有 Developer ID 后删掉 `identity: '-'` 并配 `CSC_LINK` 等环境变量即可正式签名 + 公证。
- Windows 包没代码签名，首次运行弹 SmartScreen「未知发布者」，属预期。
- 真机摄像头画面仍需在带摄像头的机器上确认（开发机是无摄像头的云主机，
  自动化用 Chromium 合成设备验证，出帧 1280×720 正常）。

---

## 13. 数位板压感（高漫 / Wacom 等）

### 13-1 结论先看

Windows 上插高漫（Gaomon）数位板，**驱动切到「Windows Ink」模式**就能用：
笔迹粗细随按压力度变化。驱动如果设成「WinTab」或「鼠标模式」，
浏览器只能收到鼠标事件，压感永远是一个固定值 —— 这不是客户端的问题，客户端也测不出来。

驱动面板里要确认的两项（各版本叫法略有差异）：

- 模式：`Windows Ink`（有的叫「Windows Ink 兼容」）—— 不要选 WinTab / Mouse
- 勾选「Windows Ink」下的一切实体笔支持；有些型号还要关掉「鼠标模式」

### 13-2 数据怎么走

```
PointerEvent(pointerType='pen', pressure=0~1)
  → WhiteboardClient.startStroke / extendStroke 收集逐点压感
  → 抬手后 simplifyStroke 同时裁剪点集与压感（保证一一对应）
  → 元素带 pressures: number[] 经 wb:op 上行
  → 服务端 pickFields 校验（夹紧到 [0,1]、长度必须等于点数）后入库 + 广播
  → 各端 createInkShape 逐段描边渲染
```

字段是**可选**的：

- 鼠标/触屏笔迹没有 `pressures`，渲染路径与改动前完全一致
- 老客户端收到带 `pressures` 的元素会忽略该字段，按等宽画 —— 不会崩、不会串位
- 压感全程无起伏时（有的驱动只报固定值）不写数组，避免白占空间

### 13-3 渲染为什么不用 Konva.Line

`Konva.Line` 只有单一 `strokeWidth`，画不出「起笔细、按压粗」；canvas 本身也不支持变宽描边。
`apps/desktop/src/renderer/wb/ink.ts` 的 `drawInk` 逐段设置 `lineWidth` 再描边，
相邻段用 round cap 衔接。压感连续变化，按 0.5px 分桶合并，几百个点通常只剩几十次 stroke。

命中判定不受影响：橡皮擦和选中走的是 `shared/model/hit.ts` 的几何判定，
所以自绘节点直接 `listening:false`，省掉一份 hit canvas。

### 13-4 压感 → 线宽的映射

`pressureWidthRatio(p) = 0.35 + 0.65 * p`（`packages/shared/src/model/geometry.ts`）

下限取 0.35 而不是 0：轻压起笔时压感可能只有 0.02，按比例算出来线宽 0.1px，
投影/大屏上等于没画。要调手感改这一个函数即可，**预览和最终笔画共用它**，不会出现「画的时候粗、松手变细」。

### 13-5 怎么验

| 命令 | 覆盖 |
|---|---|
| `npm run test:ink` | 9 项：线宽映射、分桶、单点、异常压感数组 |
| `npm run test:pressure` | 14 项：简化对齐、服务端夹紧/丢弃脏数据 |
| `node scripts/pen-e2e.cjs` | 真机端到端：启动打包客户端 → 建房 → 白板 → 用合成笔事件画两笔 → 截图 |

`pen-e2e.cjs` 用 `pointerType:'pen'` 的合成 PointerEvent，走的是和生产完全相同的代码路径，
笔迹能留在画布上并落库（`grep pressures /opt/classroom/data/app.db-wal` 可验证），
说明服务端确实接受了该字段。

**注意**：这个功能服务端也要更新（`PATCHABLE` 里要有 `pressures`）。
只换客户端的话，别人看到的是等宽线 —— 自己画自己看没问题，很容易误判成「好了」。

### 13-6 还没做的

- 倾斜（tiltX/tiltY）和笔旋转没有使用，高漫部分型号支持侧锋，要做可以按同样方式扩展字段
- 橡皮擦仍是对象级删除，不做像素级擦除（设计取舍，见 docs/protocol.md）
- 触屏掌托抑制：目前只按 `pointerType==='pen'` 区分，没有做「笔在手时忽略手掌」的时间窗判断

### 13-7 笔迹「乱飞」的根因与输入隔离规则（1.1.1 修复）

数位板驱动（高漫等）在 Windows Ink 模式下会把**同一支笔同时上报成 pen 和 mouse 两套事件**
（Windows Ink 的 WM_POINTER + 系统鼠标模拟）。两套事件位置相同但 `pointerId` 不同，
旧实现不做区分，于是：

| 干扰事件 | 后果 |
|---|---|
| 笔侧键（驱动默认映射成中键） | 命中「中键平移」分支 → 整个画布被拖飞 |
| 鼠标模拟的 `pointerup` | 正在画的那一笔被提前结束，一笔变成一串碎线 |
| 鼠标模拟的 `pointermove`（光标在别处） | 笔迹被拽到光标位置，来回跳动 |
| 空格键 keyup 丢失（切窗口） | `spaceDown` 永久为 true，之后每次落笔都变成拖画布 |

现在 `Whiteboard.tsx` 的输入入口有这几条硬规则：

1. **按 pointerId 认主**：`activePointerId` 记下开始这一笔的指针，其他 id 的 move/up 一律丢弃。
2. **笔活动期间忽略鼠标**：`lastPenAt` 2 秒内收到的 mouse 事件视为笔的模拟，直接丢。
3. **笔不参与平移**：只有 `pointerType==='mouse'` 才能触发中键/空格平移，笔侧键再也拖不走画布。
4. **笔侧键（button 2/5）不绘制**：`ev.button !== 0` 直接返回。
5. **坐标取自事件本身**：`toWorld(clientX - rect.left, ...)`，不用 `stage.getPointerPosition()`
   —— 后者是「最后一次任何设备」的共享状态，混设备时必然取错。
6. **窗口失焦复位**：`blur` 时清掉 `spaceDown`。
7. **补齐收尾**：`pointercancel`、画布外松手（window 级 pointerup 兜底）、`pointerleave` 时
   buttons 为 0，都会走 `finishPointer`，避免笔画卡在「未提交」状态把后续落笔全挡掉。
8. **掌托抑制**：笔刚用过 1.5 秒内的 touch 事件丢弃。
9. **合并采样**：`getCoalescedEvents()` 把一次 move 里的多个采样点全部追加，快速运笔不再是折线。

回归验证：`scripts/pen-e2e.cjs` 的第三笔会在绘制途中插入 11 次鼠标移动 + 1 次鼠标抬起，
笔迹必须仍是干净的水平线；若被拽到右下角或中断，说明隔离失效。

### 13-8 笔输入诊断面板（Ctrl+Shift+D）

数位板问题（压感为 0、笔迹乱飞、一笔断成几段）几乎都是驱动上报方式导致的，
换台机器复现不出来。为了不再靠猜，白板内置一个诊断面板：

- 白板里按 **Ctrl + Shift + D** 打开/关闭
- 实时显示最近 12 个指针事件：相对时间、阶段、`pointerType`、`pointerId`、`button`、`pressure`、屏幕坐标
- 笔事件显示为蓝色，被规则丢弃的事件显示为橙色并带原因
- 底部汇总「被哪条规则丢弃了几次」（笔活动期间的鼠标模拟 / 非当前指针 / 掌托触摸 / 非左键 / 悬停）

判断方法：

| 现象 | 说明 |
|---|---|
| 表格里 `类型` 一直是 `mouse`，没有 `pen` | 驱动没走 Windows Ink，压感不可能有值（去驱动面板勾选 Windows Ink） |
| 有 `pen` 行但 `压感` 恒为 0.50 或 0.00 | 驱动没把压力值传上来（换新版驱动 / 检查笔尖压力曲线设置） |
| `非当前指针` 计数持续增长 | 有第二个输入源在抢（多为笔的鼠标模拟），已自动丢弃，属正常 |
| `笔活动期间的鼠标模拟` 计数增长 | 同上，说明驱动确实双报，隔离规则在起作用 |

实现：`wb/penDebug.ts`（零开销的采集开关）+ `wb/PenDebugHud.tsx`（面板），
打点在 `Whiteboard.tsx` 的各条输入规则处。默认关闭，不影响正常使用。

### 13-9 客户端 502 的排查结论（1.1.3）

现象：客户端弹「请求失败（502）」。

排查过程与结论：

1. `curl` 打 `http://<PROD_SERVER_IP>:9999/healthz` 和 `:80/healthz` 都是 200，`systemctl status classroom`
   显示服务连续运行、内存 88M/800M，**服务没挂**。
2. `journalctl -u classroom` 里那段时间**没有任何请求记录** —— 说明请求根本没到 Fastify。
3. nginx 全局 `error_log ... crit;`，502 属于 error 级，**根本没被记录**，所以一开始查不到证据。

真正常见的原因是**本机代理**：Chromium 默认读系统代理，用户开着 Clash/v2ray 时，
发往服务器 IP 的请求会被塞进代理，代理连不上上游就回一个 HTML 的 502 —— 服务端日志里一条都没有。

因此 1.1.3 做了两件事：

- `app.commandLine.appendSwitch('no-proxy-server')`：客户端只连自己那台服务器，一律直连。
- 5xx 且响应体不是 JSON 时给出可执行提示（关代理 / 浏览器打开 `/healthz` 自检），
  不再只显示「请求失败（502）」。

同时在服务器上给这个 vhost 单独开了日志（原来跟着全局走 crit，等于没有）：

```nginx
access_log /www/wwwlogs/classroom.log;
error_log  /www/wwwlogs/classroom.error.log warn;
```

下次再有 502，直接看 `classroom.error.log` 就能区分「nginx 连不上上游」和「请求没到这台机器」。

**注意**：部署重启服务的那 1~2 秒内，请求必然 502。`deploy-push.sh` 目前是停机重启，
以后要消除这段窗口可以改成先起新进程再切 nginx upstream。

---

## 14. ClassIn 教学管理扩展（2026-10-28）

这一节是当前版本新增能力的交接说明。**媒体层没有变**：仍是 1 老师 + 4 学生 Mesh；
新增的是账号/角色、课程与课节、教学资源、作业通知、管理后台和课堂互动，以及围绕这些模块的权限模型。

### 14-1 角色与「按房间」判定教学权限

全局角色 `admin / teacher / assistant / student` 只决定账号能力；**课堂内的教学权限按房间算**：

```ts
// packages/server/src/realtime/handlers/room.ts · handleJoin
const isCourseManager = courseId
  ? await deps.repos.courses.isManager(courseId, user.id, isAdminUser)
  : false;
const isRoomStaff = isAdminUser || isHost || isCourseManager;
```

- `isRoomStaff = true`：房主、平台管理员、本课程的授课老师或课程助教（`course_members.member_role = 'assistant'`）。
- **其他老师凭入会码进别人的临时课堂时 `isStaff = false`**：能看能听，但不能全员静音、移人、发起计时/答题/签到、发公告或私聊学生。
- 正式课节仍要求是课程成员（老师/助教/学生）或管理员；学生开课前 15 分钟才能进，staff 可提前进。
- 客户端用 `ParticipantDTO.isStaff` 决定学生列表里的管控按钮；服务端每个控制事件都会重新查房态，不能只信客户端。

这条规则是审查后专门补的：如果按全局 `role === 'teacher'` 放权，任何自助注册的老师都能凭 6 位码接管别人的课堂。

### 14-2 新增数据表（迁移 `002_teaching_platform.sql`）

| 表 | 用途 |
|---|---|
| `courses` | 课程（老师、封面、归档位） |
| `course_members` | 课程成员与 `student/assistant` 角色；授课老师来自 `courses.teacher_id` |
| `lessons` | 课节，绑定唯一 `room_id`；状态 `scheduled/ended/cancelled` |
| `courseware` | 课程课件库（文件、标题、MIME、大小） |
| `questions` | 题库（单选/多选/判断、选项 JSON、答案 JSON、解析） |
| `assignments` / `assignment_submissions` / `submission_files` | 作业、提交/批改、附件 |
| `notifications` | 站内通知（课程邀请、作业、课节变更等） |
| `room_activities` | 课堂互动流水（公告、奖励、答题、计时、签到、控制等） |
| `room_signins` | 签到记录 |

`users` 增加 `phone`/`bio` 并扩容角色 CHECK；`messages` 增加 `to_user_id` 支持私聊；`files` 增加 `course_id`/`purpose`。

### 14-3 服务端接口（前缀 `/api/v1`）

| 模块 | 接口 |
|---|---|
| 账号 | `POST /auth/register|login|refresh|logout`；`GET/PATCH /auth/me`；`POST /auth/password` |
| 课程 | `GET/POST /courses`；`GET/PATCH/DELETE /courses/:id`；`POST /courses/:id/members`、`DELETE /courses/:id/members/:userId` |
| 课件/题库 | `POST/DELETE /courses/:id/courseware`；`GET/POST/DELETE /courses/:id/questions` |
| 课节 | `GET /lessons`、`GET /lessons/history`、`GET/PATCH /lessons/:id`、`POST /lessons/:id/enter|cancel`；`GET/POST /courses/:id/lessons` |
| 作业 | `GET /assignments`、`GET /assignments/:id`、`POST /assignments/:id/submit`、`POST /assignments/:id/grade/:submissionId`、`DELETE /assignments/:id`；`GET/POST /courses/:id/assignments` |
| 通知 | `GET /notifications`、`GET /notifications/unread_count`、`POST /notifications/:id/read`、`POST /notifications/read_all` |
| 管理 | `GET /admin/overview`、`GET /admin/users`、`PATCH /admin/users/:id/role` |
| 课堂记录 | `GET /rooms/:id/report` |

关键约束：

- 课节创建/修改在 `BEGIN IMMEDIATE` 里先查老师时间冲突再写入，避免并发双写。
- 课节取消、`PATCH status=cancelled` 和课堂内 `room:end` 都走 `roomService.end` 的统一收尾（房间状态、参与记录、runtime、`room:ended` 广播、lesson 状态）。
- 已批改作业禁止重交；重交只更新内容和提交时间，保留成绩/评语。
- 作业附件签名 URL 只允许提交者本人或课程管理者获取。
- 管理员降级在 `BEGIN IMMEDIATE` 中重读角色，最后一个管理员不能被降级。

### 14-4 Socket 事件（新增）

除原有白板/RTC/聊天/控制外：

| 事件 | 方向 | 作用 |
|---|---|---|
| `room:announce` | C→S→C | 发布公告（全房状态） |
| `room:award` | C→S→C | 小红花/奖杯，累计到 `room_activities` |
| `room:random_pick` | C→S→C | 只从学生中随机点名 |
| `quiz:start / quiz:answer / quiz:end` | C↔S | 答题卡与结果；学生只看到自己的答案，staff 看逐人明细 |
| `timer:start / timer:stop` | C↔S | 倒计时/正计时，权威状态广播 |
| `signin:start / signin:mark / signin:end` | C↔S | 签到；学生侧不暴露其他学生名单 |
| `chat:send { toUserId? }` | C↔S | 私聊；非 staff 给其他学生发私聊会被拒 |
| `room:ended` | S→C | 结课广播，客户端退出课堂 |

`RoomRuntime` 新增 `allMuted / announcement / timer / quiz / signin / rewards / forceMuted / forceCameraOff`。
互动流水落库，公告与奖励在房间重载时恢复；计时、答题、签到属于课堂进行态，不跨重启恢复。

### 14-5 前端页面

| 页面 | 文件 |
|---|---|
| 工作台 | `pages/workbench/DashboardPage.tsx` |
| 课程列表/详情 | `CoursesPage.tsx`、`CourseDetailPage.tsx` |
| 课表与历史 | `SchedulePage.tsx` |
| 作业（学生提交/老师批改） | `AssignmentsPage.tsx` |
| 通知 | `NotificationsPage.tsx` |
| 个人中心/改密 | `ProfilePage.tsx` |
| 管理后台 | `AdminPage.tsx` |
| 我的课堂（临时课堂） | `ClassroomsPage.tsx` |
| 课堂互动面板/答题/成员 | `room/InteractionPanel.tsx`、`QuizOverlay.tsx`、`ParticipantList.tsx` |
| 课堂记录 | `components/RoomReportModal.tsx` |

工作台入口在 `WorkbenchPage.tsx` + `store/nav.ts`。管理员入口只对 `admin` 显示；助教按课程成员身份获得课堂管控。

### 14-6 验证与已知边界

本轮实际跑过：

```bash
npm run typecheck                              # 4/4 workspace
npm run test:unit                              # 26/26
npm test                                       # 40/40 核心冒烟
node scripts/platform-smoke.mjs                # 88/88 平台冒烟（含房间级 staff 权限）
npm run build -w @classroom/desktop            # 通过
npm run capture                                # 23 张端到端截图
```

截图已归档在 `docs/screenshots/2026-10-28/`。

`platform-smoke` 覆盖了课程/课节冲突、花名册、课件与作业权限、通知、管理后台、答题/计时/签到/奖励/私聊、课堂结束与落库，以及“全局老师凭码旁听不能拿到教学权限”。

**没有实现、不要误以为有**：

- 云端录制、回放、白板回放；课堂记录只是数据库统计。
- 分组讨论、投票、在线考试、家长端、机构/部门层级、批量账号导入。
- 短信/微信登录与通知（仅站内）。
- iOS 客户端与应用商店上架；Android 已实现，见 §15。
- SFU/千人课堂；媒体仍是 5 人 Mesh。
- 水印、内容审核。

`room:end` 与课节取消是统一收尾，但**不是录制停止**（没有录制）。`RoomReportDTO` 的时长来自 `rooms.started_at/ended_at` 与参与记录，断线重进会累加，不是简单相减。

---

## 15. 全平台客户端：Android + Windows/macOS 打包（2026-10-28）

### 15-1 方案：复用一套渲染层，不写第二套 UI

Android 端没有另起 React Native/Flutter，直接用 **Capacitor 7** 包住 desktop 的 React 渲染层：

```
apps/desktop/src/renderer  ──vite build（vite.web.config.ts）──▶  apps/mobile/www  ──cap sync──▶  android/app/src/main/assets/public
```

- 共享页面、store、白板、WebRTC 逻辑；差异集中在 4 个文件：
  `lib/config.ts`（服务器地址）、`store/session.ts`（refresh 持久化）、`lib/native.ts`（Capacitor 桥接）、
  `main.tsx`（平台 dataset + 状态栏初始化）。
- 平台判定：`runtime.isElectron / isAndroid`；CSS 用 `@media (max-width: 860px)` 做移动布局，
  桌面端完全不受影响。
- 移动 UI：顶部栏（菜单/标题/通知）、抽屉式侧栏、底部 5 项导航（工作台/课堂/课程/作业/我的）；
  课堂侧栏变成底部抽屉（成员/聊天/互动），顶部保留人数/聊天/视频/白板/课件/离开；
  屏幕共享按钮在非 Electron 端不渲染（`ControlBar` 的 `canShare`）。

### 15-2 Android 关键实现

| 点 | 实现 |
|---|---|
| 媒体权限 | `MediaPermissionsPlugin.java` 主动申请 CAMERA/RECORD_AUDIO；`DeviceCheck` 与 `store/room.ts` 在 getUserMedia 前调用；Capacitor 的 BridgeWebChromeClient 兜底 |
| 自动播放 | `MainActivity` 设置 `setMediaPlaybackRequiresUserGesture(false)` |
| 明文局域网 | `androidScheme: 'https'` 保证安全上下文；`cleartext + allowMixedContent + usesCleartextTraffic` 允许 http API |
| 服务器地址 | 登录页可编辑，存 `localStorage`；模拟器默认 `http://10.0.2.2:8080` |
| 状态栏 | `@capacitor/status-bar`，白色背景 + 深色图标（`LIGHT`） |
| edge-to-edge | Android 15 targetSdk 35 强制边到边；`android.adjustMarginsForEdgeToEdge: 'force'` 把 WebView 收进系统栏 |
| 登录态 | refresh 在 Electron 用 safeStorage；Android 回退 localStorage，杀进程重开仍登录 |

CSS 修复（本轮验证时发现并修掉）：

- 底部导航/控制栏被 Android 手势条压住 → edge-to-edge margins + `max(14px, env(...))` 安全区。
- 单人/双人视频被 2 列网格挤成细长条 → 移动端 `:has(> :only-child)` / 2 人时单列铺满。
- 教室内的弹窗白底白字（继承 `.room` 浅色文字）+ 内联 width=620 溢出手机 → `.modal { color: var(--text); max-width: calc(100vw - 16px) }`。

### 15-3 构建与签名

完整命令见 `docs/build.md` 第 4 节。最短路径：

```bash
npm run build:web -w @classroom/desktop
cd apps/mobile && npx cap sync android && cd android
JAVA_HOME=<jdk21> ./gradlew assembleRelease
```

签名环境变量：`CLASSROOM_KEYSTORE / CLASSROOM_KEYSTORE_PASSWORD / CLASSROOM_KEY_ALIAS / CLASSROOM_KEY_PASSWORD`。
不设置时 release 为未签名包，debug 可直接安装。**keystore 不进仓库**；本机验证用的在
`~/.classroom-toolchain/classroom-release.jks`，升级安装必须用同一份签名。

### 15-4 已验证路径（API 35 模拟器）

1. 安装签名 release APK → 启动 → 登录教师账号 → 杀进程重开，仍保持登录
2. 工作台移动布局、顶部栏、底部导航、通知抽屉（`docs/screenshots/android/`）
3. 课堂 → 输入 6 位入会码 → 系统相机/麦克风授权 → 本地视频预览 + 麦克风开启
4. 成员/聊天/互动底部抽屉；白板落笔；课件弹窗；「下课」→ 课堂列表状态变「已结束」→「查看记录」
5. 手势条不再遮挡底部导航；单人视频铺满宽度；弹窗文字/宽度正常

### 15-5 已知边界（不要误以为有）

- **只在模拟器验证**：相机是虚拟场景，未在真机验证采集/权限弹窗/性能；真机需在登录页改成电脑局域网 IP。
- **Android 不能发起屏幕共享**：按钮隐藏，只能接收桌面端的共享。
- **没有 iOS 客户端、没有上架任何应用商店。**
- **Windows 产物未在真实 Windows 启动**：本轮只在 macOS 交叉构建了 x64 免安装 zip；NSIS 安装器需要 Wine/Windows。
- **macOS x64 未在 Intel 真机启动**：arm64 已本机启动；x64 仅完成构建。
- 移动端网络切换（Wi-Fi↔4G）没有做自动重连策略；WebView 被系统回收后需重新进入课堂。
- Android WebView 的 `getUserMedia` 行为受厂商 ROM 影响，个别机型需要在系统设置里手动给相机/麦克风权限。

### 15-6 排错入口

| 现象 | 先看 |
|---|---|
| 登录 `Failed to fetch` | 登录页服务器地址、电脑防火墙 8080、模拟器用 10.0.2.2 |
| 装包报签名冲突 | 用同一 keystore，或先 `adb uninstall com.hcf.classroom` |
| 底部被手势条挡住 | 确认 `adjustMarginsForEdgeToEdge: 'force'` 且 APK 已重建 |
| 相机黑屏 | 系统权限、Capacitor 日志 `adb logcat | grep -i chrom` |
| 页面白屏 | `www` 是否重新 `build:web` + `cap sync`；`adb logcat` 看 WebView 报错 |

---

## 16. 腾讯云课堂（LCIC）并列入口（2026-10-28，临时）

> 完整说明、字段约束、下线清单见 [`lcic.md`](lcic.md)。这里只记交接要点。

- **定位**：课程详情页新增「进入腾讯课堂」按钮，用系统浏览器打开腾讯云实时互动-教育版（LCIC）课堂。
  自建课堂、课程/课节/作业/白板/考勤全部不动。LCIC 已公告 2026-10-30 起停止新购，随时可能下线。
- **开关**：`LCIC_ENABLED` + `LCIC_SDK_APP_ID` / `LCIC_SECRET_ID` / `LCIC_SECRET_KEY`。
  凭据为空或显式 `false` 时按钮不显示、`POST /api/v1/lcic/courses/:id/launch` 返回 503。密钥只放环境变量。
- **服务端**：`services/lcicClient.ts`（自实现 TC3 签名，零 SDK 依赖）、`services/lcicService.ts`（用户/房间映射、
  token 缓存、并发去重）、`routes/lcic.ts`；迁移 `003_lcic.sql` 只建 `lcic_users` / `lcic_rooms` 两张映射表。
- **前端**：`CourseDetailPage.tsx` 拉 `/lcic/status`，桌面端调用 `window.desktop.openExternal`，浏览器端新标签。
  Electron 内嵌页面跑不起腾讯 TRTC SDK，必须走系统浏览器；CSP 未改。
- **腾讯硬限制**：`StartTime` 必须晚于当前时间（代码 +5s）；房间最长 24h；`RegisterUser` 只能传 `OriginId`；
  token 7 天；助教/学生都按学生身份进入；`DeleteRoom`/`DeleteUser` 不传 `SdkAppId`。
- **验证**：`scripts/lcic-test.mts` 离线验证关闭行为，带凭据时真实注册/建房/二次进入并自动清理。
  已实测：老师两次 launch 复用同房同用户、学生进同房、非成员 404、URL 四参数完整；
  课程页按钮与 `openExternal` 调用已在 Electron 渲染层截图验收。
- **生产提醒**：当前入口是 HTTP，launch 响应含短期 token；正式使用前应切 HTTPS。**未在生产启用，也未部署。**
