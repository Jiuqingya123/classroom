# 公开版脱敏说明

本副本用于公开发布，相对完整版做了以下处理。源码逻辑未做任何改动。

## 1. 生产服务器地址

公网 IP 全部替换为占位符 `<PROD_SERVER_IP>`，共 13 个文件：部署文档、部署脚本、
`package.json` 的 remote 调试脚本，以及 `apps/desktop/.env.production`。

服务器内网网卡地址（NAT 后方的私有 IP）替换为 `<PROD_SERVER_PRIVATE_IP>`，涉及
`docs/deploy.md`、`docs/HANDOFF.md` 中的 coturn 配置示例。

> 部署或重新打包前请把占位符改回自己的地址；重打包桌面端时若不改，
> `MAIN_VITE_SERVER_URL` 为空会让客户端默认连 `http://localhost:8080`。

## 2. 个人域名

部署文档中提及的站点域名替换为 `<YOUR_DOMAIN>`（`docs/deploy.md`）。

## 3. 运行时数据库

删除了 `packages/server/_memory_`。该文件是本地开发时产生的 SQLite 数据库，
含真实用户账号、密码哈希、手机号、课程与刷新令牌，不适合公开。

服务端启动时会依据 `packages/server/src/db/migrations/` 自动建表并应用迁移，
删除后从空库开始，不影响运行。该文件名已加入 `.gitignore`。

## 4. 验收截图

删除了 `docs/screenshots/`。截图里可能直接显示服务器地址与课堂内容，无法逐张核对。
README 中对应的引用已改为说明文字。

## 5. 其他

`.env.example` 中的 `JWT_SECRET`、LCIC 密钥等均为空值或示例占位符，请按文件内注释
在部署时自行生成并填写。腾讯云 LCIC 密钥只应放环境变量，不要提交到仓库。
