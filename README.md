# ClassRoom — 在线互动教室

ClassIn 类在线教学平台：Windows / macOS 桌面客户端、Android 客户端、教学工作台与实时互动课堂。
当前媒体拓扑仍是 **1 位老师 + 4 位学生 Mesh 小班**，教学管理覆盖课程、课节、花名册、课件、题库、作业、通知与课堂互动。

- **桌面端**：Electron 45 + React 19 + Vite 8
- **Android**：Capacitor 7 复用同一套 React 渲染层，WebView 内 WebRTC 采集与播放
- **Web**：同一渲染层可构建为静态站点（`apps/mobile/www`）
- **服务端**：Fastify 5 + Socket.IO 4 + SQLite（Node 内置 `node:sqlite`，WAL）
- **音视频**：原生 WebRTC Mesh + 自建 coturn 中继（不依赖第三方云）
- **白板**：Konva（命令式渲染，非 react-konva），自研元素模型 + 服务端权威 op 广播
- **手写**：数位板压感（Windows Ink / 高漫、Wacom 等），笔迹粗细随力度变化

> **接手开发请先读 [`docs/HANDOFF.md`](docs/HANDOFF.md)** —— 技术栈、目录结构、怎么跑、
> 关键设计决策、踩过的坑都在里面，读完不需要任何历史上下文。
> 本轮代码审计与修复清单见 [`docs/AUDIT.md`](docs/AUDIT.md)；对标 ClassIn 的分阶段方案见
> [`docs/CLASSIN-ROADMAP.md`](docs/CLASSIN-ROADMAP.md)。
> 打包与分发看 [`docs/build.md`](docs/build.md)。

## 已上线

| | |
|---|---|
| 服务端 | **http://<PROD_SERVER_IP>:9999** （`GET /healthz`） |
| 版本 | 1.1.3（2026-10-28 已部署教学管理扩展） |
| 部署方式 | nginx(80 / 9999) → Fastify(127.0.0.1:8090) → SQLite + coturn |
| 详细说明 | [`docs/deploy.md`](docs/deploy.md) |

> 公网实例已升级到本轮版本：课程/课节/课件/题库/作业/通知/管理后台/课堂互动均已上线，
> CORS 覆盖桌面 `file://`/`null` 与 Android `https://localhost`/`capacitor://localhost`，单文件上传上限 50MB。
> **交付的客户端仍默认连本机 `http://localhost:8080`**，验收时先在登录页「服务器」里改成
> `http://<PROD_SERVER_IP>:9999`；开发态也可用 `CLASSROOM_SERVER_URL=...` 覆盖。

客户端连公网服务器：

```bash
CLASSROOM_SERVER_URL=http://<PROD_SERVER_IP>:9999 npm run dev
# 或
npm run dev:remote
```

---

## 功能范围（2026-10-28）

### 已实现

| 模块 | 能力 |
|---|---|
| 账号与角色 | 邮箱/手机号 + 密码登录、教师/学生注册、刷新令牌轮换、个人资料与改密、管理员/教师/助教/学生四种角色、管理员改角色并保护最后一个管理员 |
| 课程 | 创建/编辑课程，按角色可见；成员按邮箱添加，支持学生与课程助教；课程详情聚合课节、花名册、课件库、题库与作业 |
| 课节与排课 | 排课/调整/取消课节，自动检测老师时间冲突；课节绑定独立教室；学生开课前 15 分钟可进，老师与助教可提前进入；历史课节可看课堂记录 |
| 课件与题库 | 上传 PDF/Office/图片/音视频课件；课堂内把 PDF 或图片插入白板；题库支持单选、多选、判断与解析，课堂答题卡可直接引用 |
| 作业 | 布置作业、学生提交/重交（已批改后禁止重交）、老师批改评分与评语、附件上传与签名下载 |
| 通知 | 课程邀请、作业提交/批改、课节调整/取消等站内通知，未读数与全部已读 |
| 工作台 | 工作台总览、我的课堂（临时课堂）、课程、课表、作业、通知、个人中心、设备自检、管理后台 |
| 课堂互动 | 服务端权威的全员静音、公告、计时器、签到、答题（含结果与逐人作答）、随机点名、奖励、举手队列、上讲台/下台、私聊与公聊 |
| 课堂权限 | 按“房间”判定教学权限：房主、管理员、课程授课老师或课程助教才是 staff；其他老师凭入会码进房只能旁听，不能静音全员、发起计时或私聊学生 |
| 课堂记录 | 课堂时长、参与人数、每人进出时间与累计在线时长、聊天数、白板页数与元素数；学生只能看自己的记录 |
| 音视频与白板 | WebRTC Mesh、屏幕共享、设备自检、协同白板（画笔/荧光笔/橡皮/形状/文本/撤销/锁定/翻页/PDF/图片课件）、课堂内聊天 |
| 客户端平台 | Windows / macOS 桌面端；Android APK；Web 静态构建。移动端有独立顶部栏、底部导航、抽屉式侧栏与课堂面板、原生相机/麦克风授权、可编辑服务器地址 |

