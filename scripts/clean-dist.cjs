/**
 * 打包前清理上一次的中间目录。
 *
 * electron-builder 在 Windows 上是「解压到 xxx.tmp → 重命名成 xxx」，
 * 如果 xxx 已存在，重命名会 EPERM，它退化成「复制 + 删除」，
 * 而这个删除动作在某些安全软件/沙箱下会被拦住，整个打包就失败了。
 * 所以每次打包前先把中间目录挪走，让 dist:win / dist:mac 可以反复执行。
 *
 * 删除失败（安全软件占用、沙箱拦截批量删除）时不 fatal，退化成改名挪开：
 * 目标路径空出来了，打包就能继续，残留目录之后手动清理即可。
 *
 *   node scripts/clean-dist.cjs            # 只清中间目录
 *   node scripts/clean-dist.cjs --all      # 连安装包一起清
 */
const fs = require('node:fs');
const path = require('node:path');

const DIST = path.resolve(__dirname, '..', 'apps', 'desktop', 'dist');
const ALL = process.argv.includes('--all');

if (!fs.existsSync(DIST)) {
  console.log('dist 不存在，无需清理');
  process.exit(0);
}

const KEEP_EXT = new Set(['.exe', '.dmg', '.zip', '.AppImage', '.blockmap', '.yml']);

function sweep(p, label) {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
    return `${label} 已删除`;
  } catch (err) {
    // 删不掉就改名挪开。改名只需要父目录写权限，不会被打断
    const alt = path.join(DIST, `.stale-${label}-${Date.now()}`);
    try {
      fs.renameSync(p, alt);
      return `${label} 删不掉（${err.message.split(';')[0].slice(0, 60)}），已改名挪开：${path.basename(alt)}`;
    } catch (err2) {
      return `${label} 既删不掉也挪不开：${err2.message}`;
    }
  }
}

for (const entry of fs.readdirSync(DIST, { withFileTypes: true })) {
  const p = path.join(DIST, entry.name);
  const isDir = entry.isDirectory();

  if (!ALL && !isDir) continue;
  if (!ALL && !isDir && !KEEP_EXT.has(path.extname(entry.name))) continue;

  console.log(sweep(p, entry.name));
}

// 顺手再试一次清理历史残留（大概率还是删不掉，但不影响本次打包）
for (const name of fs.readdirSync(DIST)) {
  if (!name.startsWith('.stale-')) continue;
  try {
    fs.rmSync(path.join(DIST, name), { recursive: true, force: true, maxRetries: 1 });
  } catch {
    /* 留着，下次再说 */
  }
}
