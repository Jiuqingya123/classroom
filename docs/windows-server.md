# Windows 服务端迁移与公网穿透

日期：2026-10-28

目标：把 ClassRoom 服务端从阿里云 ECS 迁到家里的 Windows 电脑。家庭宽带不需要任何
入站端口；云服务器只保留公网入口和反向隧道，音视频仍走 WebRTC 直连 / 云端 coturn。

## 一、当前状态

| 项目 | 状态 |
|---|---|
| Windows 部署包 | 已构建并验证：`dist/ClassRoomServer-1.1.3-win-x64.zip` |
| 云端专用中继 | 已安装并运行：`classroom-relay.service`，TCP 7100 → 127.0.0.1:8091 |
| 生产流量 | **仍在云端**：nginx 9999 → 127.0.0.1:8090，未切流 |
| 真实 Windows 安装 | **未执行**（当前没有 Windows 机器） |
| 生产切流 | **未执行**（只做了脚本和演练，见 §五） |

云端原有的 frps 仍占着 7000 端口（另一个无关业务，2026-08-13 启动）。本次刻意使用
**7100**，没有改动或重启它。7100 已确认能从公网连入（安全组已放行）。

## 二、架构

```
浏览器 / 桌面端 / Android
        │  http + ws  http://<PROD_SERVER_IP>:9999
        ▼
云服务器 nginx :9999
        │  proxy_pass 127.0.0.1:8091
        ▼
frps :7100（仅本机 8091 落地）  ←==== 反向隧道（Windows 主动出站）====  frpc（Windows）
                                                                          │
                                                                          ▼
                                                                 ClassRoom 127.0.0.1:8090
```

| 位置 | 端口 | 用途 | 公网可达 |
|---|---|---|---|
| 云服务器 | 9999 | 平台主入口（nginx） | 是 |
| 云服务器 | 7100 | frp 控制端口 | 是（安全组已放行） |
| 云服务器 | 8091 | 隧道落地端口 | **否**，只绑 127.0.0.1 |
| 云服务器 | 3478/udp + tcp | coturn 音视频中继 | 是（保持原状） |
| Windows | 8090 | 服务端 | **否**，只绑 127.0.0.1 |

关键点：

- 家庭宽带即使是 CGNAT、没有公网 IP、没有可用的入站端口也能用，因为 frpc 是主动出站连到云端 7100。
- 媒体流不经过 frp 隧道。隧道只承载 HTTP / WebSocket 信令和文件上传；音视频仍由客户端
  直连或走云端 coturn。
- 隧道断开时，nginx 访问 8091 会 502；云端旧服务仍在 8090，可随时切回。

## 三、交付物

| 项目 | 值 |
|---|---|
| 压缩包 | `dist/ClassRoomServer-1.1.3-win-x64.zip` |
| 大小 | 50,450,918 字节（约 48.1 MB） |
| SHA256 | `0754d0bcd07c10e61a4036e727dfa86252bee6c643fecbda70e3f868802c226c` |
| 包内文件数 | 35（见包内 `SHA256SUMS.txt`） |
| 服务端 | 1.1.3，esbuild 单文件 ESM bundle |
| 运行时 | Node 24.22.1 win-x64（包内自带） |
| 隧道 | frp 0.71.1（`frpc.exe` / 云端 `frps`） |
| 服务包装 | WinSW.NET461 2.12.0 |
| 云端中继目录 | `/opt/classroom-relay/`（frps、frps.toml 0600、4 个运维脚本） |
| 云端 systemd | `classroom-relay.service`（active、enable） |

包内含 `config/turn.secret`、`tunnel/frpc.toml`、`.env` 等敏感文件。**不要发群、不要传公共网盘**，
用局域网、U 盘或加密通道传到 Windows。

包内的 `README.md` 是面向操作者的完整手册；本文记录迁移决策、当前云端状态和已验证/未验证边界。

## 四、已完成的验证（2026-10-28）

以下均针对最终构建产物（上面的 SHA256）：

