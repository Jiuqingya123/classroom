# 部署说明

> 2026-10-28 迁移准备：Windows 家庭服务器部署包与云端专用 frp 中继（TCP 7100）已就绪，
> 生产流量仍在本文描述的云端 `127.0.0.1:8090`，**尚未切流**。迁移步骤、已验证/未验证边界
> 与回滚流程见 [windows-server.md](windows-server.md)。

目标机器：`<PROD_SERVER_IP>`（阿里云 ECS，Alibaba Cloud Linux 3，2 vCPU / 1.8G 内存，已有宝塔面板在跑其他站点）

## 一、最终形态

```
客户端(Electron / Android)
   │  http / ws  :80 或 :9999
   ▼
nginx（宝塔管理）  listen 80 + 9999; server_name <PROD_SERVER_IP>
   │  proxy_pass 127.0.0.1:8090（含 WebSocket upgrade；client_max_body_size 60m）
   ▼
Node 服务（systemd: classroom）
   ├── SQLite   /opt/classroom/data/app.db   (node:sqlite，WAL)
   └── 上传文件 /opt/classroom/data/uploads/<id前2位>/<id>
   ▲
   │  HMAC 签发临时凭据
coturn（systemd: coturn）  3478/udp + 3478/tcp，中继端口 49160-49200
```

| 项目 | 值 |
|---|---|
| 访问地址 | `http://<PROD_SERVER_IP>:9999`（80 端口同样可达） |
| 当前版本 | 1.1.3，2026-10-28 部署（含教学管理扩展） |
| 应用目录 | `/opt/classroom` |
| 服务名 | `systemctl status classroom` |
| 监听 | `127.0.0.1:8090`（不直接对外） |
| nginx 站点 | `/www/server/panel/vhost/nginx/classroom_<PROD_SERVER_IP>.conf` |
| 环境变量 | `/opt/classroom/.env`（0600，密钥由脚本随机生成） |
| 上传上限 | 应用 `MAX_UPLOAD_MB=50`，nginx `client_max_body_size 60m` |
| 日志 | `journalctl -u classroom -f` |
| TURN 配置 | `/etc/coturn/turnserver.conf`，日志 `/var/log/coturn/turnserver.log` |
| 部署前备份 | `/opt/classroom-backups/20261028-111253/`（DB、data、代码、env、nginx） |

## 二、为什么 nginx 用 80 / 9999 端口 + server_name

外网安全组放行了 80 / 9999 / 443 / 23450 / 8888，**8080 是关的**（实测确认）。
机器上已有多个站点（`<YOUR_DOMAIN>`、`hr.<YOUR_DOMAIN>` 等），默认站点是 `server_name _`。
所以新增一个 `listen 80; listen 9999; server_name <PROD_SERVER_IP>;` 的 vhost —— 只接管「Host 就是 IP」的请求，
其余域名站点完全不受影响。改动只新增了一个文件，没有触碰任何现有配置。

> nginx reload 时会提示 `conflicting server name "<PROD_SERVER_IP>"`，这是机器上原有的
> `html_<PROD_SERVER_IP>.conf` 也声明了同一个 server_name。实际生效的是按字母序后加载的本文件
> （已验证 `/healthz` 返回 200）。这条警告可以忽略。

### 本次部署新增的环境配置（2026-10-28）

Android WebView 的 Origin 与桌面端不同，且课件/作业附件需要更大的上传额度，因此生产 `.env` 已调整为：

```dotenv
ALLOWED_ORIGINS=http://<PROD_SERVER_IP>:9999,http://<PROD_SERVER_IP>,http://localhost:5273,http://localhost,https://localhost,capacitor://localhost,file://,null
MAX_UPLOAD_MB=50
```

对应 nginx vhost 的 `client_max_body_size` 从 `8m` 提到 `60m`（留 multipart 余量）。
预检已实测：`https://localhost`、`capacitor://localhost`、`file://`、`null`、`http://localhost:5273`
均返回 204 且带正确的 `Access-Control-Allow-Origin`。修改 `.env` 后需 `systemctl restart classroom`，
修改 nginx 后需 `nginx -t && nginx -s reload`。

## 三、两个刻意的技术选择

### 1. 数据库用 Node 内置 `node:sqlite`，不用 better-sqlite3

