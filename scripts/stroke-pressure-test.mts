/**
 * 压感笔迹的单元测试（无需数位板）。
 *
 * 覆盖三件容易出错的事：
 *   1. 压感 → 线宽的映射边界
 *   2. 点简化时压感数组必须同步裁剪，否则线宽会整体错位
 *   3. 服务端对压感的校验：越界夹紧、脏数据丢弃、不影响元素本身入库
 *
 *   npx tsx scripts/stroke-pressure-test.mts
 */
import assert from 'node:assert/strict';
import {
  applyOp,
  pressureWidthRatio,
  simplifyPointIndices,
  simplifyStroke,
  type WbDoc,
  type WhiteboardElement,
} from '../packages/shared/src/index.ts';

let passed = 0;
function check(label: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`✅ ${label}`);
}

/** 造一条水平直线：每个点间隔 5px，压感从 0.1 线性涨到 1 */
function makeStroke(count = 40) {
  const points: number[] = [];
  const pressures: number[] = [];
  for (let i = 0; i < count; i += 1) {
    points.push(i * 5, 0);
    pressures.push(0.1 + (0.9 * i) / (count - 1));
  }
  return { points, pressures };
}

// ── 1. 线宽映射 ─────────────────────────────────────────────
check('压感 0 仍有 35% 线宽（太细在大屏上看不见）', () => {
  assert.equal(pressureWidthRatio(0), 0.35);
});
check('压感 1 用满工具栏线宽', () => {
  assert.equal(pressureWidthRatio(1), 1);
});
check('越界压感被夹到 [0,1]', () => {
  assert.equal(pressureWidthRatio(-3), 0.35);
  assert.equal(pressureWidthRatio(7), 1);
});
check('非法值不产生 NaN 宽度', () => {
  assert.equal(pressureWidthRatio(Number.NaN), 1);
});
check('中段压感落在线性区间内', () => {
  const r = pressureWidthRatio(0.5);
  assert.ok(r > 0.35 && r < 1, `0.5 → ${r}`);
});

// ── 2. 简化对齐 ─────────────────────────────────────────────
check('简化的点下标单调递增且首尾都在', () => {
  const { points } = makeStroke();
  const keep = simplifyPointIndices(points, 1.2);
  assert.equal(keep[0], 0);
  assert.equal(keep[keep.length - 1], points.length / 2 - 1);
  for (let i = 1; i < keep.length; i += 1) {
    assert.ok((keep[i] as number) > (keep[i - 1] as number), '下标必须递增');
  }
});

check('压感数组随点同步裁剪，长度始终等于点数', () => {
  const { points, pressures } = makeStroke();
  const r = simplifyStroke(points, pressures, 1.2);
  assert.equal(r.points.length / 2, r.pressures?.length);
  assert.ok((r.pressures?.length ?? 0) > 2);
});

check('裁剪后每个压感仍对应原来的那个点', () => {
  const { points, pressures } = makeStroke();
  const keep = simplifyPointIndices(points, 1.2);
  const r = simplifyStroke(points, pressures, 1.2);
  for (let i = 0; i < keep.length; i += 1) {
    const srcIndex = keep[i] as number;
    // 点坐标能对上，且压感与源数组同位置的值一致
    assert.equal(r.points[i * 2], points[srcIndex * 2]);
    assert.equal(pressures[srcIndex], r.pressures?.[i]);
  }
});

check('没有压感时简化不凭空造数组', () => {
  const { points } = makeStroke();
  const r = simplifyStroke(points, undefined, 1.2);
  assert.equal(r.pressures, undefined);
});

// ── 3. 服务端校验 ───────────────────────────────────────────
function emptyDoc(): WbDoc {
  return { pages: [{ id: 'p1', index: 0, name: '第 1 页' }], elements: new Map() };
}

function penElement(overrides: Record<string, unknown> = {}): WhiteboardElement {
  return {
    id: 'el-1',
    pageId: 'p1',
    type: 'pen',
    rev: 1,
    order: 'a0',
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    points: [0, 0, 10, 0, 20, 0],
    stroke: '#1f2937',
    strokeWidth: 4,
    opacity: 1,
    createdBy: 'u1',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as WhiteboardElement;
}

const ctx = { by: 'u1', role: 'teacher' as const, studentsCanDraw: true, now: 2 };

check('压感能正常入库', () => {
  const doc = emptyDoc();
  const out = applyOp(doc, { kind: 'add', el: penElement({ pressures: [0.2, 0.6, 1] }) }, ctx);
  assert.equal(out.ok, true);
  const saved = doc.elements.get('el-1');
  assert.deepEqual(saved?.pressures, [0.2, 0.6, 1]);
});

check('越界压感被夹紧而不是被丢弃', () => {
  const doc = emptyDoc();
  applyOp(doc, { kind: 'add', el: penElement({ pressures: [-2, 0.5, 9] }) }, ctx);
  assert.deepEqual(doc.elements.get('el-1')?.pressures, [0, 0.5, 1]);
});

check('长度对不上的压感整条丢弃，笔画本身照常入库', () => {
  const doc = emptyDoc();
  applyOp(doc, { kind: 'add', el: penElement({ pressures: [0.5, 0.5] }) }, ctx);
  const saved = doc.elements.get('el-1');
  assert.ok(saved, '笔画不能被一起丢掉');
  assert.equal(saved?.pressures, undefined);
});

check('压感里混入字符串时整条丢弃', () => {
  const doc = emptyDoc();
  applyOp(doc, { kind: 'add', el: penElement({ pressures: [0.5, 'x', 0.8] }) }, ctx);
  assert.equal(doc.elements.get('el-1')?.pressures, undefined);
});

check('没有压感的普通笔迹行为不变', () => {
  const doc = emptyDoc();
  applyOp(doc, { kind: 'add', el: penElement() }, ctx);
  const saved = doc.elements.get('el-1');
  assert.equal(saved?.pressures, undefined);
  assert.deepEqual(saved?.points, [0, 0, 10, 0, 20, 0]);
});

console.log(`\n压感笔迹 ${passed} 项全部通过 🎉`);
