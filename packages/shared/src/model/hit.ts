import type { WhiteboardElement } from '../protocol/whiteboard';
import { boundsOfElement, type Bounds } from './geometry';

/** 点到线段距离的平方 */
function distToSegmentSq(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return (px - cx) * (px - cx) + (py - cy) * (py - cy);
}

/**
 * 点到折线的距离是否落在容差内。
 * 橡皮擦用它做「对象级删除」的命中判定（不做像素擦除，见 docs/protocol.md）。
 */
export function hitPolyline(
  flat: number[],
  ox: number,
  oy: number,
  x: number,
  y: number,
  tolerance: number,
): boolean {
  const tol2 = tolerance * tolerance;
  if (flat.length === 2) {
    const ax = (flat[0] as number) + ox;
    const ay = (flat[1] as number) + oy;
    return (x - ax) * (x - ax) + (y - ay) * (y - ay) <= tol2;
  }
  for (let i = 0; i < flat.length - 2; i += 2) {
    const ax = (flat[i] as number) + ox;
    const ay = (flat[i + 1] as number) + oy;
    const bx = (flat[i + 2] as number) + ox;
    const by = (flat[i + 3] as number) + oy;
    if (distToSegmentSq(x, y, ax, ay, bx, by) <= tol2) return true;
  }
  return false;
}

export function boundsContains(b: Bounds, x: number, y: number, pad = 0): boolean {
  return x >= b.x - pad && x <= b.x + b.width + pad && y >= b.y - pad && y <= b.y + b.height + pad;
}

/** 选中元素是否与该点（含容差）相交 —— 供橡皮擦 / 点选使用 */
export function hitElement(el: WhiteboardElement, x: number, y: number, tolerance = 6): boolean {
  if (el.deleted) return false;
  if (el.points && el.points.length >= 2) {
    return hitPolyline(el.points, el.x, el.y, x, y, Math.max(tolerance, (el.strokeWidth ?? 2) / 2));
  }
  return boundsContains(boundsOfElement(el), x, y, tolerance);
}