better-sqlite3 的官方预编译包要求 **glibc ≥ 2.33**，而这台机器是 **2.32**：

```
node_modules/better-sqlite3/prebuilds/linux-x64.node:
  /lib64/libc.so.6: version `GLIBC_2.33' not found
  /lib64/libc.so.6: version `GLIBC_2.34' not found
```

想从源码编译，`node-gyp` 又要求 Python ≥ 3.8（系统自带 3.6），且该版本 gyp 生成的是**空目标**
（0 个 .o），配不出可用构建。Node 24 自带 `node:sqlite`，稳定、零编译、不受 glibc 约束，
API 与 better-sqlite3 高度相似（`prepare/get/all/run/exec`），迁移成本很小。

### 2. 密码哈希用内置 `crypto.scrypt`，不用 argon2

argon2 同样是原生模块（本机能编过，但每次 `npm install` 都要 C++ 工具链）。
换成 scrypt 后**服务端零原生依赖**，`npm install` 只要 5 秒，任何机器都能装。

存储格式 `scrypt$N$r$p$salt$hash`，参数写进串里，将来调参可以按条目平滑升级。
`N=16384, r=8, p=1`（约 16MB 内存/次），在 1.8G 内存的机器上是合适档位。

> ⚠️ 副作用：本地开发库里用 argon2 生成的旧密码记录无法通过校验，需要重新注册。
> 部署脚本会重建库，生产环境不受影响。

## 四、TURN 的关键配置（踩过的坑）

这台机器网卡上是内网 `<PROD_SERVER_PRIVATE_IP>`，公网 `<PROD_SERVER_IP>` 是 NAT 映射。
最初写成 `relay-ip=0.0.0.0`，coturn 用它作为中继地址，对端申请 CreatePermission 时地址对不上，
直接返回 **403**，现象是「能拿到 relay 候选、但连接永远建不起来」。

正确写法（`external-ip=<公网>/<内网>` 且 `relay-ip` 必须是真实网卡地址）：

```
listening-ip=<PROD_SERVER_PRIVATE_IP>
relay-ip=<PROD_SERVER_PRIVATE_IP>
external-ip=<PROD_SERVER_IP>/<PROD_SERVER_PRIVATE_IP>
```

另外：**不要把回退 TCP 指向 5349**。5349 是 coturn 的 TLS 端口，明文 TCP 打过去会被拒，
而且这台机器上 5349 本来就没放行。服务端现在两种传输都挂 3478：

```
turn:<PROD_SERVER_IP>:3478?transport=udp
turn:<PROD_SERVER_IP>:3478?transport=tcp
```

实测（`npm run test:turn`，`iceTransportPolicy: 'relay'` 强制中继）：

```
✅ relay-only 模式下连接建立成功
✅ 数据通道经中继收到消息  relay-hello
✅ 选中候选是 relay  relay → relay
✅ 候选里没有 host（确认真的禁了直连）
```

## 五、安全组需要放行的端口

已验证从外网可达：`80/tcp`、`9999/tcp`、`3478/udp`、`3478/tcp`、`49160/udp`。

| 端口 | 协议 | 用途 | 状态 |
|---|---|---|---|
| 80 | tcp | 站点与 API（兜底） | 已放行 |
| 9999 | tcp | 站点与 API（主入口） | 已放行 |
| 3478 | udp + tcp | TURN 主端口 | 已放行 |
| 49160-49200 | udp | TURN 中继端口段 | 至少 49160 已放行 |

如果之后改了 `min-port/max-port`，记得同步安全组，否则中继分配会失败。
`5349`（TURN over TLS）未放行，当前也没用上；要走加密中继需要签证书并改用 `turns:`。

## 六、重新部署

```bash
# 改了服务端代码后（只同步源码，不动 data/）
KEY=/path/to/deploy-key npm run deploy:push
```

脚本做的事：本地打包 → 上传 → `npm install` → `systemctl restart classroom` → 健康检查。
不传 `KEY` 时走本机 ssh-agent。**脚本不会自动备份数据库**，涉及迁移或大改前先手动备份：

```bash
ssh root@<PROD_SERVER_IP> 'B=/opt/classroom-backups/$(date +%Y%m%d-%H%M%S); mkdir -p $B; \
  cp /opt/classroom/data/app.db $B/app.db; tar czf $B/data.tgz -C /opt/classroom data; \
  cp /opt/classroom/.env $B/.env'
```

