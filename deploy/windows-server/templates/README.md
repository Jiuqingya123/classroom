# ClassRoom Server {{VERSION}} - Windows 部署包

构建时间：{{BUILD_TIME}}

这个包把 ClassRoom 教学平台服务端跑在家里的 Windows 电脑上，由云服务器
`{{FRP_SERVER}}` 负责公网入口和反向隧道。家庭宽带不需要任何入站端口。

## 1. 包内结构

```
ClassRoomServer-{{VERSION}}-win-x64/
  app/server.mjs              服务端单文件 bundle（Node 24）
  app/migrations/*.sql        数据库迁移
  node/node.exe               Node 24 运行时
  tunnel/frpc.exe             frp 客户端
  tunnel/frpc.toml            隧道配置（含 token，勿外传）
  service/ClassRoomServer.exe WinSW 服务包装器
  service/ClassRoomTunnel.exe WinSW 服务包装器
  config/.env.example         配置模板
  config/turn.secret          TURN 共享密钥（构建时从云端读取）
  data/                       数据库与课件（运行时生成）
  logs/                       日志
  tools/ssh-tunnel.ps1        SSH 备用隧道
  tools/always-on.ps1         常开电源设置
  tools/db-check.mjs          数据库完整性校验
  relay-linux/                云端中继文件（frps + 脚本）
  install.ps1                 安装
  uninstall.ps1               卸载
  status.ps1                  状态检查
  import-data.ps1             导入云端数据
  start-console.cmd           前台调试启动
  README.md                   本文件
```

## 2. 架构与端口

```
浏览器 / 桌面端 / Android
        |
        | http://{{FRP_SERVER}}:9999
        v
云服务器 nginx :9999
        |
        | 127.0.0.1:8091（仅回环）
        v
frps :{{FRP_PORT}}  <==== 反向隧道 ====  frpc（Windows，出站连接）
                                              |
                                              v
                                     ClassRoom 127.0.0.1:8090
```

| 位置 | 端口 | 用途 | 是否对公网开放 |
| --- | --- | --- | --- |
| 云服务器 | 9999 | 平台主入口（nginx） | 是 |
| 云服务器 | {{FRP_PORT}} | frp 控制端口 | 是（已确认安全组放行） |
| 云服务器 | 8091 | 隧道落地端口 | 否，只绑 127.0.0.1 |
| 云服务器 | 3478 | coturn（音视频中继） | 是 |
| Windows | 8090 | 服务端 | 否，只绑 127.0.0.1 |

音视频媒体走 WebRTC 直连或云端 coturn，不经过 frp 隧道。家庭宽带上行带宽
决定同时上课的流畅度；5 人以内一般够用。

> 服务器上 7000 端口已经有一个别的 frps 在运行（2026-08-13 启动）。本包
> 刻意使用 7100，不会改动或重启那个服务。`relay-linux/install-relay.sh`
> 检测到端口冲突会直接退出。

## 3. 云服务器：安装中继（一次性）

把 `relay-linux` 整个目录传到云服务器，然后以 root 执行：

```bash
scp -r relay-linux root@{{FRP_SERVER}}:/tmp/classroom-relay
ssh root@{{FRP_SERVER}} "bash /tmp/classroom-relay/install-relay.sh"
```

脚本会：

- 把 `frps` 安装到 `/opt/classroom-relay/`
- 写入 `/opt/classroom-relay/frps.toml`（权限 600）
- 把 `relay-status.sh`、`switch-to-home.sh`、`switch-to-cloud.sh`、`export-data.sh`
  安装到 `/opt/classroom-relay/`（权限 755，重启不丢）
- 注册并启动 `classroom-relay.service`
- 监听 `0.0.0.0:{{FRP_PORT}}`；隧道端口只绑 `127.0.0.1:8091`

检查：

```bash
ssh root@{{FRP_SERVER}} "bash /opt/classroom-relay/relay-status.sh"
```

如果安全组后来收紧了，需要在阿里云控制台放行 **TCP {{FRP_PORT}}**。
当前这台机器已确认放行（2026-10-28 实测）。

## 4. Windows：安装

前置条件：

- Windows 10/11 x64，管理员权限
- .NET Framework 4.6.1+（Windows 10/11 自带 4.8，无需另装）
- 不需要单独安装 Node，包内已带 Node 24

1. 把 zip 解压到固定目录，建议 `D:\ClassRoomServer`（路径不要带中文和空格）。
2. 右键“以管理员身份运行” PowerShell，进入目录。
3. 执行：

```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force
.\install.ps1
```

默认安装 frp 隧道。安装脚本会：

- 生成 `.env`，写入随机 `JWT_SECRET` 和包内 `config\turn.secret`
- 把 `.env` 权限限制为 SYSTEM 读取、Administrators 完全控制
- 注册 `ClassRoomServer` 服务并等待 `/healthz` 通过
- 注册 `ClassRoomTunnel` 服务（frpc）
- 检查本机 8090 和 frpc 日志