### 明确未实现

- **云端录制、回放与白板回放**：没有录制服务、对象存储或录制文件时间轴；“课堂记录”是数据统计，不是录播。
- **分组讨论、投票、在线考试、家长端、机构/部门层级、批量导入账号、机构级课件库/题库共享**。
- **短信/微信登录与通知**：登录仅邮箱/手机号 + 密码，通知仅站内。
- **iOS 客户端与应用商店上架**：只有 Windows / macOS / Android 安装包，未签名上架任何商店。
- **Android 屏幕共享**：移动端主动隐藏共享按钮，仅桌面端可共享；Android 只做接收端。
- **SFU / 大班课 / 千人同房**：媒体仍是 Mesh，单房上限 5 人；不能通过调大 `MAX_PARTICIPANTS` 支撑大班。
- **水印、内容审核、云端房间权限策略**：只有入会码、JWT scope、签名文件 URL 与房间级 staff 校验。

本轮 23 张端到端验收截图未包含在本仓库中（截图可能暴露服务器地址与真实课堂内容，已移除）。

---

## 快速开始

```bash
# 1. 依赖（Node ≥ 22）
npm install

# 2. 配置
cp .env.example .env
# 生产环境务必替换 JWT_SECRET：openssl rand -base64 48

# 3. 起服务端（另开一个终端）
npm run dev:server          # http://localhost:8080  →  GET /healthz

# 4. 起客户端
npm run dev                 # Electron 窗口
```

首次启动会请求摄像头/麦克风权限，macOS 需要在系统设置里允许。

