import { MAX_ELEMENTS_PER_PAGE, MAX_PAGES, MAX_STROKE_POINTS } from '../const/limits';
import type {
  ElementType,
  PageMeta,
  WbOp,
  WbRejectReason,
  WhiteboardElement,
} from '../protocol/whiteboard';
import { keyAfter } from './order';
import { canTeach, type Role } from '../protocol/auth';

/**
 * 服务端权威 reducer。
 *
 * 服务端用它校验并改写 op，客户端用同一个 `applyTrusted` 应用广播 ——
 * 双端跑同一份代码，是「两端收敛」而不是「两端碰巧看起来一样」的前提。
 */

export interface WbDoc {
  pages: PageMeta[];
  elements: Map<string, WhiteboardElement>;
}

export interface ReduceContext {
  by: string;
  role: Role;
  /** 老师是否允许学生绘制 */
  studentsCanDraw: boolean;
  now: number;
}

export interface ReduceOutcome {
  ok: boolean;
  reason?: WbRejectReason;
  /** 规范化之后真正应该广播的 op（服务端分配的 order / rev 都在这里） */
  op?: WbOp;
  /** 权威 rev，客户端据此校正本地版本 */
  revs: Record<string, number>;
}

const ELEMENT_TYPES: ReadonlySet<string> = new Set<ElementType>([
  'pen',
  'highlighter',
  'rect',
  'ellipse',
  'arrow',
  'line',
  'text',
  'image',
]);

/** 客户端可以设置的字段白名单。id / pageId / rev / order / createdBy 一律由服务端决定 */
const PATCHABLE = [
  'x',
  'y',
  'width',
  'height',
  'rotation',
  'scaleX',
  'scaleY',
  'points',
  'pressures',
  'stroke',
  'strokeWidth',
  'fill',
  'opacity',
  'text',
  'fontSize',
  'fontFamily',
  'fontStyle',
  'src',
  'locked',
] as const;

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, max = 256): string | undefined {
  return typeof v === 'string' && v.length <= max ? v : undefined;
}

/** 只保留白名单字段，并做数值兜底 */
function pickFields(src: Record<string, unknown>): Partial<WhiteboardElement> {
  const out: Record<string, unknown> = {};
  for (const key of PATCHABLE) {
    const v = src[key];
    if (v === undefined) continue;

    if (key === 'points') {
      if (!Array.isArray(v)) continue;
      if (v.length > MAX_STROKE_POINTS * 2) continue;
      const clean: number[] = [];
      for (const n of v) {
        if (typeof n !== 'number' || !Number.isFinite(n)) break;
        clean.push(n);
      }
      if (clean.length !== v.length) continue;
      out.points = clean;
      continue;
    }

    if (key === 'pressures') {
      // 与 points 一一对应的 0~1 压感。超范围直接夹紧，不做 reject ——
      // 不同驱动的量纲差别很大（有的报 0~1024），夹紧比丢整条笔画温和
      if (!Array.isArray(v)) continue;
      if (v.length > MAX_STROKE_POINTS) continue;
      const clean: number[] = [];
      for (const n of v) {
        if (typeof n !== 'number' || !Number.isFinite(n)) break;
        clean.push(n < 0 ? 0 : n > 1 ? 1 : n);
      }
      if (clean.length !== v.length) continue;
      // 与 points 长度不一致的压感是脏数据（重连、老客户端、手改包），
      // 直接丢掉整条压感，让笔迹退化成等宽，而不是渲染出一条宽度乱跳的线
      const pts = out.points;
      if (Array.isArray(pts) && clean.length !== pts.length / 2) continue;
      out.pressures = clean;
      continue;
    }

    if (key === 'locked') {
      if (typeof v === 'boolean') out.locked = v;
      continue;
    }

    if (key === 'stroke' || key === 'fill' || key === 'text' || key === 'src' ||
        key === 'fontFamily' || key === 'fontStyle') {
      const s = str(v, key === 'text' ? 4000 : 512);
      if (s !== undefined) out[key] = s;
      continue;
    }

    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
  }
  return out as Partial<WhiteboardElement>;
}

function reject(reason: WbRejectReason): ReduceOutcome {
  return { ok: false, reason, revs: {} };
}

function orderFor(doc: WbDoc, pageId: string): string {
  let last: string | null = null;
  for (const el of doc.elements.values()) {
    if (el.pageId !== pageId || el.deleted) continue;
    if (last === null || el.order > last) last = el.order;
  }
  return keyAfter(last);
}

