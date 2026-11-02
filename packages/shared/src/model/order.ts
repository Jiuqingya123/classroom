/**
 * Fractional indexing —— 白板元素的 z 序键。
 *
 * 目的：在任意两个已有元素之间插入，不需要重排其他元素的 order，
 * 因此「插入」永远只产生一条 op，不会因为小数位耗尽而整页重写。
 *
 * 键格式：`a` + 分数串（整数部分恒为 'a'，所以字典序 == 数值序）。
 * 例：'aV' < 'ad' < 'al'，可在 'aV' 与 'ad' 之间插 'aX'。
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;

function digitAt(s: string, i: number): number {
  if (i >= s.length) return 0;
  const d = DIGITS.indexOf(s[i] as string);
  if (d < 0) throw new Error(`invalid order key digit: ${s[i]}`);
  return d;
}

/** 生成严格介于 a 与 b 之间的分数串（a < b，两者均可为 null 表示无界）。 */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) {
    throw new Error(`order keys out of order: ${a} >= ${b}`);
  }
  if (a.length > 0 && a.endsWith('0')) {
    throw new Error(`order key must not end with 0: ${a}`);
  }

  // 公共前缀直接复用，递归处理剩余部分
  if (b !== null) {
    let n = 0;
    while (digitAt(a, n) === digitAt(b, n) && n < b.length) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }

  const digitA = a.length > 0 ? digitAt(a, 0) : 0;
  const digitB = b !== null ? digitAt(b, 0) : BASE;

  if (digitB - digitA > 1) {
    return DIGITS[Math.round(0.5 * (digitA + digitB))] as string;
  }
  // 相邻两位：若 b 还有后续位，直接借 b 的首位（其后续位保证了仍有空间）
  if (b !== null && b.length > 1) return b.slice(0, 1);
  // 否则在 a 的首位后追加一个新区间
  return (DIGITS[digitA] as string) + midpoint(a.slice(1), null);
}

/** 生成严格大于 a、小于 b 的 order 键。传入 null 表示该侧无界。 */
export function generateKeyBetween(a: string | null, b: string | null): string {
  // 注意：无界必须传 null，不能传空串 —— midpoint 把 '' 当成一个真实的键，
  // 会让「空页面第一次追加」(null, null) 直接撞上 a >= b 的校验。
  const key = 'a' + midpoint(a === null ? '' : a.slice(1), b === null ? null : b.slice(1));
  if (key.endsWith('0')) throw new Error(`generated invalid order key: ${key}`);
  return key;
}

/** 追加到末尾。
 *
 * 不能直接用 midpoint(a, null)：那样每次都会把「到无穷远的中点」吃掉一半，
 * 加到第 7 次左右就得开始加长字符串，200 次之后键会长到 40 多个字符。
 * 先尝试就地递增最后一位（'aV' → 'aW' → … → 'az'），只有顶到 'z' 才加长，
 * 于是平均 62 次追加才增长一个字符。
 */
export function keyAfter(last: string | null): string {
  if (last === null) return generateKeyBetween(null, null);

  const body = last.slice(1);
  for (let i = body.length - 1; i >= 0; i--) {
    const d = DIGITS.indexOf(body[i] as string);
    if (d < 0) break;
    if (d < BASE - 1) {
      // 递增这一位，后面全部截断（不会产生以 0 结尾的非法键）
      return 'a' + body.slice(0, i) + (DIGITS[d + 1] as string);
    }
  }
  // 全是 z，只能加长
  return generateKeyBetween(last, null);
}

/** 在有序键数组中为「插入到索引 i」生成新键。 */
export function keyAt(sorted: string[], i: number): string {
  const before = i > 0 ? (sorted[i - 1] ?? null) : null;
  const after = i < sorted.length ? (sorted[i] ?? null) : null;
  // 追加到末尾走递增路径，避免键无限增长
  if (after === null) return keyAfter(before);
  return generateKeyBetween(before, after);
}

/** 按 order 排序（稳定：order 相同时用 id 兜底，保证双端顺序一致）。 */
export function compareByOrder(
  a: { order: string; id: string },
  b: { order: string; id: string },
): number {
  if (a.order !== b.order) return a.order < b.order ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
