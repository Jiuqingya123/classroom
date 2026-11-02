#!/usr/bin/env bash
set -uo pipefail

PORT={{FRP_PORT}}
PUBLIC="${PUBLIC_URL:-http://{{FRP_SERVER}}:9999}"
BASE="${RELAY_DIR:-/opt/classroom-relay}"

echo "== systemd =="
for unit in classroom-relay classroom nginx; do
  printf '%-18s %s\n' "$unit" "$(systemctl is-active "$unit" 2>/dev/null || true)"
done

echo
echo "== listen =="
ss -lntp 2>/dev/null | grep -E ":(${PORT}|8091|8090|9999)\b" || echo "未发现相关监听"

echo
echo "== health =="
for url in "http://127.0.0.1:8091/healthz" "http://127.0.0.1:8090/healthz" "$PUBLIC/healthz"; do
  printf '%-42s ' "$url"
  if body="$(curl -fsS --max-time 5 "$url" 2>/dev/null)"; then
    echo "OK $body"
  else
    echo "FAIL"
  fi
done

echo
echo "== nginx upstream =="
grep -rn --include='*.conf' -E 'proxy_pass[[:space:]]+http://127\.0\.0\.1:809[01]' \
  /www/server/panel/vhost/nginx /etc/nginx 2>/dev/null | grep -v '\.bak' | head -10 || true

echo
echo "== frps log =="
if [[ -f "$BASE/frps.log" ]]; then
  tail -n 15 "$BASE/frps.log"
else
  journalctl -u classroom-relay -n 15 --no-pager 2>/dev/null || true
fi

echo
echo "提示："
echo "  - 8091 有响应 = Windows 应用已通过隧道可达"
echo "  - 8091 不通时，先在 Windows 运行 status.ps1，确认 ClassRoomTunnel 为 Running"
echo "  - nginx 仍指向 8090 时，公网访问的是云端旧服务"
