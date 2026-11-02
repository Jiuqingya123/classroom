#!/bin/bash
# 把本地服务端代码推到服务器并重启。
# 只同步源码与配置清单，不动 data/（数据库和上传的文件）。
set -euo pipefail

KEY="${KEY:-}"
HOST="${HOST:-root@<PROD_SERVER_IP>}"
SSH=(ssh -o StrictHostKeyChecking=accept-new)
if [ -n "$KEY" ]; then
  SSH+=(-i "$KEY")
fi

cd "$(dirname "$0")/.."

echo "==> 打包源码"
rm -rf /tmp/deploy && mkdir -p /tmp/deploy/packages
cp tsconfig.base.json /tmp/deploy/
mkdir -p /tmp/deploy/packages/shared /tmp/deploy/packages/server
cp -R packages/shared/src packages/shared/package.json packages/shared/tsconfig.json /tmp/deploy/packages/shared/
cp -R packages/server/src packages/server/package.json packages/server/tsconfig.json /tmp/deploy/packages/server/
cat > /tmp/deploy/package.json <<'EOF'
{
  "name": "classroom-server",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "workspaces": ["packages/shared", "packages/server"],
  "engines": { "node": ">=24" },
  "scripts": {
    "start": "tsx packages/server/src/index.ts",
    "typecheck": "tsc --noEmit -p packages/server/tsconfig.json"
  },
  "devDependencies": { "tsx": "^4.20.0", "typescript": "5.9.3" }
}
EOF
tar czf /tmp/classroom-server.tgz --exclude '._*' --exclude '.DS_Store' -C /tmp/deploy . 2>/dev/null

echo "==> 上传"
"${SSH[@]}" "$HOST" 'mkdir -p /opt/classroom && rm -rf /opt/classroom/packages'
"${SSH[@]}" "$HOST" 'tar xzf - -C /opt/classroom 2>/dev/null' < /tmp/classroom-server.tgz

echo "==> 依赖（无原生模块，秒级完成）"
"${SSH[@]}" "$HOST" 'cd /opt/classroom && npm install --no-audit --no-fund 2>&1 | tail -3'

echo "==> 重启服务"
"${SSH[@]}" "$HOST" 'systemctl restart classroom && sleep 3 && systemctl is-active classroom'

echo "==> 健康检查"
"${SSH[@]}" "$HOST" 'curl -sS http://127.0.0.1:8090/healthz; echo'
