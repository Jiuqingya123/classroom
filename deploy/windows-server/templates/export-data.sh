#!/usr/bin/env bash
set -euo pipefail
umask 077

DATA_DIR="${DATA_DIR:-/opt/classroom/data}"
DB="$DATA_DIR/app.db"
OUT="${OUT_DIR:-/root/classroom-export}"
FINAL=0
KEEP_STOPPED=0
RESTART=0
WORK=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --final) FINAL=1; shift ;;
    --keep-stopped) KEEP_STOPPED=1; shift ;;
    --out)
      [[ $# -ge 2 ]] || { echo "--out 需要目录参数"; exit 2; }
      OUT="$2"; shift 2 ;;
    -h|--help)
      echo "用法：bash export-data.sh [--final] [--keep-stopped] [--out DIR]"
      echo "  --final        先停止 classroom，导出后自动重启"
      echo "  --keep-stopped 配合 --final，导出后保持停止（用于切流）"
      exit 0 ;;
    *) echo "未知参数：$1"; exit 2 ;;
  esac
done

if [[ ${EUID} -ne 0 ]]; then
  echo "请用 root 运行：sudo bash $0"
  exit 1
fi
if [[ ! -f "$DB" ]]; then
  echo "找不到数据库：$DB"
  exit 1
fi

cleanup() {
  if [[ -n "$WORK" && -d "$WORK" ]]; then rm -rf "$WORK"; fi
  if [[ $RESTART -eq 1 ]]; then
    echo "重新启动 classroom..."
    systemctl start classroom || true
  fi
}
trap cleanup EXIT

mkdir -p "$OUT"
TS="$(date +%Y%m%d-%H%M%S)"
NAME="classroom-data-$TS"
WORK="$(mktemp -d "$OUT/.work-XXXXXX")"
STAGE="$WORK/$NAME"
mkdir -p "$STAGE"

if [[ $FINAL -eq 1 ]]; then
  echo "停止 classroom 以保证数据库与课件一致..."
  systemctl stop classroom
  RESTART=1
  if [[ $KEEP_STOPPED -eq 1 ]]; then
    RESTART=0
    echo "导出后保持 classroom 停止（--keep-stopped）"
  fi
fi

echo "生成数据库快照..."
if command -v sqlite3 >/dev/null 2>&1; then
  # 云端 sqlite3 3.26 不支持 VACUUM INTO，.backup 走在线备份 API，同样是一致快照
  sqlite3 "$DB" ".timeout 5000" ".backup '$STAGE/app.db'"
else
  node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec(\"VACUUM INTO '\"+process.argv[2]+\"'\");" "$DB" "$STAGE/app.db"
fi

echo "复制课件..."
if [[ -d "$DATA_DIR/uploads" ]]; then
  cp -a "$DATA_DIR/uploads" "$STAGE/uploads"
else
  mkdir -p "$STAGE/uploads"
fi

INTEGRITY="unknown"
if command -v sqlite3 >/dev/null 2>&1; then
  INTEGRITY="$(sqlite3 "$STAGE/app.db" 'PRAGMA integrity_check;')"
  if [[ "$INTEGRITY" != "ok" ]]; then
    echo "快照完整性检查失败：$INTEGRITY"
    exit 1
  fi
fi

{
  echo "created: $(date -Is)"
  echo "source_host: $(hostname)"
  echo "db_sha256: $(sha256sum "$STAGE/app.db" | awk '{print $1}')"
  echo "uploads_files: $(find "$STAGE/uploads" -type f | wc -l | tr -d ' ')"
  echo "uploads_bytes: $(du -sb "$STAGE/uploads" | awk '{print $1}')"
  echo "sqlite_integrity: $INTEGRITY"
} > "$STAGE/manifest.txt"

echo "打包..."
tar -czf "$OUT/$NAME.tar.gz" -C "$WORK" "$NAME"
sha256sum "$OUT/$NAME.tar.gz" > "$OUT/$NAME.tar.gz.sha256"
SIZE="$(du -h "$OUT/$NAME.tar.gz" | awk '{print $1}')"

echo
echo "导出完成：$OUT/$NAME.tar.gz ($SIZE)"
cat "$OUT/$NAME.tar.gz.sha256"
echo
echo "把这个 tar.gz 传到 Windows，然后运行："
echo "  .\\import-data.ps1 -Bundle D:\\transfer\\$NAME.tar.gz"
if [[ $FINAL -eq 1 && $KEEP_STOPPED -eq 1 ]]; then
  echo
  echo "classroom 服务当前保持停止；切流完成后再决定是否启动。"
fi
