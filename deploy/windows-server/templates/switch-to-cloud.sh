#!/usr/bin/env bash
set -euo pipefail

PUBLIC="${PUBLIC_URL:-http://{{FRP_SERVER}}:9999}"
BASE="${RELAY_DIR:-/opt/classroom-relay}"
STATE="$BASE/state"
BACKUPS="$BASE/backups"
SEARCH_DIRS=(/www/server/panel/vhost/nginx /etc/nginx)
CONFIRM="${1:-}"

if [[ ${EUID} -ne 0 ]]; then
  echo "请用 root 运行：sudo bash $0 --yes"
  exit 1
fi

if [[ "$CONFIRM" != "--yes" ]]; then
  echo "注意：切回云端后，家庭服务器在切流期间写入的数据库和课件不会自动同步回云端。"
  echo "如果这些数据需要保留，请先停止家庭服务并复制其 data 目录，再导入云端数据库。"
  echo
  echo "确认切回请执行：bash $0 --yes"
  exit 2
fi

mkdir -p "$STATE" "$BACKUPS"

echo "==> 1/4 启动云端服务"
systemctl start classroom
CLOUD_HEALTH=""
for _ in $(seq 1 30); do
  CLOUD_HEALTH="$(curl -fsS --max-time 2 http://127.0.0.1:8090/healthz 2>/dev/null || true)"
  if [[ "$CLOUD_HEALTH" == *'"ok":true'* && "$CLOUD_HEALTH" == *'"env":"production"'* ]]; then
    break
  fi
  sleep 1
done
if [[ "$CLOUD_HEALTH" != *'"ok":true'* || "$CLOUD_HEALTH" != *'"env":"production"'* ]]; then
  echo "云端 127.0.0.1:8090 未就绪或不是生产实例：${CLOUD_HEALTH:-无响应}"
  journalctl -u classroom -n 30 --no-pager || true
  exit 1
fi
echo "    云端服务正常：$CLOUD_HEALTH"

echo "==> 2/4 定位 nginx 配置"
mapfile -t CONFIGS < <(
  grep -rl --include='*.conf' -E 'proxy_pass[[:space:]]+http://127\.0\.0\.1:8091' \
    "${SEARCH_DIRS[@]}" 2>/dev/null | grep -v '\.bak' | sort -u
)
if [[ ${#CONFIGS[@]} -eq 0 ]]; then
  echo "未找到指向 127.0.0.1:8091 的配置，当前可能已经是云端模式。"
  exit 0
fi
if [[ ${#CONFIGS[@]} -gt 1 ]]; then
  echo "找到多个候选配置，请手动指定后重试："
  printf '  %s\n' "${CONFIGS[@]}"
  exit 1
fi
CONF="${CONFIGS[0]}"

echo "==> 3/4 备份并切回"
TS="$(date +%Y%m%d-%H%M%S)"
BACKUP="$BACKUPS/$(basename "$CONF").$TS"
cp -a "$CONF" "$BACKUP"
echo "    备份：$BACKUP"

sed -i 's#127\.0\.0\.1:8091#127.0.0.1:8090#g' "$CONF"

TEST_LOG="/tmp/classroom-nginx-test.$$.log"
if ! nginx -t >"$TEST_LOG" 2>&1; then
  echo "    nginx 配置检查失败，已回滚："
  cat "$TEST_LOG"
  cp -a "$BACKUP" "$CONF"
  exit 1
fi
nginx -s reload
sleep 2

echo "==> 4/4 公网健康检查"
if ! curl -fsS --max-time 10 "$PUBLIC/healthz" >/dev/null; then
  echo "    公网检查失败，自动回滚到家庭服务器"
  cp -a "$BACKUP" "$CONF"
  nginx -s reload || true
  exit 1
fi

echo "cloud" > "$STATE/mode"
echo "    $PUBLIC/healthz 正常"
echo
echo "已切回云端服务器。"
echo "如需停止云端服务释放内存：systemctl stop classroom（此时公网将不可用）"