常用参数：

```powershell
.\install.ps1 -Tunnel frp                  # 默认
.\install.ps1 -Tunnel none                 # 只装本机服务，不建隧道
.\install.ps1 -Tunnel ssh -SshServer {{FRP_SERVER}} -SshUser root -SshKey D:\keys\id_ed25519
.\install.ps1 -TurnSecret "xxxx"           # 覆盖包内 TURN 密钥
```

安装完成后：

```powershell
.\status.ps1
.\status.ps1 -Remote
```

`status.ps1` 只检查本机和隧道配置；隧道是否真正到云端，以云端
`relay-status.sh` 的 8091 健康检查为准。

### 常开设置

服务器需要长期在线：

```powershell
.\tools\always-on.ps1
```

它会关闭交流供电下的睡眠/休眠。还需要：

- BIOS/UEFI 开启“来电自启 / AC Power Loss -> Power On”
- 关闭 Windows 自动重启安装更新，或设置使用时段
- 笔记本保持电源适配器连接
- 关闭快速启动，避免异常断电后网络初始化异常

## 5. 首次数据迁移

在云服务器上导出（会短暂停止云端服务，保证数据库和课件一致）：

```bash
ssh root@{{FRP_SERVER}}
bash /opt/classroom-relay/export-data.sh --final --keep-stopped --out /root/classroom-export
```

产物：

```
/root/classroom-export/classroom-data-YYYYmmdd-HHMMSS.tar.gz
/root/classroom-export/classroom-data-YYYYmmdd-HHMMSS.tar.gz.sha256
```

把 tar.gz 下载到 Windows（WinSCP 或 `scp`），然后：

```powershell
.\import-data.ps1 -Bundle D:\transfer\classroom-data-YYYYmmdd-HHMMSS.tar.gz
```

导入脚本会：

- 停止 `ClassRoomServer`
- 备份现有 `data\app.db` 和 `data\uploads` 到 `data\backup\<时间戳>\`
- 校验源数据库 `PRAGMA integrity_check`
- 替换数据库和课件
- 启动服务并等待健康检查
- 失败时自动恢复备份

只导入数据库：

```powershell
.\import-data.ps1 -Db D:\transfer\app.db
```

只导入课件（目录、zip、tar、tar.gz 均可）：

```powershell
.\import-data.ps1 -Uploads D:\transfer\uploads
```

> 迁移后旧登录态可能失效，用户重新登录一次即可。

## 6. 切流与回滚

前提：Windows 上 `status.ps1` 显示两个服务 Running，云端
`relay-status.sh` 显示 `http://127.0.0.1:8091/healthz` 为 OK。

切到家庭服务器：

```bash
ssh root@{{FRP_SERVER}} "bash /opt/classroom-relay/switch-to-home.sh"
```

脚本会先验证 8091，备份 nginx 配置，把 `127.0.0.1:8090` 改成
`127.0.0.1:8091`，`nginx -t` 后 reload，再检查公网 `/healthz`。
任何一步失败都会自动回滚。

回滚到云端：

```bash
ssh root@{{FRP_SERVER}} "bash /opt/classroom-relay/switch-to-cloud.sh --yes"
```

注意：切回云端不会把家庭服务器在切流期间写入的数据带回来。如果这些数据
需要保留，先在 Windows 上停止 `ClassRoomServer`，复制 `data` 目录，再按
“数据迁移”的反向流程导入云端。`--yes` 是防误触确认。

切流后建议人工验证：

- 浏览器打开 `http://{{FRP_SERVER}}:9999`，登录
- 进入一间教室，发消息、开白板、传课件
- 两个客户端互看视频/听声音（确认 TURN 正常）
- 刷新页面，确认数据仍在

## 7. SSH 备用隧道

如果 7100 被安全组封了，或者不想用 frp，可以走 SSH 22 端口：

```powershell
.\install.ps1 -Tunnel ssh `
  -SshServer {{FRP_SERVER}} `
  -SshUser root `
  -SshKey D:\keys\classroom_tunnel