| 检查 | 方法 | 结果 |
|---|---|---|
| 压缩包完整性 | `unzip -t` | 无错误 |
| 包内校验和 | `shasum -a 256 -c SHA256SUMS.txt` | 35/35 全部 OK |
| PowerShell 语法 | PowerShell 7.4.7 Parser 逐个解析 | 6/6 通过 |
| 中文编码 | 检查 `.ps1` 文件头 | 均为 UTF-8 BOM（`EF BB BF`） |
| WinSW XML | `xmllint --noout` | 3 个模板全部 OK |
| 云端脚本语法 | `bash -n` | 5/5 通过 |
| 二进制架构 | `file` | `node.exe` PE32+ x64、`frpc.exe` PE32+、WinSW PE32 .NET、`frps` ELF x86-64 |
| 包可启动 | 用 Node 24 启动 `app/server.mjs` | `/healthz` 返回 `{"ok":true,"env":"production",...}` |
| 数据库 | `tools/db-check.mjs` | `integrity: ok`，20 张表 |
| 核心冒烟 | `scripts/smoke.mjs` 对最终包实例 | 全部通过 |
| 教学平台冒烟 | `scripts/platform-smoke.mjs` 对最终包实例 | 全部通过 |
| 隧道全链路 | 包内 `frpc.toml` + frp 0.71.1（客户端为同版本 macOS 构建）→ 云端 7100 | `login to server success`、`start proxy success` |
| 隧道落地 | 云端 `curl 127.0.0.1:8091/healthz` | 返回 `{"ok":true,"env":"production",...}` |
| 隧道隔离 | 公网 `curl <PROD_SERVER_IP>:8091` | 连接被拒（符合预期） |
| 数据导出 | 云端 `/opt/classroom-relay/export-data.sh` 在线快照 | 140K；`sqlite_integrity: ok`；2 个课件 110,402 字节；sha256 生成 |
| 密钥一致性 | 比对哈希（不打印明文） | 包内 FRP token 与云端 frps 一致；TURN secret 与云端 `.env` 一致 |
| 生产未受影响 | 8090/9999 systemd + 公网 `/healthz` | 全部正常，切流前公网仍是云端实例 |

## 五、未验证项（验收前必做）

1. **真实 Windows 安装**：`install.ps1` 只在 PowerShell 解析器里验证过，没有在 Windows 10/11
   上实际执行。首次安装请按包内 README §4 操作，并重点确认：
   - 两个服务 `ClassRoomServer`、`ClassRoomTunnel` 为 Running；
   - 本机 `http://127.0.0.1:8090/healthz` 正常；
   - 云端 `8091/healthz` 正常；
   - 重启 Windows 后两个服务能自动恢复。
2. **生产切流**：没有改动生产 nginx。原计划用独立 19999 端口的临时 nginx 做演练，
   但宝塔的 nginx 是 OpenResty，脱离原 prefix 启动时 `resty.core` 加载失败，演练未完成。
   `switch-to-home.sh` 的自动回滚逻辑因此**未经真实故障注入验证**，只做了静态审查。
   首次切流建议在低峰期执行，并先手工记下 nginx 配置备份路径。
3. **`import-data.ps1` 的实际执行**：语法和回滚逻辑已审查，但没有在 Windows 上跑过真实导入。
   首次导入前先保留云端导出包，导入失败时脚本会尝试恢复原数据库。
4. **音视频路径**：本次只迁移 HTTP/WebSocket。Windows 所在家庭网络到云端 coturn 的
   3478/udp、3478/tcp 连通性，以及实际上课的音视频质量，需要在 Windows 就位后实测。
5. **SSH 备用隧道**：`tools/ssh-tunnel.ps1` 只做了语法检查，未实际拨通。
6. **长期稳定性**：断电、Windows Update 重启、家庭宽带上行波动、frpc 长连接重连等，
   需要至少一周观察。

## 六、迁移步骤

### 0. 前置条件

