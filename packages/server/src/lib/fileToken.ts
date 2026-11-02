import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * 文件访问签名。
 *
 * 为什么不用 access token：图片要能直接塞进 <img src> 和 Konva.Image，
 * 这两者都没法带 Authorization 头。把 access token 拼进 URL 又会让它出现在
 * 日志、Referer、截图里。
 *
 * 所以单独签一个只对「某个 fileId + 到期时间」有效的串：
 * 泄露了也只能读这一个文件、且会过期，不会连带整个账号。
 */
const CONTEXT = 'classroom:file-url:v1';

function key(secret: string): Buffer {
  return createHmac('sha256', secret).update(CONTEXT).digest();
}

function sign(secret: string, fileId: string, exp: number): string {
  return createHmac('sha256', key(secret)).update(`${fileId}.${exp}`).digest('base64url');
}

export function signFileUrl(
  secret: string,
  fileId: string,
  ttlMs: number,
): { url: string; expiresAt: number } {
  const exp = Date.now() + ttlMs;
  const sig = sign(secret, fileId, exp);
  return {
    url: `/files/${encodeURIComponent(fileId)}?exp=${exp}&sig=${sig}`,
    expiresAt: exp,
  };
}

export function verifyFileUrl(secret: string, fileId: string, exp: number, sig: string): boolean {
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = sign(secret, fileId, exp);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  // 长度不同时 timingSafeEqual 会抛错，先挡掉
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