```

要求：

- 云服务器 sshd 允许 TCP 转发（默认允许）
- 私钥能登录，且权限已收紧（安装脚本会尝试 `icacls`）
- Windows 已安装 OpenSSH 客户端（安装脚本会尝试自动安装）

SSH 隧道只把云端 `127.0.0.1:8091` 转发到本机 8090，不占新端口。
断线后 `tools\ssh-tunnel.ps1` 每 5 秒重连。

建议给隧道单独生成一把密钥，并在云端 `~/.ssh/authorized_keys` 里限制：

```
restrict,port-forwarding,permitlisten="127.0.0.1:8091" ssh-ed25519 AAAA... classroom-tunnel
```

这样这把密钥不能开 shell，只能绑定 8091。

## 8. 日常运维

```powershell
.\status.ps1                 # 服务、健康、日志
.\status.ps1 -Remote         # 额外检查公网入口
.\start-console.cmd          # 前台调试（先停止服务，否则端口冲突）
```

服务管理：

```powershell
Get-Service ClassRoomServer, ClassRoomTunnel
Restart-Service ClassRoomServer
Restart-Service ClassRoomTunnel
```

日志：

```
logs\ClassRoomServer.out.log
logs\ClassRoomServer.err.log
logs\ClassRoomTunnel.out.log
logs\ClassRoomTunnel.err.log
logs\ssh-tunnel.log
```

备份：

- `data\app.db` 是 SQLite 数据库
- `data\uploads\` 是课件
- 建议每天复制 `data` 到另一块盘或 NAS；复制前先停止服务，或使用
  `sqlite3 app.db ".backup backup.db"` 做在线备份

## 9. 安全

- `config\turn.secret`、`.env`、`tunnel\frpc.toml` 都含密钥，不要发群、不要传网盘。
- 整个包只应放在你自己的机器上；泄露 `frpc.toml` 等于泄露隧道入口。
- 云端 frps 已强制 TLS，隧道端口只绑 127.0.0.1。
- Windows 只监听 127.0.0.1:8090，局域网其他机器也访问不到；如需局域网直连，
  把 `.env` 的 `HOST` 改成 `0.0.0.0` 并自行加防火墙规则。
- 定期更新 Windows、Node 运行时和 frp；升级前先备份 `data`。
- 家庭服务器是单点：断电、断网、系统更新重启都会导致公网 502。准备回滚命令，
  并保持云端旧服务和数据库至少一周。

## 10. 故障排查

| 现象 | 检查 | 处理 |
| --- | --- | --- |
| 公网 9999 502 | 云端 `relay-status.sh`；Windows `status.ps1` | 先看 8091 是否通，再看 frpc/SSH 服务 |
| 8091 不通 | frpc 日志、云端 frps 日志 | 确认 7100 可达、token 一致、Windows 出站正常 |
| 本机 8090 不通 | `ClassRoomServer` 服务、err 日志 | 常见为 `.env` 缺 `JWT_SECRET`、端口被占用 |
| 登录后立刻掉线 | 浏览器 Console、服务端日志 | 检查 `ALLOWED_ORIGINS` 是否包含实际访问地址 |
| 能上课但没声音/视频 | 云端 coturn、3478/udp | 确认 `.env` 的 TURN_HOST/TURN_SECRET 与云端一致 |
| 上传大文件失败 | nginx `client_max_body_size`、`MAX_UPLOAD_MB` | 两边都调到 60MB/50MB 以上 |
| 服务启动即退出 | `logs\ClassRoomServer.err.log` | 迁移目录不完整、数据库损坏、`JWT_SECRET` 太短 |
| 安装脚本报执行策略 | PowerShell 提示 | `Set-ExecutionPolicy Bypass -Scope Process -Force` |
| 中文乱码 | `.ps1` 是否被编辑器改存为 ANSI | 用 Windows PowerShell 5.1 直接运行原包脚本 |

云端快速诊断：

```bash
bash /opt/classroom-relay/relay-status.sh
journalctl -u classroom-relay -n 50 --no-pager
tail -n 50 /opt/classroom-relay/frps.log
```

Windows 快速诊断：

```powershell
.\status.ps1
Get-Content .\logs\ClassRoomServer.err.log -Tail 50
Get-Content .\logs\ClassRoomTunnel.err.log -Tail 50
```

## 11. 卸载

```powershell
.\uninstall.ps1              # 卸载服务，保留数据和配置
.\uninstall.ps1 -RemoveConfig # 额外删除 .env 和 turn.secret
```

数据库和课件始终保留在 `data\`，脚本不会删除。

云端中继卸载（确认不再需要时）：

```bash
systemctl disable --now classroom-relay
rm -f /etc/systemd/system/classroom-relay.service
systemctl daemon-reload
# /opt/classroom-relay 可自行备份后删除
```

## 12. 迁移检查清单

- [ ] 云端 `classroom-relay` 为 active，7100 在监听
- [ ] Windows 两个服务为 Running，本机 `/healthz` 正常
- [ ] 云端 `127.0.0.1:8091/healthz` 正常
- [ ] 数据已导入，用户数/课程数/课件数对得上
- [ ] 切流后公网首页、登录、教室、白板、文件上传、音视频都验证过
- [ ] 已记录回滚命令和本次 nginx 备份路径
- [ ] 云端旧服务与数据库保留至少一周
- [ ] Windows 已设置不休眠、来电自启