function countOnPage(doc: WbDoc, pageId: string): number {
  let n = 0;
  for (const el of doc.elements.values()) {
    if (el.pageId === pageId && !el.deleted) n++;
  }
  return n;
}

/** 区分「元素被锁」与「不是你的元素」——两者的提示语和处置方式不一样 */
function denyReason(el: WhiteboardElement, ctx: ReduceContext): WbRejectReason | null {
  if (canTeach(ctx.role)) return null;
  if (el.locked) return 'locked';
  if (el.createdBy !== ctx.by) return 'forbidden';
  return null;
}

/**
 * 应用一条 op。返回 ok=false 时 doc **未被修改**（先校验后写入），
 * 这一点很重要：拒绝路径不能留下半截状态。
 */
export function applyOp(doc: WbDoc, op: WbOp, ctx: ReduceContext): ReduceOutcome {
  switch (op.kind) {
    case 'add': {
      if (!canTeach(ctx.role) && !ctx.studentsCanDraw) return reject('forbidden');

      const raw = op.el as WhiteboardElement | undefined;
      if (!raw || typeof raw.id !== 'string' || raw.id.length === 0 || raw.id.length > 64) {
        return reject('bad_op');
      }
      if (typeof raw.pageId !== 'string') return reject('bad_op');
      if (!ELEMENT_TYPES.has(raw.type)) return reject('bad_op');

      const existing = doc.elements.get(raw.id);
      if (existing) {
        // 幂等：重连/重发时同一个 id 再来一次，直接返回当前 rev，不报错
        return { ok: true, revs: { [raw.id]: existing.rev } };
      }

      if (!doc.pages.some((p) => p.id === raw.pageId)) return reject('bad_op');
      if (countOnPage(doc, raw.pageId) >= MAX_ELEMENTS_PER_PAGE) return reject('too_large');

      const fields = pickFields(raw as unknown as Record<string, unknown>);
      if (raw.type === 'pen' || raw.type === 'highlighter') {
        const pts = fields.points;
        if (!pts || pts.length < 2) return reject('bad_op');
      }

      const el: WhiteboardElement = {
        id: raw.id,
        pageId: raw.pageId,
        type: raw.type,
        rev: 1,
        // order 由服务端分配：客户端传什么都被忽略，所以并发追加也不会撞车
        order: orderFor(doc, raw.pageId),
        x: num(fields.x),
        y: num(fields.y),
        width: num(fields.width),
        height: num(fields.height),
        rotation: num(fields.rotation),
        scaleX: num(fields.scaleX, 1),
        scaleY: num(fields.scaleY, 1),
        createdBy: ctx.by,
        createdAt: ctx.now,
        updatedAt: ctx.now,
        ...fields,
        // 学生不能一进来就把元素设成 locked
        locked: canTeach(ctx.role) ? (fields.locked ?? false) : false,
      };

      doc.elements.set(el.id, el);
      return { ok: true, op: { kind: 'add', el }, revs: { [el.id]: 1 } };
    }

    case 'patch': {
      if (!canTeach(ctx.role) && !ctx.studentsCanDraw) return reject('forbidden');

      const target = doc.elements.get(op.id);
      if (!target) return reject('bad_op');
      // 已软删的元素不许再改：否则晚到的 patch 会把墓碑「改活」
      if (target.deleted) return reject('rev_conflict');
      if (op.rev !== target.rev) return reject('rev_conflict');
      const denied = denyReason(target, ctx);
      if (denied) return reject(denied);

      const fields = pickFields((op.patch ?? {}) as Record<string, unknown>);
      if (fields.locked !== undefined && !canTeach(ctx.role)) delete fields.locked;

      const next: WhiteboardElement = {
        ...target,
        ...fields,
        rev: target.rev + 1,
        updatedAt: ctx.now,
        // 以下字段永远不接受客户端覆盖
        id: target.id,
        pageId: target.pageId,
        order: target.order,
        createdBy: target.createdBy,
        createdAt: target.createdAt,
      };
      doc.elements.set(op.id, next);

      return {
        ok: true,
        op: { kind: 'patch', id: op.id, rev: op.rev, patch: fields },
        revs: { [op.id]: next.rev },
      };
    }

    case 'remove': {
      if (!canTeach(ctx.role) && !ctx.studentsCanDraw) return reject('forbidden');

      const target = doc.elements.get(op.id);
      if (!target) return reject('bad_op');
      if (target.deleted) {
        // 已经删过了，当作成功（幂等）
        return { ok: true, revs: { [op.id]: target.rev } };
      }
      if (op.rev !== target.rev) return reject('rev_conflict');
      const denied = denyReason(target, ctx);
      if (denied) return reject(denied);

      doc.elements.set(op.id, { ...target, deleted: true, rev: target.rev + 1, updatedAt: ctx.now });
      return {
        ok: true,
        op: { kind: 'remove', id: op.id, rev: op.rev },
        revs: { [op.id]: target.rev + 1 },
      };
    }

    case 'page.add': {
      if (!canTeach(ctx.role)) return reject('forbidden');
      const p = op.page;
      if (!p || typeof p.id !== 'string' || doc.pages.some((x) => x.id === p.id)) {
        return reject('bad_op');
      }
      if (doc.pages.length >= MAX_PAGES) return reject('too_large');

      doc.pages.push({ ...p, index: doc.pages.length });
      doc.pages.sort((a, b) => a.index - b.index);
      return { ok: true, op, revs: {} };
    }

    case 'page.del': {
      if (!canTeach(ctx.role)) return reject('forbidden');
      if (doc.pages.length <= 1) return reject('bad_op');
      const idx = doc.pages.findIndex((p) => p.id === op.pageId);
      if (idx < 0) return reject('bad_op');

      doc.pages.splice(idx, 1);
      doc.pages.forEach((p, i) => {
        p.index = i;
      });
      for (const [id, el] of doc.elements) {
        if (el.pageId === op.pageId) doc.elements.delete(id);
      }
      return { ok: true, op, revs: {} };
    }

    case 'page.reorder': {
      if (!canTeach(ctx.role)) return reject('forbidden');
      const byId = new Map(doc.pages.map((p) => [p.id, p]));
      const unique = new Set(op.order);
      if (op.order.length !== doc.pages.length || unique.size !== op.order.length) {
        return reject('bad_op');
      }
      const next: PageMeta[] = [];
      for (const id of op.order) {
        const p = byId.get(id);
        if (!p) return reject('bad_op');
        next.push(p);
      }
      next.forEach((p, i) => {
        p.index = i;
      });
      doc.pages = next;
      return { ok: true, op, revs: {} };
    }

    default:
      return reject('bad_op');
  }
}

