# ClassIn 对标功能体系与分阶段开发方案

> 版本：v1.1（2026-10-28）
> 基线：ClassRoom v1.1.3（1 老师 + 4 学生 Mesh 小班 MVP）+ 2026-10-28 教学管理扩展
> 目标：在保留现有白板/协议资产的前提下，分阶段补齐 ClassIn 的核心教学能力，最终支持 1v1、小班、大班、双师、录播回放、作业、考勤、互动工具和多端
> 配套文档：[`AUDIT.md`](AUDIT.md)（问题清单与复验）、[`HANDOFF.md`](HANDOFF.md)（现有实现细节，扩展范围见 §14）、[`protocol.md`](protocol.md)（白板协议）

---

## 0. 结论先行

### 0.1 三条硬结论

1. **当前代码不要推倒重写。** `packages/shared` 的白板元素模型/reducer、`packages/client-core` 的协议与 PeerManager、桌面端 UI 都可以继续用；需要替换的是“媒体拓扑”和“服务端形态”。
2. **大班课不是把 `MAX_PARTICIPANTS` 调大。** Mesh 5 人 → SFU 1+1000 观众，是媒体架构、房间策略、权限、广播、录制、计费的整体升级。
3. **“千人同房、人人双向 <300ms”不作为产品目标。** 可行的目标是：主讲/连麦 <300ms，1000 旁听通过 SFU 订阅 <500ms，或通过 LL-HLS 1~3s；1000 个发布者同时双向互动在端侧 CPU、上行带宽和 SFU 成本上都不经济。

### 0.2 推荐技术路线

| 层 | 选择 | 理由 |
|---|---|---|
| 媒体 SFU | **LiveKit（自建）** | Apache-2.0、Go、SFU/Simulcast/Dynacast、Egress 录制、Webhook、Redis 多节点、JS/React/RN/iOS/Android/Flutter SDK 齐全；比自研 mediasoup 省 3~6 个月 |
| 业务后端 | 继续 Fastify 模块化单体，逐步拆模块 | 当前团队规模不适合微服务；先按领域分模块，媒体/录制/分析独立部署 |
| 数据库 | PostgreSQL 16 + Drizzle/Kysely | 多实例、事务、分析、RLS；SQLite 保留为本地开发/单机部署选项 |
| 缓存/实时 | Redis 7（房间态、限流、Socket.IO adapter、Pub/Sub、分布式锁） | 无状态化必需 |
| 对象存储 | S3 / 阿里云 OSS / MinIO | 课件、作业、录制、头像；CDN 回源 |
| 队列 | BullMQ（Redis） | 课件转换、录制后处理、通知、报表 |
| 录制 | LiveKit Egress + ffmpeg | 房间合成、轨道录制、HLS/MP4；白板通过 Web 布局或事件回放合成 |
| 可观测 | OpenTelemetry + Prometheus + Grafana + Loki + Sentry | 指标/追踪/日志/错误四件套 |
| Web | React 19 + Vite + `livekit-client` | 复用现有 React 组件与 shared 模型 |
| 移动 | React Native + `@livekit/react-native` + Skia | 复用 TS 领域逻辑；Skia 渲染白板 |
| 桌面 | 继续 Electron，补 electron-updater/签名/公证 | 现有 Windows/macOS 资产不浪费 |
| 课件转换 | LibreOffice headless + pdfium/pdfjs | PPTX/DOCX → PDF → 页图；沙箱 worker |
| 身份 | 现有 JWT + OIDC/SAML（Keycloak 或 Auth0） | 机构 SSO、SCIM 可选 |

### 0.3 团队与周期假设

- 团队：1 产品/项目经理、2 后端（实时/媒体）、2 客户端（桌面/Web）、1 移动、1 媒体/SRE、1 QA/自动化、0.5 设计 ≈ 8.5 人
- 周期：约 44 周（10~11 个月）到“完整对标 + 规模化验收”
- 若只有 3~4 人：周期按 2.5~3 倍估算，优先砍掉大班/移动/机构化，先做 1+16 小班 + 录播 + 作业

### 0.4 落地状态（2026-10-28）

本表只描述**当前代码实际具备**的能力，不把方案当实现。详细接口/权限/测试见
[`HANDOFF.md`](HANDOFF.md) §14 与 [`AUDIT.md`](AUDIT.md) §9。

| 能力 | 状态 | 说明 |
|---|---|---|
| 账号/密码/手机号登录、四角色、资料/改密 | ✅ 已实现 | 邮箱或手机号作账号；无短信/微信登录 |
| 课程、课程成员、助教 | ✅ 已实现 | 成员按邮箱添加；无批量导入 |
| 课节排课/调整/取消、老师时间冲突 | ✅ 已实现 | 冲突检查与写入在同一事务 |
| 学生 15 分钟入场、老师/助教提前入场 | ✅ 已实现 | 正式课节要求课程成员；临时课堂凭码 |
| 课堂房间级教学权限（staff） | ✅ 已实现 | 全局老师旁听 ≠ 课堂教师 |
| 课件库、PDF/图片插入白板 | ✅ 已实现 | Office/音视频可上传预览；课堂内插页支持 PDF/图片 |
| 题库（单选/多选/判断） | ✅ 已实现 | 课堂答题卡可引用 |
| 作业提交/重交/批改/附件 | ✅ 已实现 | 已批改禁止重交；无截止时间延长 |
| 站内通知 | ✅ 已实现 | 无短信/微信推送 |
| 管理后台 | 🟡 部分 | 用户列表/搜索/角色、总览统计；无机构/部门层级、批量账号、账单 |
| 课堂互动 | 🟡 部分 | 举手、上讲台、静音、公告、计时、签到、答题、随机点名、奖励、私聊/公聊；无分组讨论、投票、抢答赛 |
| 课堂记录 | 🟡 部分 | 时长/参与/消息/白板统计；不是录播或学情分析 |
| 云端录制/回放/白板回放 | ❌ 未实现 | 无录制服务、对象存储、时间轴 |
| 分组讨论/在线考试/家长端 | ❌ 未实现 | — |
| 移动端/Web 客户端 | ❌ 未实现 | 仅 Electron |
| SFU/大班/千人 | ❌ 未实现 | 仍是 5 人 Mesh；不能靠调大人数上限解决 |
| 水印/内容审核/机构级安全策略 | ❌ 未实现 | 现有 JWT scope、签名 URL、房间 staff 校验 |

---

## 1. 产品目标、角色与课堂形态

### 1.1 角色

| 角色 | 能力 |
|---|---|
| 学生 | 进班、音视频、白板、聊天、答题、举手、提交作业、看回放、看自己的考勤 |
| 老师（主讲） | 建房/排课、管理课堂、共享屏幕、白板、锁板、答题卡、计时器、分组、布置/批改作业、看全班考勤与学情 |
| 助教/联席主持人 | 协助管理（静音、移人、审核举手、分组），可被授予白板/共享权限 |
| 机构管理员 | 校区/班级/师生/权限/课表/数据/账单 |
| 家长（可选） | 查看课表、考勤、作业、回放（只读） |

### 1.2 课堂形态

| 形态 | 规模 | 媒体模式 | 关键能力 |
|---|---|---|---|
| 1v1 | 2 人 | SFU（或 Mesh 保留） | 低延迟、白板、屏幕、录播 |
| 小班 | 1 老师 + 6~16 学生 | SFU，全员可发布 | 全员音视频、分组、答题、计时器、白板协作 |
| 大班/讲座 | 1~4 主讲 + 最多 1000 观众 | SFU，观众只订阅；连麦者临时授权发布 | 主讲/联席、举手排队、上台、聊天审核、答题、录播 |
| 双师 | 主讲 + 辅导老师 + 学生 | SFU | 联席主持人、分组巡场、辅导 |
| 录播课 | 无实时或少量直播 | 回放 | 录制、章节、白板同步、倍速、权限 |
| 巡课 | 管理员/教研 | 只订阅/旁听 | 不打扰课堂、看画面与白板、课后报告 |

### 1.3 产品边界

**做**：实时互动教室、白板、屏幕共享、举手连麦、大小班、作业、课件、考勤、录播、答题卡、计时器、分组、排课、机构权限、Web/移动端、通知、学情。

**暂不做/后置**：课程商城、支付/订单、教师主页、内容社区、AI 自动批改（可后置）、VR/3D 教室、复杂动画课件编辑器、跨机构社交。

---

## 2. ClassIn 功能矩阵与实现路径

