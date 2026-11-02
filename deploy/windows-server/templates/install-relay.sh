#!/usr/bin/env bash
set -euo pipefail

PORT={{FRP_PORT}}
BASE="${RELAY_DIR:-/opt/classroom-relay}"
UNIT="/etc/systemd/system/classroom-relay.service"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ${EUID} -ne 0 ]]; then
  echo "请用 root 运行：sudo bash $0"
  exit 1
fi
if [[ ! -x "$SRC/frps" ]]; then
  echo "缺少 $SRC/frps"
  exit 1
fi
if [[ ! -f "$SRC/frps.toml" ]]; then
  echo "缺少 $SRC/frps.toml"
  exit 1
fi

if ss -lntH "sport = :$PORT" 2>/dev/null | grep -q .; then
  echo "端口 $PORT 已被占用，为避免影响现有服务，安装中止："
  ss -lntp "sport = :$PORT" || true
  exit 1
fi

mkdir -p "$BASE"
install -m 0755 "$SRC/frps" "$BASE/frps"
sed "s#/opt/classroom-relay#$BASE#g" "$SRC/frps.toml" > "$BASE/frps.toml"
chmod 0600 "$BASE/frps.toml"
for script in relay-status.sh switch-to-home.sh switch-to-cloud.sh export-data.sh; do
  install -m 0755 "$SRC/$script" "$BASE/$script"
done

cat > "$UNIT" <<EOF
[Unit]
Description=ClassRoom frp relay (TCP $PORT)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$BASE
ExecStart=$BASE/frps -c $BASE/frps.toml
Restart=always
RestartSec=5
LimitNOFILE=65535
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$BASE

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable classroom-relay >/dev/null 2>&1
systemctl restart classroom-relay
sleep 1

if ! systemctl is-active --quiet classroom-relay; then
  echo "中继启动失败，最近日志："
  journalctl -u classroom-relay -n 40 --no-pager || true
  exit 1
fi

echo
echo "中继已启动：$BASE"
ss -lntp "sport = :$PORT" || true
echo
echo "控制端口：TCP $PORT（公网需放行；本机安全组已确认放行）"
echo "隧道端口：127.0.0.1:8091（只绑定回环，不对外暴露）"
echo "运维脚本：$BASE/relay-status.sh、switch-to-home.sh、switch-to-cloud.sh、export-data.sh"
echo "下一步：在 Windows 上运行 install.ps1，再运行 $BASE/relay-status.sh 检查。"
