#!/bin/bash
# ClassRoom 服务端部署脚本（在目标服务器上以 root 执行）
# 幂等：可反复运行，不会重复生成密钥，也不会覆盖已有数据库。
set -euo pipefail

APP_DIR=/opt/classroom
PORT=8090
PUBLIC_HOST="${PUBLIC_HOST:-<PROD_SERVER_IP>}"
PUBLIC_PORT="${PUBLIC_PORT:-9999}"
NGINX_CONF=/www/server/panel/vhost/nginx/classroom_${PUBLIC_HOST}.conf
SERVICE=/etc/systemd/system/classroom.service

cd "$APP_DIR"

echo "==> 1/6 生成 .env（已存在则跳过密钥）"
if [ ! -f .env ]; then
  JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')
  TURN_SECRET=$(openssl rand -hex 24)
  cat > .env <<EOF
NODE_ENV=production
PORT=${PORT}
HOST=127.0.0.1
LOG_LEVEL=info

DB_PATH=${APP_DIR}/data/app.db
DATA_DIR=${APP_DIR}/data

JWT_SECRET=${JWT_SECRET}
ACCESS_TTL_SECONDS=900
RTC_TTL_SECONDS=7200
REFRESH_TTL_DAYS=7

ALLOWED_ORIGINS=http://${PUBLIC_HOST}:${PUBLIC_PORT},http://${PUBLIC_HOST},http://localhost:5273,http://localhost,https://localhost,capacitor://localhost,file://,null
PUBLIC_BASE_URL=http://${PUBLIC_HOST}:${PUBLIC_PORT}

TURN_HOST=${PUBLIC_HOST}
TURN_PORT=3478
TURN_TLS_PORT=5349
TURN_REALM=classroom
TURN_SECRET=${TURN_SECRET}
TURN_TTL_SECONDS=3600

MAX_PARTICIPANTS=5
MAX_UPLOAD_MB=50
EOF
  chmod 600 .env
  echo "    .env 已生成（密钥随机）"
else
  echo "    .env 已存在，保留原密钥"
fi

mkdir -p "$APP_DIR/data/uploads"

echo "==> 2/6 写入 systemd 单元"
cat > "$SERVICE" <<EOF
[Unit]
Description=ClassRoom server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
ExecStart=${APP_DIR}/node_modules/.bin/tsx packages/server/src/index.ts
Restart=always
RestartSec=3
# 这台机器只有 1.8G 内存，还跑着 docker 和宝塔，给进程划个上限防止 OOM 波及别人
MemoryMax=800M
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload

echo "==> 3/6 写入 nginx vhost（按 Host 精确匹配，不影响你已有的站点）"
cat > "$NGINX_CONF" <<EOF
# ClassRoom 反向代理。用 server_name 精确匹配 IP，默认站点（server_name _）保持原样。
server
{
    listen 80;
    listen ${PUBLIC_PORT};
    server_name ${PUBLIC_HOST};

    # 应用侧 MAX_UPLOAD_MB=50，留余量给 multipart 头
    client_max_body_size 60m;

    # 课程页面图片走签名 URL，可以放心让浏览器缓存
    location /files/ {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        expires 1h;
    }

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        # 课堂上 socket 会长连，别让 nginx 60 秒就掐断
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}
EOF

echo "==> 4/6 校验并 reload nginx"
if nginx -t 2>&1 | grep -q "successful"; then
  nginx -s reload
  echo "    nginx 已 reload"
else
  echo "    nginx 配置校验失败，回滚该 vhost"
  rm -f "$NGINX_CONF"
  nginx -t
  exit 1
fi

echo "==> 5/6 启动服务"
systemctl enable classroom >/dev/null 2>&1 || true
systemctl restart classroom
sleep 4
systemctl is-active classroom

echo "==> 6/6 健康检查"
for i in $(seq 1 15); do
  if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    echo "    本地 127.0.0.1:${PORT} OK"
    break
  fi
  sleep 2
done
curl -sS "http://127.0.0.1:${PORT}/healthz" || true
echo
curl -sS -o /dev/null -w "    经 nginx http://${PUBLIC_HOST}/healthz -> %{http_code}\n" "http://${PUBLIC_HOST}/healthz" || true