> 优先级：P0 = 小班商用必需；P1 = ClassIn 核心对标；P2 = 增强/生态。
> 阶段对应第 4 节 Roadmap。
>
> **注意**：本节表格是 2026-10-27 基线时的差距分析，“当前”列中的“无”并不都仍成立
> （例如作业、答题卡、计时器、公告、奖励、课程与排课已实现）。当前真实状态以
> **§0.4 落地状态** 为准；未实现边界见 [`HANDOFF.md`](HANDOFF.md) §14-6。

### 2.1 实时音视频教室

| 能力 | ClassIn 体验 | 当前 | 差距 | 实现路径 | 阶段 | 验收 |
|---|---|---|---|---|---|---|
| 多人音视频 | 全员低延迟音视频、主讲大画面 | Mesh 1+4 | 5 人上限；无 SFU | LiveKit 房间；发布/订阅权限；Simulcast 180/360/720p；Dynacast；音频 Opus DTX/RED | P2 | 1+16 p95 <300ms；1000 观众 <500ms |
| 设备选择 | 摄像头/麦克风/扬声器可选 | 有采集降级链，无设备面板 | 无枚举/切换/测试 | `enumerateDevices` + 设备选择 + 麦克风电平测试 + 扬声器测试 | P1 | 切换 <2s，不打断课堂 |
| 音频处理 | 回声消除/降噪/自动增益 | 浏览器默认 | 无开关/无降噪强度 | LiveKit `AudioPresets` + 浏览器约束；可选 RNNoise/Krisp | P1 | 双讲无回声；CPU <10% |
| 视频布局 | 演讲者/网格/全屏/悬浮 | 网格 + 主讲共享布局 | 无自动跟焦/分页 | LiveKit active speaker + 网格分页 + 布局记忆 | P1 | 16 人网格 60fps |
| 网络适应 | 弱网降级、音频优先 | ICE restart/码率自适应 | 无音频优先/SVC | Simulcast + `adaptiveStream` + `dynacast`；音频优先；断线重连 | P2 | 30% 丢包下音频可懂、视频降级 |
| 连接诊断 | 网络质量/延迟/丢包 | 有诊断面板 | 无服务端指标 | 客户端 WebRTC stats + 服务端 TURN/SFU 指标 + 一键诊断报告 | P1 | 可定位 relay/丢包/带宽 |
| 课堂管理 | 全员静音、移人、锁定、等待室 | 无 | 权限过弱 | RoomPolicy + LiveKit `MutePublishedTrack`/`RemoveParticipant`/`canPublish` | P1 | 服务端强制，学生无法绕过 |
| 主持人/联席 | 主讲 + 助教 + 巡课 | 只有 hostId | 无角色分层 | `room_members.role` + 权限矩阵 + 邀请 | P2 | 助教可管理但不能结束课堂 |
| 主动说话 | 自动高亮/语音激励 | 无 | 无 | LiveKit active speakers + UI | P2 | 200ms 内高亮 |
| 虚拟背景/美颜 | 可选 | 无 | 无 | MediaPipe/浏览器 BackgroundBlur；后置 | P3 | 不影响帧率 |

### 2.2 电子白板协作

| 能力 | ClassIn 体验 | 当前 | 差距 | 实现路径 | 阶段 | 验收 |
|---|---|---|---|---|---|---|
| 多页白板 | 多页、缩略图、增删排序 | 有，50 页上限 | 无缩略图/复制页 | 页缩略图 + 复制/排序 + 页背景 | P1 | 50 页切换 <100ms |
| 画笔/荧光笔/橡皮 | 压感、粗细、颜色 | 有压感、对象橡皮 | 无像素橡皮/橡皮预览 | 保留对象橡皮 + 增加像素橡皮（可选） | P2 | 笔迹 60fps，压感不丢 |
| 形状/文本 | 矩形/圆/箭头/直线/文本 | 有基础形状/文本 | 无填充/富文本/对齐 | Konva 属性扩展 + 选中框 + 对齐/分布 | P1 | 文本编辑不丢焦点 |
| 图片 | 插入图片、裁剪、缩放 | 协议支持 image，UI 未接入 | 无图片工具 | 复用现有上传 API + `imageCache` + 图片工具 | P1 | 5MB 图片 <2s 上屏 |
| 课件 | PPT/PDF/图片/视频导入 | PDF 导入 | 无 PPTX/DOCX/视频 | 服务端 LibreOffice → PDF → 页图；视频单独轨道 | P2 | 100MB PPTX <2min 转完 |
| 协作权限 | 老师锁板/授权学生 | 有锁板 | 无按人授权/区域锁 | 权限矩阵 + 页级/工具级授权 | P2 | 服务端拒绝越权 |
| 撤销/重做 | 支持删除撤销 | 新增/修改可撤销，删除不可 | 删除墓碑是终态 | 改为“可撤销删除”：保留墓碑但允许同 id 恢复，或重做生成新 id | P2 | 10 步撤销/重做收敛 |
| 激光笔/光标 | 有 | 有光标/激光 | 无轨迹淡出 | Konva 动画层 + 200ms 淡出 | P2 | 不增加 op 数量 |
| 教学工具 | 尺规/三角板/量角器/圆规 | 无 | 无 | 独立 overlay 工具层，坐标与白板一致 | P2 | 工具不写入文档 |
| 学科工具 | 公式/化学/音乐/地图 | 无 | 无 | KaTeX、周期表、五线谱等按学科插件化 | P3 | 按需加载 |
| 导出 | 导出 PNG/PDF | 无 | 无 | 客户端 canvas 导出 + 服务端渲染 | P2 | 50 页 PDF <10s |
| 白板同步 | 低延迟、不丢笔 | 服务端权威 op | 全量 sync 2MB 风险；无压缩 | 分块快照 + op log + 50ms 批量合并 + 压缩 | P2 | 1000 观众 <500ms |
| 白板持久化 | 断线恢复 | 2s 全量落库 | 无 op log/压缩 | 快照 + op log + 定期压缩；大文档 S3 | P2 | 崩溃丢 <2s；恢复 <3s |

### 2.3 屏幕共享与连麦

| 能力 | ClassIn 体验 | 当前 | 差距 | 实现路径 | 阶段 | 验收 |
|---|---|---|---|---|---|---|
| 屏幕/窗口共享 | 选屏/选窗口/区域 | 有选源 | 无区域选择 | Electron `desktopCapturer` + `getDisplayMedia` 约束；Web 用浏览器选择器 | P1 | 1080p30 稳定 |
| 系统声音 | Windows/macOS 共享音频 | `audio:false` | 无系统声音 | Electron loopback/系统音频；LiveKit 音频轨混入 | P2 | 音画同步 <100ms |
| 多人共享 | 老师授权多人 | 房间级互斥 | 只能一人 | 共享席位 + 权限 + 布局 | P2 | 2~4 人共享不爆带宽 |
| 共享批注 | 在共享画面上批注 | 无 | 无 | 透明 overlay 白板层，坐标系映射 | P2 | 批注与画面同步 |
| 共享质量 | 流畅/高清切换 | 固定 15fps/1~2.5Mbps | 无档位 | Simulcast + 手动档位 + 自动降级 | P2 | 切换 <1s |
| 举手 | 举手队列/老师批准 | 仅状态 | 无队列/审批 | 服务端 `hand_queue` + 审批 + 上台 | P1 | 队列一致、重连恢复 |
| 上台连麦 | 学生临时发布 | 学生本就可发布 | 无“上台”概念 | `stage` + LiveKit token 重新授权发布 | P1 | 未上台无法发布 |
| 发言计时 | 连麦倒计时/提醒 | 无 | 无 | 服务端 timer + 事件 | P2 | 到点自动收回 |

### 2.4 课堂互动工具

