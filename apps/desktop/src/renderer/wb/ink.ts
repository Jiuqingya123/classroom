import Konva from 'konva';
import { pressureWidthRatio } from '@classroom/shared';

export interface InkStyle {
  points: number[];
  /** 逐点压感 [0,1]；没有就不按压力变化，等同于普通等宽笔迹 */
  pressures?: number[];
  /** 工具栏里选的线宽，压感在 35%~100% 之间缩放它 */
  strokeWidth: number;
  color: string;
  opacity?: number;
  highlighter?: boolean;
  listening?: boolean;
}

/** 只依赖这几个 canvas 能力，方便在 Node 里用假上下文做断言 */
export interface InkCtx {
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  stroke(): void;
  fill(): void;
  setAttr(name: string, value: unknown): void;
}

/** 线宽量化步长。压感连续变化，按 0.5px 分桶能把上百次 stroke 合并成几十次 */
const WIDTH_BUCKET = 0.5;
/** 压感再轻也不细于 0.6px，否则等于没画 */
const MIN_WIDTH = 0.6;

function widthAt(base: number, pressures: number[] | undefined, i: number): number {
  if (!pressures || pressures.length === 0) return base;
  const p = pressures[i] ?? pressures[pressures.length - 1] ?? 1;
  return Math.max(MIN_WIDTH, base * pressureWidthRatio(p));
}

/**
 * 画一条笔迹。
 *
 * Konva.Line 只有单一 strokeWidth，画不出「起笔细、按压粗」；canvas 也不支持变宽描边，
 * 所以只能逐段设置 lineWidth 再描。相邻段用 round cap 衔接，视觉上是连续的墨线。
 * 抽成纯函数是为了能在 Node 里用假上下文断言线宽序列（见 scripts/ink-render-test.mts）。
 */
export function drawInk(ctx: InkCtx, o: InkStyle): void {
  const points = o.points;
  const n = Math.floor(points.length / 2);
  if (n === 0) return;

  ctx.setAttr('strokeStyle', o.color);
  ctx.setAttr('lineCap', 'round');
  ctx.setAttr('lineJoin', 'round');

  // 单点（点一下）画个圆点，否则什么都看不见
  if (n === 1) {
    const r = widthAt(o.strokeWidth, o.pressures, 0) / 2;
    ctx.beginPath();
    ctx.arc(points[0] as number, points[1] as number, r, 0, Math.PI * 2);
    ctx.setAttr('fillStyle', o.color);
    ctx.fill();
    return;
  }

  if (!o.pressures || o.pressures.length === 0) {
    // 无压感：一条完整折线，交给 canvas 自己平滑，比逐段描更省
    ctx.beginPath();
    ctx.setAttr('lineWidth', o.strokeWidth);
    ctx.moveTo(points[0] as number, points[1] as number);
    for (let i = 1; i < n; i += 1) {
      ctx.lineTo(points[i * 2] as number, points[i * 2 + 1] as number);
    }
    ctx.stroke();
    return;
  }

  // 有压感：按量化后的线宽分桶，同宽度的连续段合并成一次 stroke
  let bucket = Number.NaN;
  let open = false;
  for (let i = 0; i < n - 1; i += 1) {
    const w = (widthAt(o.strokeWidth, o.pressures, i) + widthAt(o.strokeWidth, o.pressures, i + 1)) / 2;
    const b = Math.max(1, Math.round(w / WIDTH_BUCKET));
    if (b !== bucket) {
      if (open) ctx.stroke();
      bucket = b;
      ctx.beginPath();
      ctx.setAttr('lineWidth', Math.max(MIN_WIDTH, b * WIDTH_BUCKET));
      ctx.moveTo(points[i * 2] as number, points[i * 2 + 1] as number);
      open = true;
    }
    ctx.lineTo(points[(i + 1) * 2] as number, points[(i + 1) * 2 + 1] as number);
  }
  if (open) ctx.stroke();
}

/**
 * 带压感的笔迹节点。
 *
 * 命中判定不走 Konva 的 hit graph —— 橡皮擦和选中用的是 shared/model/hit.ts 的几何判定，
 * 所以这里直接 listening:false，省掉一份 hit canvas 的绘制开销。
 */
export function createInkShape(o: InkStyle): Konva.Shape {
  return new Konva.Shape({
    x: 0,
    y: 0,
    stroke: o.color,
    strokeWidth: o.strokeWidth,
    opacity: o.opacity ?? 1,
    listening: o.listening ?? false,
    globalCompositeOperation: o.highlighter ? 'multiply' : 'source-over',
    perfectDrawEnabled: false,
    sceneFunc: (ctx, shape) => {
      drawInk(ctx as unknown as InkCtx, { ...o, color: shape.stroke() as string });
    },
  });
}