- Windows 10/11 x64，管理员权限，.NET Framework 4.6.1+（Win10/11 自带 4.8）。
- 解压到固定目录，建议 `D:\ClassRoomServer`，**路径不要带中文和空格**。
- 家庭网络允许出站 TCP 7100（一般默认允许）。
- 云端安全组放行 TCP 7100（已确认放行）。
- 计划一个维护窗口：最终导出会停止云端 `classroom`，切流完成前公网 9999 不可用。

### 1. 云端演练导出（可选，不中断服务）

```bash
ssh root@<PROD_SERVER_IP>
bash /opt/classroom-relay/export-data.sh --out /root/classroom-export-rehearsal
```

在线快照，不会停止服务。确认 tar.gz 和 manifest 正常后可以删除。

### 2. Windows 安装

```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force
cd D:\ClassRoomServer
.\install.ps1
.\status.ps1
```

默认安装 frp 隧道。安装脚本会生成 `.env`、随机 `JWT_SECRET`、写入包内 TURN secret，
注册并启动两个服务。

### 3. 首次数据迁移（维护窗口开始）

云端导出最终快照并保持服务停止：

```bash
bash /opt/classroom-relay/export-data.sh --final --keep-stopped --out /root/classroom-export
```

把 `classroom-data-*.tar.gz` 下载到 Windows，然后：

```powershell
.\import-data.ps1 -Bundle D:\transfer\classroom-data-YYYYmmdd-HHMMSS.tar.gz
```

导入后核对用户数、课程数、课件数。旧登录态会因 `JWT_SECRET` 重新生成而失效，用户重新登录一次即可。

### 4. 隧道连通检查

云端：

```bash
bash /opt/classroom-relay/relay-status.sh
```

应看到 `http://127.0.0.1:8091/healthz` 为 `OK`，且 `env` 为 `production`。
公网 `http://<PROD_SERVER_IP>:8091/healthz` 应当连不上（这是安全设计）。

### 5. 切流

```bash
bash /opt/classroom-relay/switch-to-home.sh
```

脚本会：

1. 校验 8091 健康且是生产实例；
2. 找到指向 `127.0.0.1:8090` 的 nginx 配置并备份；
3. 替换为 `127.0.0.1:8091`；
4. `nginx -t` 通过后 reload；
5. 检查公网 `/healthz`，失败自动回滚。

切流后确认请求确实落到家里：`/healthz` 的 `uptime` 会明显小于云端旧进程。

### 6. 切流后人工验收

- 打开 `http://<PROD_SERVER_IP>:9999`，登录；
- 进教室：发消息、白板、传课件；
- 两个客户端互看视频/听声音（确认 TURN）；
- 刷新页面确认数据仍在；
- 观察云端 `frps.log` 与 Windows `logs\ClassRoomTunnel.*.log` 无连续重连。

### 7. 回滚

```bash
bash /opt/classroom-relay/switch-to-cloud.sh --yes
```

脚本会启动云端 `classroom`（如果已停止）、把 nginx 改回 8090、reload 并检查公网健康。
**注意：切流期间写入家里的数据不会自动回到云端**，见 §七。

## 七、带数据回滚（重要）

如果已经切到家里并产生新数据，直接 `switch-to-cloud.sh` 会回到云端旧数据库，新数据留在
Windows 本地。需要保留时，按下面顺序手工回迁：

1. Windows 停止服务，保证数据库一致：
   ```powershell
   Stop-Service ClassRoomServer
   ```