| 能力 | ClassIn 体验 | 当前 | 差距 | 实现路径 | 阶段 | 验收 |
|---|---|---|---|---|---|---|
| 答题卡/随堂测 | 单选/多选/判断/填空/简答、实时统计 | 无 | 无 | 题库 + 题目状态机 + 答案聚合 + 统计图 | P2 | 1000 答案 <3s |
| 计时器 | 开始/暂停/延长/结束 | 无 | 无 | 服务端权威 `endsAt` + 广播 + 重连恢复 | P1 | 端间漂移 <200ms |
| 分组讨论 | 自动/手动分组、巡场、广播 | 无 | 无 | 子 LiveKit 房间 + 分组编排 + 老师巡场 + 倒计时 | P2 | 移动 <3s，回主班 <3s |
| 随机选人 | 随机/避免重复 | 无 | 无 | 服务端随机 + 历史记录 | P1 | 公平、可复现 |
| 抢答/奖励 | 抢答器、积分 | 无 | 无 | 事件 + 积分账本 | P2 | 防重复、可撤销 |
| 投票 | 匿名/实名、多选 | 无 | 无 | 复用答题卡状态机 | P2 | 实时统计 |
| 课堂公告 | 置顶公告 | 无 | 无 | 消息类型 + 置顶 | P1 | 全员可见 |
| 小黑板 | 学生本地小白板 | 无 | 无 | 复用 WhiteboardClient 子实例 | P2 | 不污染主白板 |
| 云盘 | 课堂文件共享 | 只有课件背景 | 无课堂文件区 | 对象存储 + 权限 + 列表 | P1 | 上传/下载/预览 |
| 浏览器 | 内置浏览器/网页 | 无 | 无 | Electron webview/外部浏览器；Web iframe 白名单 | P3 | 安全隔离 |

### 2.5 教学管理与作业

| 能力 | ClassIn 体验 | 当前 | 差距 | 实现路径 | 阶段 | 验收 |
|---|---|---|---|---|---|---|
| 课程/班级 | 课程、班级、学生名册 | 只有单次房间 | 无课程模型 | `courses`/`classes`/`enrollments` + 排课 | P2 | 一名学生多课程 |
| 排课/课表 | 周期课、时区、提醒 | 无 | 无 | `lessons` + 日历 + 通知 worker + ICS | P2 | 不双订、提醒准时 |
| 入会 | 6 位码/链接/名单 | 有 6 位码 | 无邀请链接/等待室 | 邀请链接 + 等待室 + 审批 | P1 | 链接可控、可撤销 |
| 考勤 | 迟到/早退/缺勤/导出 | 有原始进出记录 | 无迟到规则/导出/修改 | 考勤规则 + 自动结算 + 老师修正 + CSV/XLSX | P1 | 与原始记录一致 |
| 作业布置 | 附件、截止、迟交 | 无 | 无 | `assignments` + 对象存储 + 通知 | P2 | 发布 <2s，学生可见 |
| 作业提交 | 文本/图片/PDF/音频 | 无 | 无 | `submissions` + 上传 + 重交 | P2 | 20MB <3s |
| 作业批改 | 分数/评语/批注/语音 | 无 | 无 | 批注画布 + 评分 + 语音点评 | P2 | 批注保存/回看 |
| 优秀作业 | 展示/共享 | 无 | 无 | 标记 + 班级展示（授权） | P3 | 隐私可控 |
| 课堂报告 | 出勤/互动/白板/答题 | 有基础报告 | 无导出/学情 | 报告服务 + 图表 + 导出 | P2 | 课后 1 分钟内生成 |

### 2.6 录制与回放

| 能力 | ClassIn 体验 | 当前 | 差距 | 实现路径 | 阶段 | 验收 |
|---|---|---|---|---|---|---|
| 课堂录制 | 一键录制、云端 | 无 | 无 | LiveKit Egress room composite；Web 布局含白板 | P2 | 开始/停止 <5s |
| 回放 | 音视频 + 白板同步 | 无 | 无 | 录制 MP4/HLS + 白板 op log + 快照；播放器按时间轴回放 | P2 | 音画同步 <100ms |
| 章节/倍速 | 章节、倍速、字幕 | 无 | 无 | 转写/章节 worker + 播放器 | P3 | 倍速不变调 |
| 权限/水印 | 仅班级可见、水印 | 无 | 无 | 签名播放 URL + 动态水印 + 到期 | P2 | 未授权不可下载 |
| 存储/保留 | 生命周期、删除 | 无 | 无 | S3 生命周期 + 保留策略 + 删除任务 | P2 | 到期自动清理 |
| 录制同意 | 提示/勾选 | 无 | 无 | 开课提示 + 记录同意 + 合规 | P2 | 未同意不录 |

### 2.7 组织、消息与数据

| 能力 | ClassIn 体验 | 当前 | 差距 | 实现路径 | 阶段 | 验收 |
|---|---|---|---|---|---|---|
| 机构/校区 | 多租户、组织树 | 无 | 无 | `tenants`/`org_units` + 数据隔离 | P3 | 租户隔离测试 |
| 角色/权限 | 管理员/老师/助教/学生/家长 | 只有 teacher/student | 无 RBAC | 权限矩阵 + 服务端 guard + 审计 | P3 | 越权 403 |
| SSO | OIDC/SAML/SCIM | 无 | 无 | Keycloak/Auth0 + 租户配置 | P3 | 登录/登出/同步 |
| 通知 | 站内/推送/邮件/短信 | 无 | 无 | 通知服务 + 模板 + 重试/去重 | P2 | 到达率 >99% |
| 聊天 | 文本/图片/文件/@/公告 | 文本 500 字 | 能力窄 | 消息类型 + 审核 + 禁言 + 分页 | P1 | 1000 人扇出 |
| 学情分析 | 出勤/发言/答题/回放 | 无 | 无 | 事件采集 + ClickHouse + 报表 | P3 | 日更/实时 |
| 开放平台 | API/SDK/Webhook | 无 | 无 | OpenAPI + API Key + Webhook 签名 | P4 | 第三方接入 |

### 2.8 终端与体验

| 能力 | ClassIn 体验 | 当前 | 差距 | 实现路径 | 阶段 | 验收 |
|---|---|---|---|---|---|---|
| Windows | 原生客户端 | Electron | 无签名/自动更新 | NSIS + 代码签名 + electron-updater | P1 | 静默更新/回滚 |
| macOS | 原生客户端 | Electron | ad-hoc 签名 | Developer ID + 公证 + 自动更新 | P1 | Gatekeeper 通过 |
| Web | 浏览器上课 | 无 | 无 | React + LiveKit；HTTPS；浏览器兼容矩阵 | P2 | Chrome/Edge/Safari |
| iOS | 原生/RN | 无 | 无 | RN + LiveKit iOS；ReplayKit 共享；APNs | P3 | iOS 15+ |
| Android | 原生/RN | 无 | 无 | RN + LiveKit Android；MediaProjection；FCM | P3 | Android 9+ |
| 无障碍/i18n | 键盘/读屏/多语言 | 无 | 无 | ARIA + i18n + 主题 | P4 | WCAG 2.1 AA（关键路径） |

---

## 3. 目标架构与技术选型

### 3.1 逻辑架构

```
┌──────────────────────────────────────────────────────────────────┐
│ Electron (Win/mac)   Web (React)   iOS/Android (React Native)    │
│  UI / 白板渲染 / LiveKit SDK / Socket.IO 客户端                   │
└───────────────┬──────────────────────────────┬───────────────────┘
                │ HTTPS / WSS                  │ WebRTC (DTLS-SRTP)
                ▼                              ▼
        CDN + WAF + Nginx/Ingress        LiveKit SFU Cluster
                │                              │  (Redis 协调)
                ▼                              ├── TURN/coturn (TLS 443 兜底)
      API Gateway / BFF (Fastify)             ├── Egress (录制/转推)
        ├── Auth / Tenant / RBAC              └── Ingress (RTMP/HLS)
        ├── Room / Class / Lesson
        ├── Whiteboard Gateway (Socket.IO + Redis adapter)
        ├── Quiz / Timer / Breakout
        ├── Assignment / Courseware
        ├── Attendance / Report
        └── Notification
                │
      ┌─────────┼──────────────┬───────────────┬──────────────┐
      ▼         ▼              ▼               ▼              ▼
  PostgreSQL   Redis        S3/MinIO        BullMQ        ClickHouse
  (主数据)     (缓存/房间态) (课件/作业/录制) (转换/通知)   (分析)
                │
                ▼
      OpenTelemetry → Prometheus / Grafana / Loki / Sentry
```

### 3.2 服务边界

第一阶段继续**模块化单体**，不要拆微服务。按领域分目录/模块，允许独立 worker：

| 模块 | 职责 | 部署形态 |
|---|---|---|
| `identity` | 租户、用户、角色、SSO、会话 | API |
| `room` | 房间生命周期、成员、权限、入会码 | API + Socket |
| `media` | LiveKit token、房间映射、Webhook、录制编排 | API + Worker |
| `whiteboard` | op 校验、快照、广播、压缩 | Socket + Worker |
| `interaction` | 答题、计时、投票、随机选人、分组 | API + Socket |
| `course` | 课程、班级、排课、课件库 | API |
| `assignment` | 作业、提交、批改 | API + Worker |
| `attendance` | 进出事件、结算、报表 | Worker + API |
| `recording` | Egress 任务、转码、回放元数据 | Worker + API |
| `notification` | 站内/推送/邮件/短信 | Worker |
| `analytics` | 事件采集、指标、报表 | Worker + ClickHouse |
| `file` | 上传、签名、扫描、生命周期 | API + Worker |

