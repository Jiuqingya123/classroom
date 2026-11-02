import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * refresh token 的落地方式。
 *
 * 为什么不用 httpOnly cookie：Electron 渲染进程的 origin 在打包后是 `file://`，
 * 跨站请求带不上 SameSite cookie。桌面端窗口期用 safeStorage（底层是 macOS Keychain
 * 加密），既避开 SameSite 的坑，也不像 localStorage 那样能被 XSS 直接读走。
 */
let memoryOnly: string | null = null;

function tokenPath(): string {
  return join(app.getPath('userData'), 'session.bin');
}

export function saveRefreshToken(token: string | null): void {
  const p = tokenPath();
  if (token === null) {
    memoryOnly = null;
    try {
      if (existsSync(p)) rmSync(p);
    } catch {
      /* 已删除或无权删除，忽略 */
    }
    return;
  }

  if (!safeStorage.isEncryptionAvailable()) {
    // 拿不到系统加密就只放内存：宁可每次启动重新登录，也不明文落盘
    memoryOnly = token;
    return;
  }

  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, safeStorage.encryptString(token), { mode: 0o600 });
}

export function loadRefreshToken(): string | null {
  if (memoryOnly) return memoryOnly;
  const p = tokenPath();
  if (!existsSync(p)) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(readFileSync(p));
  } catch {
    // 换机器 / Keychain 变更后解不开，直接当作未登录
    return null;
  }
}