> 服务端与冒烟脚本依赖 Node 内置 `node:sqlite`，需要 **Node ≥ 22**。如果本机 Node 只有 20，
> 可用 Electron 自带的 Node 跑测试：`ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke.mjs`。
> Android 打包与真机/模拟器验收步骤见 [`docs/build.md`](docs/build.md#4-android)。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 启动 Electron 客户端（含渲染进程热更新） |
| `npm run dev:server` | 启动服务端（tsx watch） |
| `npm run dev:all` | 同时启动两者 |
| `npm run typecheck` | 全仓库类型检查 |
| `npm run test:unit` | 单元回归（26 项，无需启动服务端） |
| `npm test` | 核心端到端冒烟（需先启动服务端，40 项断言） |
| `node scripts/platform-smoke.mjs` | 教学平台冒烟（88 项断言：课程/课节/作业/通知/管理/课堂互动与权限，需先启动服务端） |
| `npm run capture` | 启动 Electron 生成验收截图到 `/tmp/ui-verify`（需先启动服务端） |
| `npm run test:media` | 摄像头采集降级链单元测试（无需硬件） |
| `npm run dist:win` | 打 Windows 安装包到 `apps/desktop/dist/`（无 Wine 的 macOS 只能出 zip） |
| `npm run dist:mac` | 打 macOS dmg + zip，arm64 与 x64 各一份（需在 macOS 上跑） |
| `npm run build:web -w @classroom/desktop` | 构建 Web/Android 共用前端到 `apps/mobile/www/` |
| `npx cap sync android` | 把 Web 产物同步进 Android 工程（在 `apps/mobile` 下执行） |
| `./gradlew assembleRelease` | 打 Android release APK（签署环境变量见 `docs/build.md`） |

打包细节见 [`docs/build.md`](docs/build.md)。

## 排错

**`Electron uninstall`** —— electron 的二进制没下下来（国内网络常见）：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node node_modules/electron/install.js
```

**在受限环境里启动报 `sandbox initialization failed`** —— 这是外层沙箱拦住了 Chromium 的
OS 级沙箱，不是应用问题。在普通终端里不会出现；实在要绕过可加 `-- --no-sandbox`（仅限本地调试）。

**摄像头一片黑** —— 先看是不是被别的程序占用（腾讯会议 / 微信视频），macOS 上这会报
`NotReadableError`，应用会把它翻成人话提示。另外 `--no-sandbox` 启动时 macOS 的采集
可能只协商参数却不出帧，用正常方式启动即可。

**Windows 上摄像头打不开** —— Windows 不弹授权框，开关在系统设置里：
设置 → 隐私和安全性 → 相机 → 打开「允许桌面应用访问相机」（麦克风同理）。
关掉时 `getUserMedia` 直接抛 `NotAllowedError`；客户端会给出提示和一个「打开设置」按钮，
点它直接跳到该页面。装的是旧系统（Win10 1809 之前）还需要在「相机」里单独放开本应用。

**登录报 `Failed to fetch`** —— 基本都是 CORS 白名单没包含当前来源。检查 `.env` 里的
`ALLOWED_ORIGINS` 是否包含渲染进程的实际地址（开发态 `http://localhost:5273`，打包后 `null`）。

**数位板（高漫等）画出来没有粗细变化** —— 打开驱动面板，把工作模式从 WinTab / 鼠标模式改成
**Windows Ink**。Chromium 只认 Windows Ink 上报的 `pointerType='pen'` 与 `pressure`，
WinTab 模式下浏览器收到的就是普通鼠标事件，压感恒为固定值。改完重开驱动即可，不用重启应用。

**`ELECTRON_RUN_AS_NODE=1`** —— 这个环境变量会让 Electron 退化成纯 Node、不开窗口。
如果终端里存在该变量，启动前先 `unset ELECTRON_RUN_AS_NODE`。

## 目录结构

```
packages/shared       双端共用的协议类型、白板元素模型、几何/命中纯函数
packages/client-core  与框架无关的客户端逻辑（REST 客户端、socket、ICE）
packages/server       Fastify + Socket.IO + SQLite
apps/desktop          Electron 主进程 / preload / React 渲染进程（Web 构建入口也在这里）
apps/mobile           Capacitor Android 工程，复用 desktop 的渲染层产物
```

## 密码与令牌

| 令牌 | 有效期 | 存放位置 | 用途 |
|---|---|---|---|
| access | 15 分钟 | 渲染进程内存 | 调 REST |
| rtc | 2 小时 | 渲染进程内存 | socket 握手（避免 20 分钟课堂中途过期） |
| refresh | 7 天 | Electron `safeStorage`（Keychain 加密）；Android/Web 回退 `localStorage` | 换新 access |

不用 httpOnly cookie：打包后渲染进程 origin 是 `file://`，跨站带不上 cookie。
Android 的 `localStorage` 随应用数据保存，卸载或清除应用数据后需要重新登录。

## 当前进度

- [x] **阶段 0** 骨架与协议层 —— 类型检查全绿，`/healthz` 可用
- [x] **阶段 1** 账号体系 / 建房进房 / 本地摄像头 / 聊天 —— 端到端冒烟 40 项全过
- [x] **阶段 2** Mesh 音视频 / 屏幕共享 / 连接诊断 —— 三端 Mesh 40 项全过
- [x] **阶段 3** 协同白板 —— 三端收敛 31 项全过
- [x] **阶段 4** PDF 课件导入 + 课堂记录 —— 端到端通过
- [x] **阶段 5** 部署与打包 —— 服务端已上线；早期 0.1.0 出过 Windows 安装器，本轮 1.1.3 交付 Windows 免安装 zip，macOS dmg 见 `docs/build.md`
- [x] **阶段 6** Windows 客户端适配 —— 原生标题栏、NSIS 安装器、摄像头权限链路修正
- [x] **阶段 7** ClassIn 教学管理扩展（2026-10-28）—— 角色/资料、课程/课节/排课冲突、花名册与助教、课件库、题库、作业、通知、管理后台、课堂互动与房间级权限、课堂记录；`typecheck` 4/4、单元 26/26、核心冒烟 40/40、平台冒烟 88/88、桌面构建通过
- [x] **阶段 8** 全平台客户端（2026-10-28）—— Android（Capacitor 7）客户端、移动端响应式工作台/课堂/抽屉、原生相机麦克风授权、服务器地址编辑；Windows zip / macOS dmg+zip / Android APK 打包；Android 15 模拟器端到端通过，macOS 打包产物登录与重启会话恢复通过

### 已验证项

阶段 1：

- ✅ 注册/登录/登出、refresh 轮换与重放拒绝、access/rtc 令牌作用域隔离
- ✅ 建房拿 6 位码、凭码进房、免码重进、人数上限
- ✅ 名单实时同步、同一用户换连接踢旧连接、聊天实时送达并落库
- ✅ 屏幕共享房间级互斥、老师结束课堂、参与记录进出时间配对

阶段 2（`npm run test:rtc`，1 老师 + 2 学生真实建连）：

- ✅ 6 条 PeerConnection 全部 `connected`，每条恰好 3 条 m-line
- ✅ 双向音视频轨道到达（`audio:live` / `video:live`），首轮协商零碰撞
- ✅ 摄像头/麦克风开关经 presence 同步到对端
- ✅ 屏幕共享轨在远端出帧（`muted=false`），上行实测 157 kbps，停止后对端状态清空
- ✅ 诊断面板能读出 candidate 类型（本机 loopback 为 `host → host`）

阶段 3（`npm run test:wb`，三端同房）：

- ✅ 老师的一笔经服务端分配 order 后同步到三端，元素 id / rev / order 完全一致
- ✅ 两人并发追加不撞 z 序（`aV` / `aW` / `aX` 各不相同）
- ✅ 并发 patch 同一元素：只有一个生效，rev 只涨 1，三端收敛到同一值
- ✅ 落败方收到 `rev_conflict` 并就地回拉权威值
- ✅ 老师锁白板后学生的 op 被拒；老师不受影响
- ✅ 老师翻页、新建页全员跟随；新客户端进来拿到全量快照
- ✅ 白板内容按 2 秒 debounce 落库（实测 13 元素 / seq=13 完整写入）

阶段 8（Android 15 模拟器，Pixel 7 / API 35，签名 release APK）：

- ✅ 安装启动、登录 `android.teacher@test.dev`、杀进程重开后会话恢复
- ✅ 移动端工作台、顶部栏、底部导航、通知抽屉；Android 15 手势条不遮挡导航与课堂控制栏
- ✅ 课堂列表与 6 位入会码进房，相机/麦克风系统授权，摄像头预览与麦克风开启
- ✅ 成员/聊天/互动底部抽屉、白板落笔、课件弹窗、下课、课堂记录弹窗
- ✅ 移动端隐藏屏幕共享按钮，空间不足时视频铺满整行

### 未验证项

- ⚠️ **真实摄像头画面**：受限运行环境下 `getUserMedia` 能拿到 live 轨道并协商到
  1280×720@24fps，但不出帧（`videoWidth=0`）。自动化测试用 Chromium 合成摄像头跑通，
  真机画面需在正常桌面会话确认。Android 只验证了模拟器虚拟摄像头。
- ⚠️ **真实 Windows 主机**：Windows 产物已构建并通过压缩包结构检查，但当前没有
  Windows 运行环境，未实际双击安装/启动；首次验收请在 Windows 上完成安装与摄像头权限确认。
- ⚠️ **macOS Intel 真机**：x64 产物已构建，未在 Intel Mac 上启动；arm64 产物已本机启动验证。
- ⚠️ **真实屏幕采集**：本机没有「屏幕录制」权限，`desktopCapturer` 返回空列表。
  共享的传输通路用 canvas 流替代验证通过，选源弹窗与主进程 `setDisplayMediaRequestHandler`
  需在授权后实测。
- ⚠️ **跨公网连通性**：生产实例 `<PROD_SERVER_IP>` 已部署 coturn（`/healthz` 返回 `turn: configured`），
  强制 relay 的自测已通过；本地开发未配 TURN 时仍只靠 STUN 打洞，跨运营商/对称 NAT 需填
  `TURN_HOST` / `TURN_SECRET`，否则诊断面板会显示 `relay` 为 0。
- ⚠️ **白板删除不可撤销**：墓碑设计不允许同一个 id 复活，删除不进撤销栈。

### 已知限制

- 撤销/重做只覆盖「新增」和「修改」。删除是终态 —— 协议第 4 条明确禁止已删元素被改活，
  重做新增时会生成新的元素 id（内容一致，视觉等价）。
- 手写笔迹按 `pointerup` 提交，绘制过程中只有预览帧（不入 seq、不落库），
  这是 5 人 Mesh 下能跑顺的关键。

协议细节见 [`docs/protocol.md`](docs/protocol.md)。