远端一次性初始化（首次部署才需要）：

```bash
ssh root@<PROD_SERVER_IP> 'cd /opt/classroom && PUBLIC_HOST=<PROD_SERVER_IP> PUBLIC_PORT=9999 bash deploy.sh'
```

## 七、客户端连到这台服务器

```bash
# 桌面客户端（Electron 主进程会把这个地址下发给渲染进程）
CLASSROOM_SERVER_URL=http://<PROD_SERVER_IP>:9999 npm run dev
# 等价快捷命令
npm run dev:remote

# 纯浏览器调试（Vite 层注入）
npm run dev:remote:web
```

打包 dmg 需要先装 `electron-builder`（当前未安装），并把 `CLASSROOM_SERVER_URL`
写进打包环境的变量；签名需要 Apple 开发者证书。

## 八、验收命令

> 本机默认 Node 20 没有 `node:sqlite`，服务端脚本请用 Electron 自带的 Node 24 跑：
> `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron ...`。若 PATH 里的 `node` 已是 24，
> 把前缀换成 `node` 即可。

```bash
# 服务端在不在
curl http://<PROD_SERVER_IP>:9999/healthz

# 40 项端到端（注册/登录/建房/进房/名单/聊天/踢旧连接/下课）
ELECTRON_RUN_AS_NODE=1 BASE=http://<PROD_SERVER_IP>:9999 ./node_modules/.bin/electron scripts/smoke.mjs

# 教学平台 88 项（课程/课节/课件/题库/作业/通知/互动/管理后台）
ELECTRON_RUN_AS_NODE=1 BASE=http://<PROD_SERVER_IP>:9999 ./node_modules/.bin/electron scripts/platform-smoke.mjs

# 文件上传、签名访问、课堂记录（16 项）
ELECTRON_RUN_AS_NODE=1 BASE=http://<PROD_SERVER_IP>:9999 ./node_modules/.bin/electron scripts/file-test.mjs

# 三端 Mesh 音视频（40 项，需要 renderer dev server）
BASE=http://<PROD_SERVER_IP>:9999 npx electron --no-sandbox scripts/rtc-test.cjs

# 三端白板收敛（31 项）
BASE=http://<PROD_SERVER_IP>:9999 npx electron --no-sandbox scripts/wb-test.cjs

# PDF 课件导入（自造一份两页 PDF 跑完整链路）
npx electron --no-sandbox scripts/pdf-test.cjs

# TURN 中继真连（强制 relay，证明跨网可用）
BASE=http://<PROD_SERVER_IP>:9999 npx electron --no-sandbox scripts/turn-test.cjs
```

### 2026-10-28 部署验证结果

| 检查 | 结果 |
|---|---|
| `systemctl is-active classroom` | `active`，重启后 RSS 约 86MB / 上限 800MB |
| `GET /healthz`（本机 + 公网） | `{"ok":true,"env":"production","rooms":0,"turn":"configured"}` |
| 迁移 | `002_teaching_platform.sql` 已应用，用户数据保留 |
| 核心冒烟 | 远程 35/35 通过（另 1 项本地落库校验跳过；本地全量 40 项） |
| 平台冒烟 | 远程 75/75 通过（另 2 项本地专属校验跳过：管理后台、落库；本地全量 88 项） |
| CORS 预检 | 5 个客户端 Origin 全部 204 + 正确回显 |
| 数据清理 | 冒烟产生的 7 个测试账号/课程/教室/附件已删除，用户数回到部署前的 38 |

## 九、注意事项

- 服务进程限制了 `MemoryMax=800M`。这台机器只有 1.8G 内存，还跑着 docker、宝塔、
  next-server 和 easytier，不设上限一旦 OOM 会波及别人的站点。
- 数据库和上传目录都在 `/opt/classroom/data`，**重装代码不会动它**，备份就备份这个目录。
- 磁盘曾经到过 91%（当时只剩 3.5G），现已降到 61%。上传目录会随课件增长，
  建议加一条定期清理旧 `data/uploads` 的 cron。
- `.env` 里是随机生成的 `JWT_SECRET` 与 `TURN_SECRET`。**换 JWT_SECRET 会让所有已登录用户失效**；
  换 TURN_SECRET 必须同步改 coturn 配置并重启，否则新凭据全部鉴权失败。
