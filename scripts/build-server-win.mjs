import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const NODE_VERSION = '24.22.1';
const FRP_VERSION = '0.71.1';
const WINSW_VERSION = '2.12.0';

const cacheDir = path.join(root, '.cache', 'win-server');
const distDir = path.join(root, 'dist');
const bundleName = `ClassRoomServer-${version}-win-x64`;
const stage = path.join(distDir, bundleName);
const tplDir = path.join(root, 'deploy', 'windows-server', 'templates');
const relaySrc = path.join(root, 'deploy', 'windows-server', 'relay-linux');

const nodeZip = path.join(cacheDir, `node-v${NODE_VERSION}-win-x64.zip`);
const frpWinZip = path.join(cacheDir, `frp_${FRP_VERSION}_windows_amd64.zip`);
const frpLinuxTar = path.join(cacheDir, `frp_${FRP_VERSION}_linux_amd64.tar.gz`);
const winswExe = path.join(cacheDir, `WinSW.NET461-${WINSW_VERSION}.exe`);

function log(msg) { console.log(msg); }
function sh(cmd, args, opts = {}) { return execFileSync(cmd, args, { stdio: 'inherit', ...opts }); }
function download(url, file) {
  if (fs.existsSync(file) && fs.statSync(file).size > 0) { log(`  cached ${path.basename(file)}`); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  log(`  download ${url}`);
  sh('curl', ['--http1.1', '-fL', '--retry', '5', '--retry-all-errors', '--connect-timeout', '20', '-o', `${file}.part`, url]);
  fs.renameSync(`${file}.part`, file);
}
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function render(name, vars) {
  let text = fs.readFileSync(path.join(tplDir, name), 'utf8');
  for (const [key, value] of Object.entries(vars)) text = text.split(`{{${key}}}`).join(String(value));
  return text;
}
function write(file, text, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Windows PowerShell 5.1 只有在 UTF-8 BOM 下才能正确读取中文 .ps1
  const body = file.endsWith('.ps1') && !text.startsWith('\uFEFF') ? `\uFEFF${text}` : text;
  fs.writeFileSync(file, body);
  fs.chmodSync(file, mode);
}
function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

log(`==> ClassRoom Server ${version} Windows package`);
fs.mkdirSync(cacheDir, { recursive: true });
fs.mkdirSync(distDir, { recursive: true });
if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

log('==> 1/6 下载运行时');
download(`https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`, nodeZip);
download(`https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_windows_amd64.zip`, frpWinZip);
download(`https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_amd64.tar.gz`, frpLinuxTar);
download(`https://github.com/winsw/winsw/releases/download/v${WINSW_VERSION}/WinSW.NET461.exe`, winswExe);

log('==> 2/6 校验 Node 下载');
const sums = execFileSync('curl', ['-fsSL', `https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`], { encoding: 'utf8' });
const want = sums.split('\n').find((line) => line.trim().endsWith(`node-v${NODE_VERSION}-win-x64.zip`))?.split(/\s+/)[0];
if (!want) throw new Error('找不到 Node win-x64 校验和');
const got = sha256(nodeZip);
if (want !== got) throw new Error(`Node 校验和不匹配: ${got} != ${want}`);
log(`  Node sha256 ${got}`);

log('==> 3/6 解压运行时');
const tmp = path.join(cacheDir, 'tmp');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
sh('unzip', ['-q', '-o', nodeZip, `node-v${NODE_VERSION}-win-x64/node.exe`, `node-v${NODE_VERSION}-win-x64/LICENSE`, '-d', tmp]);
sh('unzip', ['-q', '-o', frpWinZip, `frp_${FRP_VERSION}_windows_amd64/frpc.exe`, `frp_${FRP_VERSION}_windows_amd64/LICENSE`, '-d', tmp]);
sh('tar', ['-xzf', frpLinuxTar, '-C', tmp, `frp_${FRP_VERSION}_linux_amd64/frps`, `frp_${FRP_VERSION}_linux_amd64/LICENSE`]);
copy(path.join(tmp, `node-v${NODE_VERSION}-win-x64`, 'node.exe'), path.join(stage, 'node', 'node.exe'));
copy(path.join(tmp, `node-v${NODE_VERSION}-win-x64`, 'LICENSE'), path.join(stage, 'node', 'LICENSE'));
copy(path.join(tmp, `frp_${FRP_VERSION}_windows_amd64`, 'frpc.exe'), path.join(stage, 'tunnel', 'frpc.exe'));
copy(path.join(tmp, `frp_${FRP_VERSION}_windows_amd64`, 'LICENSE'), path.join(stage, 'tunnel', 'LICENSE'));
copy(winswExe, path.join(stage, 'service', 'ClassRoomServer.exe'));
copy(winswExe, path.join(stage, 'service', 'ClassRoomTunnel.exe'));
copy(path.join(tmp, `frp_${FRP_VERSION}_linux_amd64`, 'frps'), path.join(stage, 'relay-linux', 'frps'));
copy(path.join(tmp, `frp_${FRP_VERSION}_linux_amd64`, 'LICENSE'), path.join(stage, 'relay-linux', 'LICENSE'));
fs.chmodSync(path.join(stage, 'relay-linux', 'frps'), 0o755);

log('==> 4/6 打包服务端代码');
sh(path.join(root, 'node_modules', '.bin', 'esbuild'), [
  path.join(root, 'packages', 'server', 'src', 'index.ts'),
  '--bundle',
  '--platform=node',
  '--format=esm',
  '--target=node24',
  `--outfile=${path.join(stage, 'app', 'server.mjs')}`,
  '--banner:js=import { createRequire as __createRequire } from \'node:module\'; const require = __createRequire(import.meta.url);',
  '--log-level=warning',
]);
const migrationsDir = path.join(root, 'packages', 'server', 'src', 'db', 'migrations');
for (const file of fs.readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort()) {
  copy(path.join(migrationsDir, file), path.join(stage, 'app', 'migrations', file));
}

log('==> 5/6 生成配置与脚本');
const tokenFile = path.join(cacheDir, 'frp.token');
let frpToken = process.env.FRP_TOKEN?.trim() || '';
if (frpToken) {
  fs.writeFileSync(tokenFile, `${frpToken}\n`, { mode: 0o600 });
} else if (fs.existsSync(tokenFile)) {
  frpToken = fs.readFileSync(tokenFile, 'utf8').trim();
} else {
  frpToken = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenFile, `${frpToken}\n`, { mode: 0o600 });
}
let turnSecret = process.env.TURN_SECRET?.trim() || '';
if (!turnSecret) {
  const secretFile = '/tmp/classroom-win-secrets/turn.secret';
  if (fs.existsSync(secretFile)) turnSecret = fs.readFileSync(secretFile, 'utf8').trim();
}
if (!turnSecret) {
  log('  ⚠ 未找到 TURN_SECRET，包内 TURN 将为 STUN-only；可在安装时传入 -TurnSecret');
}
const vars = {
  VERSION: version,
  BUILD_TIME: new Date().toISOString(),
  FRP_TOKEN: frpToken,
  FRP_SERVER: process.env.FRP_SERVER?.trim() || '<PROD_SERVER_IP>',
  // 7000 已被机器上现有的 frps 占用；本项目使用独立中继 7100，互不影响
  FRP_PORT: process.env.FRP_PORT?.trim() || '7100',
};
write(path.join(stage, 'tunnel', 'frpc.toml'), render('frpc.toml', vars));
write(path.join(stage, 'relay-linux', 'frps.toml'), render('frps.toml', vars), 0o600);
write(path.join(stage, 'config', '.env.example'), render('.env.example', vars));
write(path.join(stage, 'config', 'turn.secret'), turnSecret ? `${turnSecret}\n` : '', 0o600);
write(path.join(stage, 'service', 'ClassRoomServer.xml.template'), render('ClassRoomServer.xml.template', vars));
write(path.join(stage, 'service', 'ClassRoomTunnel-frp.xml.template'), render('ClassRoomTunnel-frp.xml.template', vars));
write(path.join(stage, 'service', 'ClassRoomTunnel-ssh.xml.template'), render('ClassRoomTunnel-ssh.xml.template', vars));
for (const name of ['install.ps1', 'uninstall.ps1', 'status.ps1', 'import-data.ps1', 'start-console.cmd', 'README.md']) {
  write(path.join(stage, name), render(name, vars));
}
write(path.join(stage, 'tools', 'ssh-tunnel.ps1'), render('ssh-tunnel.ps1', vars));
write(path.join(stage, 'tools', 'always-on.ps1'), render('always-on.ps1', vars));
write(path.join(stage, 'tools', 'db-check.mjs'), render('db-check.mjs', vars));
write(path.join(stage, 'VERSION.txt'), `ClassRoom Server ${version}\nbuild: ${new Date().toISOString()}\nnode: ${NODE_VERSION}\nfrp: ${FRP_VERSION}\n`);
write(path.join(stage, 'data', '.keep'), '');
write(path.join(stage, 'logs', '.keep'), '');
for (const name of ['install-relay.sh', 'switch-to-home.sh', 'switch-to-cloud.sh', 'relay-status.sh', 'export-data.sh']) {
  write(path.join(stage, 'relay-linux', name), render(name, vars), 0o755);
}

log('==> 6/6 生成校验和与 zip');
const sumsLines = [];
for (const file of walk(stage).sort()) {
  const rel = path.relative(stage, file).split(path.sep).join('/');
  if (rel === 'SHA256SUMS.txt') continue;
  sumsLines.push(`${sha256(file)}  ${rel}`);
}
write(path.join(stage, 'SHA256SUMS.txt'), `${sumsLines.join('\n')}\n`);
const zipPath = path.join(distDir, `${bundleName}.zip`);
if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
sh('zip', ['-q', '-r', '-X', `${bundleName}.zip`, bundleName], { cwd: distDir });
write(`${zipPath}.sha256.txt`, `${sha256(zipPath)}  ${path.basename(zipPath)}\n`);

const size = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(1);
log('');
log(`完成: ${zipPath} (${size} MB)`);
log(`SHA256: ${sha256(zipPath)}`);
log(`包内文件: ${sumsLines.length}`);
if (!turnSecret) log('提醒: 包内未包含 TURN_SECRET，安装时需 -TurnSecret 参数。');
