import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * 密码哈希。
 *
 * 用 Node 内置的 scrypt 而不是 argon2：argon2 是原生模块，在只有 glibc 2.32 的
 * 服务器上要么装不上、要么得现编译 C++。scrypt 同样是「内存硬」的 KDF，
 * 参数取 N=16384/r=8/p=1（约 16MB 内存/次），在 1.8G 内存的机器上是合适档位。
 *
 * 存储格式：scrypt$N$r$p$salt$hash（base64url）。
 * 把参数写进串里，将来调参可以按条目平滑升级，不用整库重置。
 */
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_LEN = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await scryptAsync(password, salt, KEYLEN);
  return [
    'scrypt',
    N,
    R,
    P,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const saltB64 = parts[4];
  const hashB64 = parts[5];
  if (!saltB64 || !hashB64) return false;

  try {
    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(hashB64, 'base64url');
    const actual = await scryptAsync(password, salt, expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/**
 * 用户不存在时也要消耗等量时间，否则响应快慢会泄露「这个邮箱注册过没有」。
 * 这里对一个固定的假哈希跑一遍完整校验。
 */
export async function burnPasswordCheck(password: string): Promise<void> {
  await verifyPassword(DUMMY, password);
}

const DUMMY = [
  'scrypt',
  N,
  R,
  P,
  Buffer.alloc(SALT_LEN, 1).toString('base64url'),
  Buffer.alloc(KEYLEN, 0).toString('base64url'),
].join('$');