拆分信号：某模块的发布频率/扩缩容需求/故障域明显独立（如 media、recording、analytics），再拆服务。

### 3.3 数据模型（建议）

核心表：

```
tenants(id, name, plan, status, created_at)
org_units(id, tenant_id, parent_id, type, name)
users(id, tenant_id, email, phone, display_name, role, password_hash, status, created_at)
identities(id, user_id, provider, subject, metadata)          -- SSO
courses(id, tenant_id, title, cover, owner_id, status)
classes(id, course_id, name, teacher_id, capacity, status)
enrollments(id, class_id, user_id, role, status, joined_at)
lessons(id, class_id, title, starts_at, ends_at, timezone, room_id, status)
rooms(id, tenant_id, lesson_id, host_id, join_code, mode, policy_json, status, created_at, started_at, ended_at)
room_members(id, room_id, user_id, role, state, joined_at, left_at)
participant_sessions(id, room_id, user_id, joined_at, left_at, device, ip_hash)
whiteboard_snapshots(id, room_id, seq, doc_json, s3_key, created_at)
whiteboard_ops(id, room_id, seq, op_json, created_at)          -- 可选 op log
messages(id, room_id, user_id, kind, content, attachments, created_at, deleted_at)
files(id, tenant_id, owner_id, room_id, mime, size, sha256, s3_key, status, created_at)
assignments(id, class_id, lesson_id, title, description, due_at, rubric_json, status)
submissions(id, assignment_id, student_id, content, files, submitted_at, status)
grades(id, submission_id, grader_id, score, feedback, annotations_json, graded_at)
recordings(id, room_id, egress_id, status, mp4_key, hls_key, duration, started_at, ended_at)
quizzes(id, room_id, teacher_id, status, config_json)
quiz_questions(id, quiz_id, type, stem, options_json, answer_json, score)
quiz_answers(id, quiz_id, question_id, student_id, answer_json, score, created_at)
timers(id, room_id, ends_at, state, created_by)
breakout_groups(id, room_id, name, livekit_room, created_at)
breakout_members(id, group_id, user_id, moved_at)
attendance_records(id, lesson_id, user_id, first_joined_at, last_left_at, total_ms, late, early_leave, status)
notifications(id, user_id, type, payload_json, read_at, created_at)
audit_logs(id, tenant_id, actor_id, action, target, metadata, created_at)
```

关键约束：

- 所有业务表带 `tenant_id`（或通过 course/class 间接带），服务端强制过滤；Postgres RLS 可作为第二道防线。
- 时间统一 Unix 毫秒（延续现有约定）；时区只影响展示/排课。
- 白板大文档不要放 `doc_json` 单列：快照进 S3，DB 只存元数据与最新 seq；小班可保留 `doc_json` 兼容。
- 考勤/答题/聊天等高频写入按房间分区或按月分区；分析走 ClickHouse。

### 3.4 实时事件模型

| 通道 | 用途 | 传输 | 备注 |
|---|---|---|---|
| LiveKit SFU | 音视频/屏幕/数据 | WebRTC | token 由后端签发；权限在 token 中 |
| Socket.IO | 白板 op、聊天、答题、计时、举手、分组状态 | WSS | Redis adapter；room = `room:{id}` |
| REST | 房间/课程/作业/文件/报表 | HTTPS | OpenAPI + zod 校验 |
| Webhook | LiveKit 房间开始/结束/参与者/录制完成 | HTTPS | 签名 + 重试 + 幂等 |
| 消息队列 | 转换/录制后处理/通知/报表 | Redis/BullMQ | 至少一次 + 幂等键 |

事件设计原则：

1. **服务端权威**：白板、答题、计时、举手、权限都以服务端状态为准。
2. **幂等**：客户端生成 `opId`/`requestId`；服务端去重窗口 ≥ 5 分钟。
3. **有序**：白板 `seq`；聊天 `createdAt + id`；答题按题目聚合。
4. **可恢复**：每个房间有 `snapshot` + `seq`；重连先拉快照再补增量。
5. **可观测**：每个事件带 `traceId`、`roomId`、`userId`（脱敏）。

### 3.5 媒体路径与容量

**小班（1+16）**

- 每人发布：音频 32~64 kbps + 摄像头 simulcast（180p/360p/720p，150/500/1500 kbps）+ 可选屏幕 1~2.5 Mbps。
- SFU 只转发订阅者需要的层；Dynacast 在无订阅时暂停。
- 估算：16 人全部 360p 订阅，SFU 出向约 16×15×0.5 Mbps ≈ 120 Mbps；实际用 Dynacast/暂停视频可降到 30~60 Mbps。
- 单 4c8g SFU 节点可承载多个 16 人小班；具体以压测为准。

**大班（1 主讲 + 1000 观众）**

- 主讲发布 720p/1.5 Mbps + 音频 64 kbps；观众只订阅 360p/300 kbps + 音频 40 kbps。
- SFU 出向：1000×340 kbps ≈ 340 Mbps；2 节点 HA，单节点 1 Gbps 网卡有余量。
- 若要求 720p 观众：1000×1.5 Mbps = 1.5 Gbps，需要 2~4 节点或 CDN/LL-HLS 卸载。
- 1000 个发布者：不做；连麦者按“上台”临时授权，最多 8~16 人。
- 录制：Egress 只合成一次，不随观众数增加。

**信令/白板**

- 1000 socket 连接本身不是问题；问题是 op 扇出。按 20 op/s、1000 人，原始扇出 20k 消息/s；服务端按 50ms 合并后约 400 批/s，每批 ~1~5 KB，可承受。
- 跨节点用 Redis adapter；单房间连接可能分布在多节点，adapter 会 fanout。
- 白板快照分块（≤256 KB/块），避免 2 MB socket 上限。

### 3.6 白板规模化方案

保留现有“服务端权威 + 共享 reducer”，增强为：

1. **写入权限**：小班允许学生写；大班只允许主讲/助教写，观众只读。
2. **op 批处理**：服务端每 50ms 合并同房间 op，按 `seq` 广播；客户端按 `seq` 去重/排序。
3. **快照分块**：`wb:sync` 返回 `snapshotId + chunks`；客户端按页/按元素分块拉取；每块 ≤256 KB。
4. **op log + 快照**：Redis Streams 保存最近 N 分钟 op；S3/DB 保存快照；新客户端先快照再补 op。
5. **压缩/墓碑**：删除元素保留墓碑用于 rev 冲突检测；超过阈值后做压缩快照并清理老墓碑。
6. **渲染分层**：背景图/静态元素/动态笔迹分层；大文档用位图缓存；移动端 Skia。
7. **导出**：客户端 canvas 导出 PNG；服务端用 headless Chromium 渲染 PDF（可选）。

### 3.7 录制/回放管线

```
LiveKit Room
  ├─ Egress RoomComposite ──► MP4/HLS ──► S3 ──► CDN
  ├─ Webhook room_started/finished ──► recording 任务
  └─ Whiteboard op log + snapshots ──► 时间轴索引
                                      │
                                      ▼
                          playback manifest (JSON)
                          { videoUrl, duration, whiteboard: [{t, snapshotId}], chapters }
```

方案 A（推荐）：Egress 的 Web 布局页同时渲染摄像头、屏幕、白板；输出一个合成画面。优点：实现快、回放简单；缺点：白板交互不可单独切换。

方案 B：录制视频轨 + 白板事件日志，回放器叠加白板。优点：可切换布局/清晰度；缺点：需要播放器同步逻辑。

建议 Phase 2 先做 A，Phase 4 做 B 的“白板可切换”增强。

### 3.8 技术选型对比

#### SFU

| 方案 | 许可/成本 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **LiveKit** | Apache-2.0，可自建/云 | SDK 全、Egress/Ingress、Simulcast、Redis 多节点、社区活跃 | Go 技术栈需学习；超大规模需调优 | **推荐** |
| mediasoup | MIT | Node/C++、可控性强、成熟 | 自研信令/录制/集群，工作量大 | 备选（团队有媒体经验） |
| Janus | GPL | 老牌、插件多 | 架构旧、SDK 弱、运维复杂 | 不推荐新项目 |
| Agora/声网 | 商业 | 接入快、全球网络 | 成本、 vendor lock-in、数据合规 | 备选（出海/快速上线） |
| 腾讯云 TRTC | 商业 | 国内网络好、SDK 全 | 成本、锁定 | 国内备选 |
| 自研 | — | 完全可控 | 6~12 个月，不建议 | 不推荐 |

