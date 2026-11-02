import type { WhiteboardElement } from '../protocol/whiteboard';

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 相机（白板视口）：我们把变换施加在内容 Layer 上，而不是 Stage 上。 */
export interface Camera {
  x: number;
  y: number;
  scale: number;
}

export function screenToWorld(cam: Camera, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - cam.x) / cam.scale, y: (sy - cam.y) / cam.scale };
}

export function worldToScreen(cam: Camera, wx: number, wy: number): { x: number; y: number } {
  return { x: wx * cam.scale + cam.x, y: wy * cam.scale + cam.y };
}

/** 直线元素的包围盒（arrow / line 也存 points） */
function boundsOfPoints(points: number[], ox: number, oy: number): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    const px = (points[i] as number) + ox;
    const py = (points[i + 1] as number) + oy;
    if (px < minX) minX = px;
    if (px > maxX) maxX = px;
    if (py < minY) minY = py;
    if (py > maxY) maxY = py;
  }
  if (!Number.isFinite(minX)) return { x: ox, y: oy, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function boundsOfElement(el: WhiteboardElement): Bounds {
  if (el.points && el.points.length >= 2) {
    return boundsOfPoints(el.points, el.x, el.y);
  }
  return {
    x: el.x,
    y: el.y,
    width: el.width * Math.abs(el.scaleX || 1),
    height: el.height * Math.abs(el.scaleY || 1),
  };
}

/** 合并多个包围盒 */
export function unionBounds(list: Bounds[]): Bounds | null {
  if (list.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of list) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.width > maxX) maxX = b.x + b.width;
    if (b.y + b.height > maxY) maxY = b.y + b.height;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * 点集抽稀：丢弃与「上一个保留点」距离小于 tolerance 的点。
 * 手写笔采样率约 120Hz，不抽稀会让一笔就产生上千个点，白板消息直接爆掉。
 */
export function simplifyPoints(flat: number[], tolerance = 1.5): number[] {
  if (flat.length <= 4) return flat.slice();
  const keep = simplifyPointIndices(flat, tolerance);
  const out: number[] = [];
  for (const i of keep) {
    out.push(flat[i * 2] as number, flat[i * 2 + 1] as number);
  }
  return out;
}

/**
 * 与 simplifyPoints 同一套规则，但返回「保留的点下标」。
 *
 * 压感是逐点数组，简化掉点的时候必须同步简化压感，否则两者错位会导致线宽乱跳。
 * 统一在这里算出下标，点集和压感都按它重建。
 */
export function simplifyPointIndices(flat: number[], tolerance = 1.5): number[] {
  const count = Math.floor(flat.length / 2);
  if (count === 0) return [];
  if (count === 1) return [0];

  const keep: number[] = [0];
  let lastX = flat[0] as number;
  let lastY = flat[1] as number;
  const tol2 = tolerance * tolerance;

  for (let i = 1; i < count; i += 1) {
    const x = flat[i * 2] as number;
    const y = flat[i * 2 + 1] as number;
    const dx = x - lastX;
    const dy = y - lastY;
    if (dx * dx + dy * dy >= tol2) {
      keep.push(i);
      lastX = x;
      lastY = y;
    }
  }

  // 始终保留终点，避免笔迹「缺一截」
  if (keep[keep.length - 1] !== count - 1) keep.push(count - 1);
  return keep;
}

/** 按保留下标同时简化点集与压感，保证两者一一对应 */
export function simplifyStroke(
  flat: number[],
  pressures: number[] | undefined,
  tolerance = 1.2,
): { points: number[]; pressures: number[] | undefined } {
  const keep = simplifyPointIndices(flat, tolerance);
  const points: number[] = [];
  for (const i of keep) {
    points.push(flat[i * 2] as number, flat[i * 2 + 1] as number);
  }
  if (!pressures) return { points, pressures: undefined };
  const out: number[] = [];
  for (const i of keep) out.push(pressures[i] ?? 1);
  return { points, pressures: out };
}

/**
 * 压感 → 线宽比例。
 *
 * 下限取 0.35 而不是 0：手写笔轻轻起笔时压感能低到 0.02，按比例算出来线宽 0.1px，
 * 在投影/大屏上等于没画。上限 1.0 对应工具栏里选的线宽。
 */
export function pressureWidthRatio(pressure: number): number {
  const p = Number.isFinite(pressure) ? Math.min(1, Math.max(0, pressure)) : 1;
  return 0.35 + 0.65 * p;
}

/** 以指针为锚点缩放相机（滚轮缩放 / 触控板捏合） */
export function zoomAt(cam: Camera, sx: number, sy: number, factor: number, min = 0.1, max = 8): Camera {
  const nextScale = Math.min(max, Math.max(min, cam.scale * factor));
  const k = nextScale / cam.scale;
  return {
    scale: nextScale,
    x: sx - (sx - cam.x) * k,
    y: sy - (sy - cam.y) * k,
  };
}
