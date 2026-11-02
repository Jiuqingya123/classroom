"""把仓库打成「只含源码」的压缩包，用于交接给其他人 / 另一个 AI。

排除一切能从源码重建或本机私有的东西：node_modules、构建产物、数据库、.env、密钥。

    python scripts/pack-source.py                      # 输出到桌面
    python scripts/pack-source.py -o D:/out/src.zip    # 指定输出路径
"""
from __future__ import annotations

import argparse
import os
import sys
import time
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROJECT = 'classroom'

# 目录名命中即整枝跳过
SKIP_DIRS = {
    'node_modules',
    '.git',
    'dist',          # electron-builder 产物
    'release',       # 旧版打包目录
    'out',           # electron-vite 产物
    'data',          # SQLite + 上传文件
    '.workbuddy',
    '.vite',
    'coverage',
    '__pycache__',
    '.venv',
}

# 文件名 / 后缀命中即跳过
SKIP_SUFFIX = (
    '.log',
    '.db', '.db-shm', '.db-wal',
    '.exe', '.dmg', '.zip', '.blockmap', '.AppImage', '.tar.gz',
    '.pyc', '.ds_store',
)
SKIP_NAMES = {'.env', '.env.local', '.DS_Store', 'builder-debug.yml'}


def should_skip_dir(name: str) -> bool:
    # .stale-xxx 是打包时删不掉的残留目录
    return name in SKIP_DIRS or name.startswith('.stale-')


def should_skip_file(name: str) -> bool:
    if name in SKIP_NAMES:
        return True
    if name.startswith('._'):  # macOS 资源叉
        return True
    if name.endswith('.pem') or name.endswith('.key'):  # 私钥绝不外带
        return True
    lower = name.lower()
    return any(lower.endswith(s) for s in SKIP_SUFFIX)


def collect() -> list[tuple[str, str]]:
    entries: list[tuple[str, str]] = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = sorted(d for d in dirnames if not should_skip_dir(d))
        rel_dir = os.path.relpath(dirpath, ROOT)
        for fn in sorted(filenames):
            if should_skip_file(fn):
                continue
            full = os.path.join(dirpath, fn)
            rel = fn if rel_dir == '.' else os.path.join(rel_dir, fn)
            entries.append((full, rel.replace(os.sep, '/')))
    return entries


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('-o', '--out', default=None, help='输出 zip 路径')
    args = ap.parse_args()

    stamp = time.strftime('%Y%m%d', time.localtime())
    out = args.out or os.path.join(os.path.expanduser('~'), 'Desktop', f'{PROJECT}-src-{stamp}.zip')
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)

    entries = collect()
    total = 0
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for full, rel in entries:
            zf.write(full, f'{PROJECT}/{rel}')
            total += os.path.getsize(full)

    size = os.path.getsize(out)
    print(f'文件数 {len(entries)}，原始 {total / 1024 / 1024:.2f} MB → 压缩后 {size / 1024 / 1024:.2f} MB')
    print(f'输出 {out}')

    # 自检：确认没有把不该带的东西打进去（.env.example 是模板，要带）
    bad = [
        r for _, r in entries
        if '/node_modules/' in r
        or r.startswith('node_modules/')
        or os.path.basename(r) in {'.env', '.env.local'}
    ]
    if bad:
        print(f'!! 异常内容 {bad[:5]}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
