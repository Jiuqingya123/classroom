/**
 * 笔迹绘制的单元测试（假 canvas 上下文，不需要浏览器/数位板）。
 *
 * 验证的是「画出来的线宽序列对不对」——这是压感功能最核心、也最容易写错的地方。
 *
 *   npx tsx scripts/ink-render-test.mts
 */
import assert from 'node:assert/strict';
import { drawInk, type InkCtx } from '../apps/desktop/src/renderer/wb/ink.ts';

/** 记录每次 stroke 时的线宽和该次描边包含的段数 */
class Recorder implements InkCtx {
  strokes: { width: number; segments: number }[] = [];
  private width = 1;
  private segments = 0;
  private pending = false;

  beginPath(): void {
    this.segments = 0;
  }
  moveTo(): void {
    this.pending = true;
  }
  lineTo(): void {
    this.segments += 1;
  }
  arc(): void {
    this.segments += 1;
  }
  stroke(): void {
    if (!this.pending) return;
    this.strokes.push({ width: this.width, segments: this.segments });
    this.pending = false;
  }
  fill(): void {
    this.strokes.push({ width: this.width, segments: 0 });
  }
  setAttr(name: string, value: unknown): void {
    if (name === 'lineWidth') this.width = value as number;
  }
}

let passed = 0;
function check(label: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`✅ ${label}`);
}

/** 水平直线 + 线性递增的压感 */
function ramp(count = 60) {
  const points: number[] = [];
  const pressures: number[] = [];
  for (let i = 0; i < count; i += 1) {
    points.push(i * 4, 0);
    pressures.push(0.05 + (0.95 * i) / (count - 1));
  }
  return { points, pressures };
}

// 1. 无压感：只有一次描边，宽度等于工具栏线宽
{
  const { points } = ramp();
  const rec = new Recorder();
  drawInk(rec, { points, strokeWidth: 6, color: '#000' });
  check('无压感时是一次等宽描边', () => {
    assert.equal(rec.strokes.length, 1);
    assert.equal(rec.strokes[0]?.width, 6);
  });
}

// 2. 有压感：线宽从细到粗单调递增
{
  const { points, pressures } = ramp();
  const rec = new Recorder();
  drawInk(rec, { points, pressures, strokeWidth: 8, color: '#000' });
  check('压感笔迹会分成多次描边', () => {
    assert.ok(rec.strokes.length > 3, `实际 ${rec.strokes.length} 段`);
  });
  check('线宽随压感由细变粗', () => {
    const widths = rec.strokes.map((s) => s.width);
    assert.ok((widths[0] as number) < (widths[widths.length - 1] as number), `首 ${widths[0]} 末 ${widths[widths.length - 1]}`);
    for (let i = 1; i < widths.length; i += 1) {
      assert.ok((widths[i] as number) >= (widths[i - 1] as number), '宽度不能回退');
    }
  });
  check('最细也不小于 0.6px', () => {
    for (const s of rec.strokes) assert.ok(s.width >= 0.6, `${s.width}`);
  });
  check('最粗不超过工具栏线宽', () => {
    for (const s of rec.strokes) assert.ok(s.width <= 8 + 0.5, `${s.width}`);
  });
  check('所有线段都被画到，没漏点', () => {
    const total = rec.strokes.reduce((sum, s) => sum + s.segments, 0);
    assert.ok(total >= points.length / 2 - 1, `画了 ${total} 段，点 ${points.length / 2}`);
  });
}

// 3. 恒定压感：其实和等宽一样，但也要能画出来
{
  const points: number[] = [];
  const pressures: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    points.push(i * 5, i * 5);
    pressures.push(0.5);
  }
  const rec = new Recorder();
  drawInk(rec, { points, pressures, strokeWidth: 4, color: '#000' });
  check('恒定压感只产生一档线宽', () => {
    const uniq = new Set(rec.strokes.map((s) => s.width));
    assert.equal(uniq.size, 1);
    const w = [...uniq][0] as number;
    assert.ok(w > 1.5 && w < 4, `实际 ${w}`); // 4 * (0.35+0.65*0.5) = 2.7
  });
}

// 4. 单点（点一下）：画成圆点而不是什么都没有
{
  const rec = new Recorder();
  drawInk(rec, { points: [10, 10], pressures: [0.8], strokeWidth: 6, color: '#000' });
  check('单点笔迹会画成圆点', () => {
    assert.equal(rec.strokes.length, 1);
  });
}

// 5. 压感数组比点少（异常数据）时不崩，用最后一个值兜底
{
  const { points } = ramp(30);
  const rec = new Recorder();
  drawInk(rec, { points, pressures: [0.2, 0.9], strokeWidth: 6, color: '#000' });
  check('压感数组偏短时用末值兜底，不抛异常', () => {
    assert.ok(rec.strokes.length >= 1);
  });
}

console.log(`\n笔迹绘制 ${passed} 项全部通过 🎉`);