#### 其他

| 领域 | 推荐 | 备选 | 说明 |
|---|---|---|---|
| Web 框架 | 继续 Fastify | NestJS | 现有代码复用；NestJS 结构化更强但迁移成本高 |
| ORM | Drizzle 或 Kysely | Prisma | SQL-first、类型安全、迁移可控 |
| 队列 | BullMQ | Temporal | 课件/通知足够；复杂编排再上 Temporal |
| 对象存储 | S3/OSS + CDN | MinIO | 生产用云存储，开发用 MinIO |
| 搜索 | Postgres 全文 | Meilisearch | 课件/作业搜索后置 |
| 分析 | ClickHouse | BigQuery | 自建/云均可；按事件量选择 |
| 移动 | React Native | Flutter/原生 | 复用 TS 领域逻辑；Skia 白板 |
| 白板 | 现有 Konva + 自研 reducer | Yjs/tldraw | 保留权限与服务端权威；Yjs 仅评估多主协作 |
| 身份 | Keycloak | Auth0/Clerk | 自建可控；云服务省运维 |
| 转换 | LibreOffice + pdfium | OnlyOffice | 沙箱 worker，禁止宏 |

### 3.9 第三方依赖准入标准

任何新依赖必须满足：

1. **许可证**：Apache-2.0/MIT/BSD/ISC；GPL/AGPL 需法务评估（服务端隔离/不修改）。
2. **维护**：近 12 个月有 release，issue 响应正常，主版本不频繁 breaking。
3. **安全**：无高危 CVE；有安全披露流程；可 SBOM。
4. **可替换**：核心路径不绑定单一厂商；有导出/迁移方案。
5. **跨端**：SDK 覆盖目标平台；API 稳定。
6. **可运维**：可观测、可水平扩展、部署文档完整。
7. **数据合规**：数据存储地、加密、子处理商可接受。
8. **成本**：按 1000 并发/1000 小时录制估算 TCO，不只看单价。

---

## 4. 分阶段 Roadmap

> 时间以 8.5 人团队估算；每阶段结束必须过“退出标准”，不达标不进入下一阶段。

### Phase 0（已完成）小班 MVP

**交付**：1+4 Mesh 音视频、屏幕共享、协同白板、PDF 课件、聊天、课堂记录、Windows/macOS 打包、公网部署。

**退出标准**：类型检查、26 项单测、40 项冒烟、桌面构建通过；小班真机可用。

**遗留**：见 AUDIT 的 R-01~R-19。

---

### Phase 1（第 1~6 周）生产加固 + 小班体验

**目标**：把现有 1+4 小班做成“可放心商用”的版本，同时为 SFU 迁移做技术验证。

**交付物**

1. **质量与可观测**
   - CI：typecheck + unit + smoke（临时 DB）+ build；nightly 跑 RTC/白板/PDF/文件。
   - Playwright Electron 双窗口 E2E：远端音频、CSP 图片、401 刷新、关摄像头/切白板。
   - Prometheus 指标：连接数、房间数、白板 op 延迟/拒绝率、落库失败、TURN relay 比例、HTTP 5xx。
   - Sentry 前端/主进程错误；OpenTelemetry trace（API → socket → DB）。
2. **安全**
   - 注册改为邀请制/审核制（至少增加机构邀请码）；教师角色不可自选。
   - `POST /rooms/join` 与 socket `room:join` 按 IP+用户限流/退避。
   - 登出吊销 token（token version/黑名单）并断开 socket。
   - 文件上传 magic bytes + 图片解码上限 + 独立文件签名密钥 + 短 TTL。
3. **课堂体验**
   - 教师控制：全员静音、单人静音、移除学生、锁定课堂、举手队列/批准。
   - 设备选择面板、麦克风电平测试、扬声器测试。
   - 考勤规则/导出 CSV；学生只看自己（已修）。
   - 聊天：公告、禁言、图片（复用文件 API）、分页。
   - 白板图片工具接入、页缩略图、导出 PNG。
4. **技术验证**
   - LiveKit POC：1 老师 + 16 学生 + 100 观众；记录 CPU/带宽/延迟。
   - 白板 1000 观众扇出模拟；确定 50ms 批量合并方案。

**技术选型**：Playwright、Prometheus/OTel/Sentry、LiveKit POC、S3/MinIO SDK、Postgres 迁移评估。

**性能指标**

- 小班加入 p95 <2s；白板 op ack p95 <100ms；2 小时 soak 无断流/内存增长 <10%。
- E2E 关键路径 0 失败；错误率 <0.1%。

**退出标准**：P0/P1 安全项关闭；E2E 全绿；LiveKit POC 达到 1+16 p95 <300ms；形成迁移决策。

---

### Phase 2（第 7~16 周）SFU + 小班规模化 + Web + 录播 v1

**目标**：媒体层从 Mesh 切到 LiveKit；支持 1+16 小班；Web 端可用；课堂可录制。

**交付物**

1. **媒体层**
   - LiveKit 集群（2 节点 + Redis + coturn TLS）；token 服务；Webhook。
   - 客户端迁移：`livekit-client`（桌面/Web），保留现有 UI；删除 PeerManager 的 Mesh 路径（保留 fallback 开关）。
   - Simulcast/Dynacast/AdaptiveStream；音频优先；断线重连。
   - 屏幕共享：1080p30、系统声音（平台支持时）、多人共享权限。
2. **服务端**
   - Postgres 迁移（保留 SQLite 开发模式）；Redis 房间态/限流/adapter；S3 文件。
   - RoomPolicy（1v1/小班/大班/双师）；权限矩阵；等待室。
   - 白板：分块快照、op log、50ms 批量、压缩；1000 观众只读。
   - 考勤：会话表 + 结算 + 导出；时区/迟到规则。
3. **Web 端**
   - React + LiveKit + 现有白板组件；Chrome/Edge/Safari 兼容；HTTPS。
4. **录播 v1**
   - LiveKit Egress room composite（含白板 Web 布局）；MP4/HLS → S3；录制列表/播放页。
   - 录制同意提示、权限、保留策略。
5. **课件库 v1**
   - 上传 PDF/PPTX/图片；LibreOffice 转 PDF；页图入库；课堂导入。

**技术选型**：LiveKit、Postgres + Drizzle、Redis、S3/MinIO、BullMQ、Egress、LibreOffice。

**性能指标**

- 1+16：媒体 p95 <300ms；加入 <2s；白板 op p95 <150ms；2h soak 通过。
- 100 观众：加入 <5s；播放/白板 <500ms；Egress 录制成功率 >99%。
- Web 端 Chrome/Edge/Safari 最近两个大版本可用。

**退出标准**：SFU 小班灰度 100% 替换 Mesh；录播可回放；Web 端可上课；1000 观众压测方案就绪。

---

### Phase 3（第 17~26 周）大班 + 互动工具 + 移动端 MVP + 作业 v1

**目标**：支持 1+1000 大班；补齐课堂互动；移动端可上课；作业闭环。

**交付物**

1. **大班**
   - 观众只订阅；主讲/联席发布；举手队列/上台/下台；聊天审核/禁言；大班布局。
   - SFU 集群扩到 3~4 节点；1000 观众压测（360p/300kbps）；CDN/LL-HLS 备选。
   - 大班白板只读 + 主讲/助教写；50ms 批量。
2. **互动工具**
   - 答题卡/随堂测（单选/多选/判断/填空/简答）、实时统计、导出。
   - 计时器（服务端权威）、随机选人、投票、抢答/积分。
   - 分组讨论（子 LiveKit 房间、老师巡场、广播、倒计时、回主班）。
   - 课堂公告、云盘、小黑板。
3. **移动端 MVP**
   - React Native（iOS/Android）：登录、课表、进班、音视频、聊天、举手、白板查看（Skia 只读/基础绘制）。
   - 推送（APNs/FCM）；iOS ReplayKit/Android MediaProjection 屏幕共享（后置到 Phase 4）。
4. **作业 v1**
   - 布置、提交（文本/图片/PDF）、截止、迟交、评分/评语；通知。
   - 批注画布（图片/PDF）v1。
5. **排课 v1**
   - 课程/班级/课表、周期课、时区、提醒；ICS 导出。