/**
 * 客户端应用服务端广播的 op —— 不做校验，只机械地落状态。
 * `revs` 是权威值，必须优先于 op 里携带的旧 rev。
 */
export function applyTrusted(doc: WbDoc, ops: WbOp[], revs: Record<string, number>): void {
  for (const op of ops) {
    switch (op.kind) {
      case 'add': {
        doc.elements.set(op.el.id, { ...op.el });
        break;
      }
      case 'patch': {
        const cur = doc.elements.get(op.id);
        if (!cur) break;
        doc.elements.set(op.id, {
          ...cur,
          ...op.patch,
          rev: revs[op.id] ?? cur.rev + 1,
          id: cur.id,
          pageId: cur.pageId,
          order: cur.order,
        });
        break;
      }
      case 'remove': {
        const cur = doc.elements.get(op.id);
        if (!cur) break;
        doc.elements.set(op.id, { ...cur, deleted: true, rev: revs[op.id] ?? cur.rev + 1 });
        break;
      }
      case 'page.add': {
        if (!doc.pages.some((p) => p.id === op.page.id)) {
          doc.pages.push({ ...op.page });
          doc.pages.sort((a, b) => a.index - b.index);
        }
        break;
      }
      case 'page.del': {
        doc.pages = doc.pages.filter((p) => p.id !== op.pageId);
        for (const [id, el] of doc.elements) {
          if (el.pageId === op.pageId) doc.elements.delete(id);
        }
        break;
      }
      case 'page.reorder': {
        const byId = new Map(doc.pages.map((p) => [p.id, p]));
        const next: PageMeta[] = [];
        for (const id of op.order) {
          const p = byId.get(id);
          if (p) next.push({ ...p, index: next.length });
        }
        if (next.length > 0) doc.pages = next;
        break;
      }
    }
  }
}

/** 取某一页可见元素，按 z 序升序 */
export function visibleElements(doc: WbDoc, pageId: string): WhiteboardElement[] {
  const out: WhiteboardElement[] = [];
  for (const el of doc.elements.values()) {
    if (el.pageId === pageId && !el.deleted) out.push(el);
  }
  return out.sort((a, b) => (a.order !== b.order ? (a.order < b.order ? -1 : 1) : a.id < b.id ? -1 : 1));
}