2. 把 `D:\ClassRoomServer\data\app.db` 和 `data\uploads\` 复制到云端临时目录。
3. 云端停止旧服务并备份：
   ```bash
   systemctl stop classroom
   B=/opt/classroom-backups/rollback-$(date +%Y%m%d-%H%M%S)
   mkdir -p "$B" && cp -a /opt/classroom/data "$B/"
   ```
4. 用 Windows 的 `app.db`、`uploads` 替换 `/opt/classroom/data/` 下对应内容，保持属主为运行用户。
5. 启动并校验：
   ```bash
   systemctl start classroom
   curl -fsS http://127.0.0.1:8090/healthz
   ```
6. 再执行 `switch-to-cloud.sh --yes`。

回迁前先确认云端旧库没有在切流期间被写入；如有，需要人工比对合并。

## 八、安全注意事项

- `tunnel/frpc.toml` 里的 token 等于隧道入口；`config/turn.secret` 等于 TURN 凭据；
  `.env` 里的 `JWT_SECRET` 等于登录签发密钥。三者都不要外传。
- 云端 frps 强制 TLS（`transport.tls.force = true`），frpc 已开启 `transport.tls.enable = true`。
- 云端 8091 只绑 127.0.0.1；Windows 8090 只绑 127.0.0.1。两端都不直接暴露应用端口。
- 不要把包放到公共网盘或代码仓库；安装完成后建议删除传输介质上的 zip。
- Windows 机器建议开启 BitLocker，设置强密码，只给管理员使用。
- 如需局域网内其他设备直连 Windows 服务，把 `.env` 的 `HOST` 改成 `0.0.0.0` 并自行加防火墙规则；
  默认配置下局域网也访问不到。
- 家庭服务器是单点：断电、断网、系统更新重启都会导致公网 502。保持云端旧服务和数据库至少一周。

## 九、日常运维

云端：

```bash
bash /opt/classroom-relay/relay-status.sh          # 中继、8090/8091、公网健康
journalctl -u classroom-relay -n 50 --no-pager     # 中继日志
tail -n 50 /opt/classroom-relay/frps.log
```

Windows：

```powershell
.\status.ps1
.\status.ps1 -Remote
Get-Service ClassRoomServer, ClassRoomTunnel
Get-Content .\logs\ClassRoomServer.err.log -Tail 50
Get-Content .\logs\ClassRoomTunnel.err.log -Tail 50
```

常开设置：

```powershell
.\tools\always-on.ps1
```

还需要：BIOS 开启来电自启、关闭快速启动、设置 Windows Update 使用时段、笔记本保持电源连接。

备份：`data\app.db` + `data\uploads\`。复制前停止服务，或用 `sqlite3 app.db ".backup ..."` 做在线备份。

## 十、故障排查

| 现象 | 优先检查 | 处理 |
|---|---|---|
| 公网 9999 502 | 云端 `relay-status.sh`、Windows `status.ps1` | 先看 8091 是否通，再看 frpc/SSH 服务 |
| 8091 不通 | `frps.log`、Windows tunnel 日志 | 确认 7100 可达、token 一致、Windows 出站正常、没有第二个 frpc 抢占同名 proxy |
| 本机 8090 不通 | `ClassRoomServer` 服务、err 日志 | `.env` 缺 `JWT_SECRET`、端口被占用、数据库损坏 |
| 登录后立刻掉线 | 浏览器 Console、服务端日志 | `ALLOWED_ORIGINS` 是否包含实际访问地址 |
| 能上课但无音视频 | 云端 coturn、3478/udp、3478/tcp | 确认 `.env` 的 TURN_HOST/TURN_SECRET 与云端一致 |
| 上传大文件失败 | nginx `client_max_body_size`、`MAX_UPLOAD_MB` | 云端 60m、应用 50MB |
| 安装脚本被执行策略拦截 | PowerShell | `Set-ExecutionPolicy Bypass -Scope Process -Force` |
| 中文乱码 | `.ps1` 是否被改存为 ANSI | 用原包脚本，不要用编辑器另存 |

排障时注意：同一时间只应有一个 frpc 使用 `classroom` 这个 proxy 名。重复连接会报
`proxy [classroom] already exists`，新的客户端会被拒绝。

## 十一、相关文件

- 包内操作手册：`dist/ClassRoomServer-1.1.3-win-x64/README.md`
- 构建脚本：[scripts/build-server-win.mjs](../scripts/build-server-win.mjs)
- 云端模板：[deploy/windows-server/templates/](../deploy/windows-server/templates/)
- 原云端部署说明：[deploy.md](deploy.md)
- 交接文档：[HANDOFF.md](HANDOFF.md)