**技术选型**：LiveKit Egress/Ingress、ClickHouse（可选）、RN + LiveKit + Skia、APNs/FCM、日历库。

**性能指标**

- 1+1000：95% 观众加入 <10s；媒体 p95 <500ms；白板 <500ms；CPU/带宽在预算内。
- 答题：1000 答案 <3s；计时器漂移 <200ms。
- 分组：移动 <3s；回主班 <3s。
- 移动端：崩溃率 <1%；首帧 <3s。

**退出标准**：大班灰度 3 场；互动工具全链路可用；移动端可完成一节 1+16 课；作业可布置/提交/批改。

---

### Phase 4（第 27~38 周）完整对标 + 机构化 + 回放增强

**目标**：补齐 ClassIn 核心教学管理；支持机构/多租户；回放可切换白板；多端一致。

**交付物**

1. **机构化**
   - 租户/校区/班级/师生/助教/家长；RBAC；审计日志；SSO（OIDC/SAML）；SCIM 可选。
   - 管理后台：组织、成员、课表、数据、权限。
2. **作业完整**
   - 语音点评、批注、评分标准、优秀作业、重交、统计、导出。
3. **课件完整**
   - DOCX/PPTX/视频、版本、标签、搜索、共享、水印、配额、生命周期。
4. **回放增强**
   - 白板可切换/同步、章节、倍速、字幕/转写、权限/水印、下载控制。
5. **学情分析**
   - 出勤、发言时长、聊天、答题、回放观看；老师/机构报表；导出。
6. **多端一致**
   - Web 全功能；移动端白板编辑、屏幕共享、推送、后台音频；桌面自动更新/签名/公证。
7. **体验**
   - 无障碍关键路径、i18n（中/英）、机构品牌主题。

**技术选型**：Keycloak/Auth0、ClickHouse、Whisper/云转写（可选）、electron-updater。

**性能指标**

- 99.9% 可用性；API p95 <200ms；报表生成 <60s；回放首帧 <2s；A/V 同步 <100ms。
- 多租户隔离测试 0 越权；SSO 登录 <3s。

**退出标准**：机构管理员可独立完成开课/排课/师生管理/报表；回放可切换白板；Web/移动/桌面功能矩阵一致。

---

### Phase 5（第 39~44 周）规模化、SLA、合规与 GA

**目标**：从“功能可用”到“可运营、可承诺 SLA”。

**交付物**

1. **容量与高可用**
   - 多可用区部署；Postgres 主备/PITR；Redis 哨兵/集群；S3 跨区复制；LiveKit 多节点自动扩缩。
   - 蓝绿/金丝雀发布；数据库迁移向后兼容；回滚演练。
2. **压测与混沌**
   - 1000 观众/200 房间/2 小时 soak；网络分区、SFU 节点 kill、Redis/DB 故障切换。
   - 容量基线报告与扩容手册。
3. **安全与合规**
   - 渗透测试、SAST/DAST/SCA、SBOM；密钥轮换；WAF/DDoS；审计。
   - PIPL/GDPR/COPPA/FERPA 评估；录制同意/保留/删除；数据驻留。
4. **成本优化**
   - SFU 码率/层策略、CDN 回源、录制存储生命周期、空闲房间回收；单位课堂成本报表。
5. **GA**
   - SLO/错误预算；值班/告警/runbook；客户支持流程。

**性能指标**

- 99.95% 大班可用性；P0 故障 MTTR <30min；RPO <5min、RTO <30min。
- 1000 观众 2h soak：0 断流、内存增长 <10%、错误率 <0.1%。
- 渗透测试无高危/严重；合规评估通过。

**退出标准**：SLA 可对外承诺；故障演练通过；成本在预算内；GA 检查清单全绿。

---

## 5. 性能指标与容量模型

### 5.1 SLO（对外承诺口径）

| 指标 | 小班 | 大班 | 测量方式 |
|---|---|---|---|
| 媒体端到端延迟 p95 | <300ms | 主讲/连麦 <300ms；观众 <500ms（WebRTC）或 1~3s（LL-HLS） | 端到端打点/合成视频时间码 |
| 音频延迟 p95 | <200ms | <250ms | 同上 |
| 加入房间 p95 | <2s | 95% <10s | 客户端打点 |
| 首帧 p95 | <1.5s | <3s | 客户端打点 |
| 白板本地回显 | <50ms | <50ms | 客户端打点 |
| 白板远端 p95 | <150ms | <500ms | 服务端 seq + 客户端时间 |
| 白板 op ack p95 | <100ms | <150ms | 服务端 |
| 聊天 p95 | <200ms | <500ms | 服务端 |
| 断线重连 p95 | <5s | <5s | 客户端 |
| 可用性 | 99.9% | 99.95% | 拨测/真实用户 |
| 错误率 | <0.1% | <0.1% | 服务端 5xx/客户端错误 |

### 5.2 容量模型

| 场景 | 发布者 | 订阅者 | 估算出向 | 节点建议 |
|---|---|---|---|---|
| 1+16 小班 | 17 | 17 | 30~120 Mbps | 1 个 4c8g SFU 可承载多间 |
| 1+1000 大班 360p | 1~4 | 1000 | ~340 Mbps | 2 节点 HA；1Gbps 网卡 |
| 1+1000 大班 720p | 1~4 | 1000 | ~1.5 Gbps | 3~4 节点或 CDN/LL-HLS |
| 1+1000 大班 1080p | 1~4 | 1000 | ~3 Gbps+ | 不推荐；用 CDN |
| 1000 互动发布者 | 1000 | 1000 | 不可行 | 不承诺 |

> 以上为带宽估算，CPU/加密/转发能力必须用 LiveKit load test 实测；每个节点留 30% 余量。

### 5.3 压测场景

1. **小班稳态**：100 间 1+16，30 分钟；观察 SFU CPU、丢包、白板延迟。
2. **大班峰值**：1 间 1+1000，加入风暴（60s 内 1000 人），持续 2 小时。
3. **白板扇出**：1 间 1000 观众，老师 20 op/s，50ms 合并；观察消息延迟/CPU。
4. **答题风暴**：1000 人同时提交，3s 内完成聚合。
5. **录制**：同时 50 间录制 1 小时；Egress CPU/磁盘/上传。
6. **故障**：kill SFU 节点、Redis 主、Postgres 主、网络分区；验证重连/切换/数据一致性。
7. **弱网**：10%/30% 丢包、200ms RTT、带宽 500kbps；音频优先/视频降级。

---

## 6. 跨端方案与约束

### 6.1 平台矩阵

| 平台 | 技术 | 音视频 | 屏幕共享 | 白板 | 关键约束 |
|---|---|---|---|---|---|
| Windows 10 1809+ | Electron | LiveKit | `desktopCapturer` + 系统音频 loopback | Konva | 代码签名、SmartScreen、显卡驱动 |
| macOS 12+ | Electron | LiveKit | ScreenCaptureKit + 屏幕录制权限 | Konva | 公证、权限、ad-hoc 不可分发 |
| Web | React + LiveKit | LiveKit | `getDisplayMedia`（Chrome/Edge；Safari 受限） | Konva | HTTPS、浏览器节流、系统音频因平台而异 |
| iOS 15+ | RN + LiveKit iOS | LiveKit | ReplayKit Broadcast Extension | Skia | 后台限制、CallKit/音频会话、审核 |
| Android 9+ | RN + LiveKit Android | LiveKit | MediaProjection + 前台服务 | Skia | 厂商省电、权限、FCM |
| 鸿蒙/其他 | 后置评估 | — | — | — | 按市场决定 |

### 6.2 跨端共享策略

- **共享**：`packages/shared` 的协议/元素模型/几何/命中/reducer；`packages/client-core` 的 REST/socket/状态机。
- **按端实现**：媒体渲染（LiveKit SDK）、白板渲染（Konva vs Skia）、文件系统、权限、推送。
- **UI**：桌面/Web 共用 React 组件；移动端 RN 单独布局（不要强行复用桌面 CSS）。
- **测试**：同一套协议契约测试跑三端；视觉回归按端维护基线。

### 6.3 移动端难点

1. **屏幕共享**：iOS 需要 Broadcast Upload Extension；Android 需要 MediaProjection + 前台服务；审核/权限说明要提前准备。
2. **后台音频**：iOS 音频会话类别、Android 音频焦点；来电/闹钟打断要恢复。
3. **白板性能**：Skia 渲染 + 手势（笔/手指/掌托）+ 压感；与桌面同一 reducer。
4. **包体积**：LiveKit + Skia + 字体；按需加载。
5. **弱网/省电**：自适应码率、音频优先、后台降级。

