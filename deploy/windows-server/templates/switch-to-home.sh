#!/usr/bin/env bash
set -euo pipefail

PUBLIC="${PUBLIC_URL:-http://{{FRP_SERVER}}:9999}"
BASE="${RELAY_DIR:-/opt/classroom-relay}"
STATE="$BASE/state"
BACKUPS="$BASE/backups"
SEARCH_DIRS=(/www/server/panel/vhost/nginx /etc/nginx)

if [[ ${EUID} -ne 0 ]]; then
  echo "请用 root 运行：sudo bash $0"
  exit 1
fi

mkdir -p "$STATE" "$BACKUPS"

echo "==> 1/4 检查家庭服务器隧道"
TUNNEL_HEALTH="$(curl -fsS --max-time 5 http://127.0.0.1:8091/healthz 2>/dev/null || true)"
if [[ "$TUNNEL_HEALTH" != *'"ok":true'* || "$TUNNEL_HEALTH" != *'"env":"production"'* ]]; then
  echo "隧道未就绪或不是生产实例：${TUNNEL_HEALTH:-无响应}"
  echo "请先在 Windows 上运行 status.ps1，并确认 ClassRoomTunnel 服务为 Running。"
  echo "云端可用 bash $BASE/relay-status.sh 查看 frps 日志。"
  exit 1
fi
echo "    隧道正常：$TUNNEL_HEALTH"

echo "==> 2/4 定位 nginx 配置"
mapfile -t CONFIGS < <(
  grep -rl --include='*.conf' -E 'proxy_pass[[:space:]]+http://127\.0\.0\.1:8090' \
    "${SEARCH_DIRS[@]}" 2>/dev/null | grep -v '\.bak' | sort -u
)
if [[ ${#CONFIGS[@]} -eq 0 ]]; then
  echo "未找到指向 127.0.0.1:8090 的 nginx 配置，请手动确认。"
  exit 1
fi
if [[ ${#CONFIGS[@]} -gt 1 ]]; then
  echo "找到多个候选配置，请手动指定后重试："
  printf '  %s\n' "${CONFIGS[@]}"
  exit 1
fi
CONF="${CONFIGS[0]}"

if grep -q '127\.0\.0\.1:8091' "$CONF"; then
  echo "    已经是家庭服务器模式：$CONF"
  exit 0
fi

echo "    配置：$CONF"

echo "==> 3/4 备份并切换"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP="$BACKUPS/$(basename "$CONF").$TS"
cp -a "$CONF" "$BACKUP"
echo "    备份：$BACKUP"

sed -i 's#127\.0\.0\.1:8090#127.0.0.1:8091#g' "$CONF"

TEST_LOG="/tmp/classroom-nginx-test.$$.log"
if ! nginx -t >"$TEST_LOG" 2>&1; then
  echo "    nginx 配置检查失败，已回滚："
  cat "$TEST_LOG"
  cp -a "$BACKUP" "$CONF"
  exit 1
fi
if ! nginx -s reload; then
  echo "    nginx reload 失败，已回滚"
  cp -a "$BACKUP" "$CONF"
  nginx -s reload || true
  exit 1
fi
sleep 2

echo "==> 4/4 公网健康检查"
if ! curl -fsS --max-time 10 "$PUBLIC/healthz" >/dev/null; then
  echo "    公网检查失败，自动回滚到云端服务"
  cp -a "$BACKUP" "$CONF"
  nginx -s reload || true
  exit 1
fi

echo "home" > "$STATE/mode"
echo "    $PUBLIC/healthz 正常"
echo
echo "已切换到家庭服务器。"
echo "回滚：bash $(dirname "$0")/switch-to-cloud.sh --yes"
