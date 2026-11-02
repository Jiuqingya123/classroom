/**
 * z 序键（fractional index）的正确性检查。
 * 纯函数，不需要任何服务，`npm run check:order` 直接跑。
 */
import { compareByOrder, generateKeyBetween, keyAfter, keyAt } from '../packages/shared/src/model/order';

let failed = 0;
function check(name: string, cond: boolean, extra = ''): void {
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? `  ${extra}` : ''}`);
  if (!cond) failed++;
}

// 1. 空页面首次追加（这里曾经因为把「无界」传成空串而直接抛错）
const first = generateKeyBetween(null, null);
check('空页面能生成首个键', typeof first === 'string' && first.length > 1, first);

// 2. 连续追加 200 次严格递增
let last: string | null = null;
const appended: string[] = [];
for (let i = 0; i < 200; i++) {
  const k = keyAfter(last);
  if (last !== null && !(k > last)) {
    check(`第 ${i} 次追加递增`, false, `${last} -> ${k}`);
    break;
  }
  appended.push(k);
  last = k;
}
check('连续追加 200 次严格递增', appended.length === 200);
check('键长度不会失控', (appended[appended.length - 1] as string).length <= 12, `末键长度 ${(appended[appended.length - 1] as string).length}`);

// 3. 两端有界交替插入
let lo: string | null = null;
let hi: string | null = null;
let boundedOk = true;
for (let i = 0; i < 60; i++) {
  const k = generateKeyBetween(lo, hi);
  if (lo !== null && !(k > lo)) boundedOk = false;
  if (hi !== null && !(k < hi)) boundedOk = false;
  if (i % 2 === 0) lo = k;
  else hi = k;
}
check('双端有界交替插入 60 次始终合法', boundedOk);

// 4. keyAt：往有序数组的任意位置插
const sorted = [generateKeyBetween(null, null)];
for (let i = 0; i < 10; i++) sorted.push(keyAfter(sorted[sorted.length - 1] as string));
const atMid = keyAt(sorted, 5);
check('keyAt 能插到中间', atMid > (sorted[4] as string) && atMid < (sorted[5] as string), atMid);

// 5. 排序稳定性：order 相同则按 id 兜底
const a = { order: 'aV', id: 'b' };
const b = { order: 'aV', id: 'a' };
check('order 相同时按 id 兜底', compareByOrder(a, b) > 0 && compareByOrder(b, a) < 0);

console.log('');
console.log(failed === 0 ? 'z 序键全部通过 🎉' : `${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