---

## 7. 安全、隐私与合规

### 7.1 身份与权限

- 多租户隔离：所有查询强制 `tenant_id`；Postgres RLS 兜底；跨租户测试纳入 CI。
- RBAC：admin / org_admin / teacher / TA / student / parent；权限矩阵服务端强制，前端只做展示。
- SSO：OIDC/SAML；SCIM 可选；教师/管理员强制 2FA。
- 会话：access 短 TTL、refresh 轮换 + 原子撤销、token version 吊销、登出断开 socket。
- 审计：登录、管理操作、文件下载、录制访问、权限变更。

### 7.2 媒体安全

- WebRTC DTLS-SRTP；TURN over TLS 443 兜底；token 短 TTL + 房间/角色绑定。
- 房间权限在 LiveKit token 中编码：`canPublish`、`canSubscribe`、`canPublishData`；上台才授权发布。
- 可选 E2EE：LiveKit E2EE（插入加密），但录制/转码/审核需要解密，按合规需求取舍。
- 防录制泄露：动态水印、下载控制、签名播放 URL；无法完全阻止屏摄，需产品/合规提示。

### 7.3 数据与文件

- 传输 TLS 1.3；静态加密 KMS；数据库备份加密。
- 文件：magic bytes、图片解码上限、病毒扫描、沙箱转换、独立内容域、`Content-Disposition`、短签名 URL、吊销。
- 课件转换禁止宏/外部链接；LibreOffice 运行在无网络、低权限容器。
- 数据分级：公开/内部/个人/敏感；保留策略与删除任务；导出需授权。

### 7.4 隐私与合规

- PIPL（中国）、GDPR（欧盟）、COPPA/FERPA（美国教育）；按目标市场评估。
- 未成年人：监护人同意、默认关闭录制/聊天公开、教师审核。
- 录制：开课提示、参与同意、录制指示、保留期限、删除请求。
- 数据驻留：按租户选择区域；子处理商清单。
- 事件响应：安全联系人、72 小时通报流程、取证保留。

### 7.5 应用安全

- Electron：保持 `contextIsolation`/`sandbox`/`webSecurity`；禁止 `nodeIntegration`；CSP 最小化；自动更新签名校验。
- 代码签名：Windows EV/OV 证书；macOS Developer ID + 公证。
- 供应链：锁文件、SCA、SBOM、构建可复现、依赖准入。
- 测试：SAST/DAST、渗透测试、依赖扫描、密钥扫描。

---

## 8. 测试与验收体系

### 8.1 测试金字塔

| 层 | 工具 | 范围 | 门槛 |
|---|---|---|---|
| 单元 | Vitest（建议从现有 tsx 脚本迁移） | shared reducer、权限、考勤、计分、房间策略 | 领域覆盖 ≥80%，分支 ≥70% |
| 集成 | Vitest + Testcontainers | Postgres/Redis/MinIO/LiveKit、Fastify inject、socket 流程 | 关键路径全覆盖 |
| 契约 | OpenAPI/zod + socket schema | REST/事件字段、错误码、版本兼容 | 破坏性变更必须版本化 |
| E2E | Playwright（Web/Electron）、Detox（RN） | 多用户上课、白板、共享、答题、录制 | P0 场景 0 失败 |
| 压力 | k6 + LiveKit load test + 自定义扇出 | 小班/大班/答题/白板/录制 | 达到第 5 节 SLO |
| 混沌 | Toxiproxy/Chaos Mesh | 节点/网络/依赖故障 | 自动恢复、无数据丢失 |
| 安全 | ZAP、Trivy、npm audit、渗透 | OWASP Top 10、依赖、镜像 | 无高危/严重 |

### 8.2 必测场景

**认证/房间**

- 注册/登录/刷新/登出/令牌过期/并发刷新/重放/越权。
- 入会码错误/暴力尝试限流/满员/课堂结束/被移除/等待室。
- 断线重连/换设备/重复进房/主持人离开/主持人转移。

**媒体**

- 1+16 全员音视频；关摄像头/切白板声音不断；设备切换；弱网；TURN relay；ICE restart。
- 屏幕共享：选屏/窗口/区域、系统声音、多人共享、停止共享、权限拒绝。
- 大班：1000 观众加入、主讲切换、举手/上台/下台、聊天审核。

**白板**

- 并发绘制/修改/删除/翻页/锁板；reject 回拉；断线 resync；删除当前页；50 页上限；大文档分块；1000 观众只读。
- 图片/PDF/PPTX 导入；导出；撤销/重做；压感；掌托/笔侧键。

**互动/作业/考勤/录制**

- 答题：1000 人提交、统计、重连恢复、截止。
- 计时器：暂停/延长/重连、端间漂移。
- 分组：移动/巡场/广播/回主班/断线。
- 作业：布置/提交/迟交/批改/重交/权限。
- 考勤：迟到/早退/重连/导出/隐私。
- 录制：开始/停止/失败重试/回放/权限/保留。

**跨端/兼容**

- Windows/macOS/Chrome/Edge/Safari/iOS/Android 最近两个大版本。
- 网络：4G/弱 Wi-Fi/高丢包/高 RTT。
- 设备：无摄像头/无麦克风/蓝牙耳机/双屏/高 DPI。

### 8.3 发布验收清单

- [ ] typecheck + unit + integration + smoke 全绿
- [ ] E2E P0 场景全绿
- [ ] 性能回归在 SLO 内（与上版对比）
- [ ] 安全扫描无高危/严重
- [ ] 数据库迁移可回滚/向后兼容
- [ ] 灰度 1% → 10% → 50% → 100%，每步观察 30 分钟
- [ ] 回滚演练通过
- [ ] 监控/告警/runbook 更新
- [ ] 发布说明/客户公告

### 8.4 现有测试命令与新命令

**现有**

```bash
npm run typecheck          # 4 workspace
npm run test:unit          # 26 项
npm test                   # 40 项冒烟（需服务端）
npm run test:rtc           # 三端 Mesh
npm run test:wb            # 三端白板
npm run test:pdf           # PDF 导入
npm run test:file          # 文件/报告
npm run test:media         # 采集降级
npm run test:ink           # 压感渲染
npm run test:pressure      # 压感数据
npm run test:turn          # TURN relay
```

**建议新增**

```bash
npm run lint
npm run test:coverage
npm run test:integration   # Testcontainers
npm run test:e2e:web       # Playwright
npm run test:e2e:desktop   # Playwright Electron
npm run test:e2e:mobile    # Detox
npm run test:load          # k6 + LiveKit load test
npm run test:chaos         # Toxiproxy/Chaos Mesh
npm run test:security      # ZAP + Trivy + audit
```

**CI 流水线（建议）**

```
PR:      install → typecheck → lint → unit → smoke(temp DB) → build
Nightly: integration → RTC/WB/PDF/media → E2E web/desktop → 30min soak
Release: full suite → load(1000) → chaos → security → staging → canary
```

---

## 9. 工程规范与交付

### 9.1 代码与架构

- 模块化单体：按 `identity/room/media/whiteboard/interaction/course/assignment/attendance/recording/notification/analytics` 分目录。
- API 版本化：`/api/v1`；破坏性变更升版本；OpenAPI 文档随代码生成。
- 事件 schema：zod 定义 + 版本号；客户端/服务端共享类型。
- 数据库迁移：单向、可回滚、向后兼容；大表变更用影子表/在线迁移。
- 幂等：请求 `Idempotency-Key`；消费者幂等键；重复消息安全。
- 特性开关：大班/录制/移动端按租户灰度。
- ADR：媒体选型、白板同步、录制方案、多租户隔离必须有决策记录。

### 9.2 可观测性

| 信号 | 内容 |
|---|---|
| Metrics | 连接数、房间数、发布者/订阅者、SFU CPU/带宽、丢包/RTT、白板 op 延迟/拒绝、落库失败、Egress 成功率、API p95/5xx |
| Traces | API → DB → socket → SFU webhook；白板 op 全链路 |
| Logs | 结构化 JSON；traceId/roomId/userId（脱敏）；错误分级 |
| Errors | Sentry（前端/主进程/后端）；去重/聚合/告警 |
| Dashboards | 课堂健康、媒体质量、白板、录制、容量、成本 |
| Alerts | SLO 燃烧率、SFU 节点异常、DB 复制延迟、Egress 失败、5xx 突增 |

### 9.3 环境与发布

- 环境：dev / staging / prod；staging 使用与 prod 同规格的小集群。
- 数据：脱敏种子；禁止把 prod 数据复制到 dev。
- 发布：蓝绿/金丝雀；数据库迁移先兼容后切换；回滚脚本。
- 值班：P0/P1 告警到人；runbook 包含 SFU/TURN/DB/Redis/录制故障处理。

### 9.4 Definition of Done

- 代码 + 测试 + 文档 + 监控 + 告警 + 灰度开关
- 关键路径有 E2E；性能有基线；安全有扫描
- 失败有降级/重试/用户提示
- 数据有迁移/回滚/保留策略

---

## 10. 30 / 60 / 90 天执行清单

### 第 1~30 天

- [ ] 关闭 AUDIT 的 P0/P1 安全项：邀请制/角色、join 限流、登出吊销、文件 magic bytes。
- [ ] 建 CI：typecheck + unit + smoke + build；nightly RTC/WB。
- [ ] Playwright Electron 双窗口 E2E：远端音频、CSP 图片、401 刷新、关摄像头/切白板。
- [ ] 接 Prometheus/OTel/Sentry 基线；定义 5 个核心 SLO。
- [ ] LiveKit POC：1+16 + 100 观众，输出 CPU/带宽/延迟报告。
- [ ] 考勤导出、教师控制（全员静音/举手队列/移除）、设备选择。
- [ ] 白板图片工具、页缩略图、导出 PNG。
- [ ] Postgres/Redis/S3 迁移方案评审。

### 第 31~60 天

- [ ] LiveKit 生产集群 + token 服务 + Webhook；桌面/Web 双端接入。
- [ ] 1+16 小班灰度；Mesh 保留 fallback 开关。
- [ ] 白板分块快照 + op log + 50ms 批量；1000 观众扇出模拟。
- [ ] 录播 v1：Egress + S3 + 播放页 + 同意/权限。
- [ ] 课件库 v1：PPTX/PDF 转换；课堂导入。
- [ ] Web 端 Beta；Chrome/Edge/Safari 兼容。
- [ ] 考勤/报告 v1；作业数据模型评审。

### 第 61~90 天

- [ ] 大班 Beta：1+1000 观众、举手/上台、聊天审核。
- [ ] 答题卡/计时器/随机选人 MVP；分组讨论 POC。
- [ ] 移动端 MVP：进班/音视频/聊天/举手/白板查看。
- [ ] 作业 v1：布置/提交/批改。
- [ ] 1000 观众压测 + 2 小时 soak；输出容量报告。
- [ ] 安全渗透测试第一轮；修复高危。
- [ ] 形成 Phase 3 决策：继续自建/扩容/引入 CDN。

---

## 11. 风险登记

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| SFU 运维复杂度超预期 | 中 | 高 | 先用 LiveKit 托管/单区域，逐步自建；SRE 提前介入；压测先行 |
| 大班带宽成本高 | 高 | 高 | 观众 360p/300kbps；Simulcast/Dynacast；CDN/LL-HLS；成本看板 |
| 移动端屏幕共享/后台音频审核 | 中 | 高 | 提前做 iOS/Android 权限与审核材料；先做观看/连麦，后做共享 |
| 白板大文档性能 | 中 | 高 | 分块/压缩/分层渲染；限制单页元素；压测 4000 元素 |
| 录制合规/隐私 | 中 | 高 | 同意/指示/保留/删除；法务评估；按市场灰度 |
| 多租户隔离漏洞 | 中 | 高 | tenant_id 强制 + RLS + 越权测试 + 审计 |
| 团队技能缺口（媒体/Go/SFU） | 中 | 中 | LiveKit 培训/POC；外部顾问；先托管 |
| 供应商锁定 | 中 | 中 | 抽象 token/录制/存储接口；保留迁移方案 |
| 进度延误 | 高 | 中 | 按阶段退出标准；砍 P2/P3；先小班+录播+作业 |
| 安全事件 | 低 | 高 | 2FA、审计、渗透、应急演练、密钥轮换 |
| 旧客户端兼容 | 中 | 中 | 协议版本化；强制升级；灰度 |

---

## 12. 附录

### 12.1 当前能力到目标模块的映射

| 当前文件/模块 | 目标 |
|---|---|
| `packages/shared/model/reduce.ts` | 白板领域核心，保留并扩展（权限、页、压缩） |
| `packages/shared/protocol/*` | 协议层，扩展 quiz/timer/breakout/assignment 事件 |
| `packages/client-core/wb/WhiteboardClient.ts` | 白板状态机，增加分块 sync/批量/只读 |
| `packages/client-core/rtc/PeerManager.ts` | Mesh 过渡；Phase 2 替换为 LiveKit 适配层 |
| `packages/server/realtime/RoomRegistry.ts` | 房间运行时；Phase 2 迁 Redis/Postgres |
| `packages/server/realtime/handlers/wb.ts` | 白板网关；增加批量/分块/权限 |
| `packages/server/routes/*` | 扩展 course/assignment/attendance/recording |
| `apps/desktop/renderer/wb/*` | 桌面白板 UI；Web 复用；移动用 Skia |
| `apps/desktop/renderer/room/*` | 课堂 UI；抽出共享组件给 Web |

### 12.2 建议的 REST API（节选）

```
POST   /api/v1/auth/register|login|refresh|logout
GET    /api/v1/me
GET    /api/v1/courses
POST   /api/v1/courses
GET    /api/v1/classes/:id/lessons
POST   /api/v1/lessons/:id/room
POST   /api/v1/rooms/:id/join
POST   /api/v1/rooms/:id/leave
GET    /api/v1/rooms/:id/report
POST   /api/v1/rooms/:id/token            # LiveKit token
POST   /api/v1/rooms/:id/recording/start|stop
GET    /api/v1/recordings/:id
POST   /api/v1/assignments
POST   /api/v1/assignments/:id/submissions
POST   /api/v1/submissions/:id/grade
GET    /api/v1/lessons/:id/attendance
GET    /api/v1/lessons/:id/attendance/export
POST   /api/v1/files
GET    /api/v1/files/:id/url
```

### 12.3 建议的 Socket 事件（节选）

```
room:join / room:leave / room:end
presence:media
wb:op / wb:op:reject / wb:sync / wb:preview / wb:presence / wb:page / wb:lock
chat:send / chat:message / chat:recalled
hand:raise / hand:lower / hand:approve / hand:reject
stage:invite / stage:accept / stage:leave
quiz:start / quiz:question / quiz:answer / quiz:stats / quiz:end
timer:start / timer:pause / timer:extend / timer:end
breakout:create / breakout:assign / breakout:move / breakout:broadcast / breakout:return
recording:started / recording:stopped / recording:ready
```

### 12.4 依赖短名单

| 用途 | 首选 | 备选 | 备注 |
|---|---|---|---|
| SFU | LiveKit | mediasoup / Agora | 先 POC |
| WebRTC SDK | livekit-client / @livekit/react-native | 原生 SDK | 跨端 |
| DB | PostgreSQL + Drizzle/Kysely | Prisma | 迁移 |
| Cache/Queue | Redis + BullMQ | Temporal | 先简单 |
| 存储 | S3/OSS + CDN | MinIO | 开发 MinIO |
| 录制 | LiveKit Egress + ffmpeg | 自研 | Egress 优先 |
| 转换 | LibreOffice + pdfium | OnlyOffice | 沙箱 |
| 身份 | Keycloak | Auth0 | SSO |
| 监控 | OTel + Prometheus + Grafana + Loki + Sentry | Datadog | 成本 |
| 分析 | ClickHouse | BigQuery | 事件量 |
| 测试 | Vitest + Playwright + Detox + k6 + Testcontainers | Jest/Cypress | 统一 |
| 移动 | React Native + Skia | Flutter | 复用 TS |

### 12.5 术语

- **SFU**：Selective Forwarding Unit，选择性转发，不混流。
- **Simulcast**：同一视频发多档分辨率/码率，订阅者按需选层。
- **Dynacast**：无人订阅时暂停该层，省带宽。
- **Egress**：LiveKit 的录制/转推组件。
- **LL-HLS**：低延迟 HLS，通常 1~3 秒。
- **RBAC**：基于角色的访问控制。
- **RPO/RTO**：恢复点目标/恢复时间目标。
- **SLO/SLI**：服务目标/指标。

---

> 本方案与 [`AUDIT.md`](AUDIT.md) 配套使用：AUDIT 回答“现在有什么问题、修了什么”，本方案回答“要做什么、按什么顺序、如何验收”。
