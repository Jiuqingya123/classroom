import type { Camera, Role } from '@classroom/shared';

/**
 * 压感是否有起伏。
 *
 * 有些驱动/系统在「笔悬停按下瞬间」只报固定压力（比如始终 0.5），
 * 这种笔迹存一份全相同的 pressures 只会白占空间，按普通笔画渲染即可。
 */
function hasPressureVariation(pressures: number[]): boolean {
  if (pressures.length < 2) return false;
  let min = Infinity;
  let max = -Infinity;
  for (const p of pressures) {
    if (p < min) min = p;
    if (p > max) max = p;
  }
  return max - min >= 0.02;
}
import {
  applyTrusted,
  canTeach,
  compareByOrder,
  DEFAULT_STYLE,
  keyAfter,
  MAX_PAGES,
  simplifyStroke,
  uuid,
  visibleElements,
  zoomAt,
  type ElementStyle,
  type PageMeta,
  type Tool,
  type WbBroadcast,
  type WbCursor,
  type WbDoc,
  type WbOp,
  type WbOpPayload,
  type WbPreviewBroadcast,
  type WbPreviewPayload,
  type WbSyncPayload,
  type WhiteboardElement,
} from '@classroom/shared';

export interface WhiteboardDeps {
  selfId: string;
  role: Role;
  sendOp(payload: WbOpPayload, cb: (ok: boolean, error?: string) => void): void;
  sendPreview(payload: WbPreviewPayload): void;
  sendCursor(payload: { pageId: string; x: number | null; y: number | null; tool: string }): void;
  sendPage(pageId: string): void;
  sendLock(studentsCanDraw: boolean): void;
}

/**
 * 历史记录按「语义动作」存，而不是存原始 op。
 *
 * 原因：op 里的 rev 会随每次修改变化，存原始 op 在撤销几步之后 rev 必然对不上，
 * 会被服务端判成 rev_conflict。存 before/after 语义，执行时再取当时的 rev。
 *
 * 另外重做「新增」时会生成新的元素 id —— 墓碑规则不允许同一个 id 复活，
 * 换 id 重发内容是一样的，视觉上完全等价。
 */
type HistAction =
  | { kind: 'add'; el: WhiteboardElement }
  | { kind: 'patch'; id: string; before: Record<string, unknown>; after: Record<string, unknown> };

const PREVIEW_INTERVAL_MS = 45;
const CURSOR_INTERVAL_MS = 50;
const CURSOR_TTL_MS = 6000;
const MAX_HISTORY = 100;
/** 连点翻页时只把最后一页发给服务端：中间页会让每个学生端都空加载一遍背景图 */
const PAGE_SEND_COALESCE_MS = 60;

export class WhiteboardClient {
  readonly doc: WbDoc = { pages: [], elements: new Map() };
  activePageId = '';
  studentsCanDraw = true;
  seq = 0;

  camera: Camera = { x: 0, y: 0, scale: 1 };
  tool: Tool = 'pen';
  style: ElementStyle = { ...DEFAULT_STYLE.pen };
  selection = new Set<string>();

  /** 正在绘制的临时笔迹，key 为 `${userId}:${strokeId}` */
  previews = new Map<string, WbPreviewBroadcast>();
  cursors = new Map<string, WbCursor>();
  /**
   * 正在绘制的本地笔迹。
   * pressures 与 points 一一对应；pen 为 false（鼠标/触屏）时不会写进元素。
   */
  localStroke: { strokeId: string; points: number[]; pressures: number[]; pen: boolean } | null = null;

  private undoStack: HistAction[][] = [];
  private redoStack: HistAction[][] = [];
  private recording = true;
  private listeners = new Set<() => void>();

  private lastPreviewAt = 0;
  private lastCursorAt = 0;
  private cursorSweeper: ReturnType<typeof setInterval> | null = null;
  private pageSendTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingPageSend: string | null = null;

  constructor(private readonly deps: WhiteboardDeps) {
    this.cursorSweeper = setInterval(() => this.sweepCursors(), 2000);
    this.cursorSweeper.unref?.();
  }

  /* ───────────────────────── 订阅 ───────────────────────── */

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  notify(): void {
    for (const fn of this.listeners) fn();
  }

  destroy(): void {
    if (this.cursorSweeper) clearInterval(this.cursorSweeper);
    if (this.pageSendTimer) clearTimeout(this.pageSendTimer);
    this.pageSendTimer = null;
    this.pendingPageSend = null;
    this.listeners.clear();
  }

  /* ───────────────────────── 服务端 → 本地 ───────────────────────── */

  applySync(payload: WbSyncPayload): void {
    this.doc.pages = payload.pages;
    this.doc.elements.clear();
    for (const el of payload.elements) this.doc.elements.set(el.id, el);
    // 服务端已保证 pageId 有效；这里再兜一层，避免异常快照把白板锁死在空页
    this.activePageId = payload.pages.some((p) => p.id === payload.pageId)
      ? payload.pageId
      : (payload.pages[0]?.id ?? '');
    this.seq = payload.seq;
    this.studentsCanDraw = payload.studentsCanDraw;

    for (const id of [...this.selection]) {
      const el = this.doc.elements.get(id);
      if (!el || el.deleted) this.selection.delete(id);
    }
    this.previews.clear();
    this.notify();
  }

  applyBroadcast(b: WbBroadcast): void {
    // 同一条广播可能因重同步被重放，用 seq 去重
    if (b.seq <= this.seq) return;
    this.seq = b.seq;

    // 与服务端共用同一份“应用 op”实现，避免两边规则漂移
    applyTrusted(this.doc, b.ops, b.revs);
    if (!this.doc.pages.some((p) => p.id === this.activePageId)) {
      this.activePageId = this.doc.pages[0]?.id ?? '';
    }
    this.notify();
  }

  /** 被拒绝：用权威元素覆盖本地，完成回拉 */
  applyReject(elements: WhiteboardElement[]): void {
    for (const el of elements) this.doc.elements.set(el.id, el);
    this.notify();
  }

  applyPreview(p: WbPreviewBroadcast): void {
    const key = `${p.userId}:${p.strokeId}`;
    if (p.done) this.previews.delete(key);
    else this.previews.set(key, p);
    this.notify();
  }

  applyCursors(cursors: WbCursor[]): void {
    for (const c of cursors) {
      if (c.ts === 0) this.cursors.delete(c.userId);
      else this.cursors.set(c.userId, c);
    }
    this.notify();
  }

  private sweepCursors(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, c] of this.cursors) {
      if (now - c.ts > CURSOR_TTL_MS) {
        this.cursors.delete(id);
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  /* ───────────────────────── 本地设置 ───────────────────────── */

  setActivePage(pageId: string): void {
    // 服务端会把自己刚翻的页再广播回来，同页重复设置不该清选区、重绘
    if (pageId === this.activePageId) return;
    this.activePageId = pageId;
    this.selection.clear();
    this.notify();
  }

  setLock(studentsCanDraw: boolean): void {
    this.studentsCanDraw = !!studentsCanDraw;
    this.notify();
  }

  setTool(tool: Tool): void {
    this.tool = tool;
    this.style = { ...(DEFAULT_STYLE[tool] ?? DEFAULT_STYLE.pen) };
    if (tool !== 'select') this.selection.clear();
    this.notify();
  }

  setStyle(patch: Partial<ElementStyle>): void {
    this.style = { ...this.style, ...patch };
    this.notify();
  }

  canDraw(): boolean {
    return canTeach(this.deps.role) || this.studentsCanDraw;
  }

  isTeacher(): boolean {
    return canTeach(this.deps.role);
  }

  get selfId(): string {
    return this.deps.selfId;
  }

  /* ───────────────────────── 本地 → 服务端 ───────────────────────── */

  private send(ops: WbOp[], pageId: string): void {
    const payload: WbOpPayload = { pageId, opId: uuid(), ops };
    this.deps.sendOp(payload, (ok, error) => {
      if (!ok && error === 'rate_limited') console.warn('[wb] op 被限流，等待下一次同步兜底');
    });
  }

  private record(actions: HistAction[]): void {
    if (!this.recording) return;
    this.undoStack.push(actions);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
  }

  elementsOnPage(pageId = this.activePageId): WhiteboardElement[] {
    const out: WhiteboardElement[] = [];
    for (const el of this.doc.elements.values()) {
      if (el.pageId === pageId && !el.deleted) out.push(el);
    }
    return out.sort(compareByOrder);
  }

  private nextOrder(pageId: string): string {
    let last: string | null = null;
    for (const el of this.doc.elements.values()) {
      if (el.pageId !== pageId || el.deleted) continue;
      if (last === null || el.order > last) last = el.order;
    }
    return keyAfter(last);
  }

  /** 新增元素：本地先落，再广播 */
  addElement(el: WhiteboardElement): void {
    if (!this.canDraw()) return;
    const local: WhiteboardElement = { ...el, order: this.nextOrder(el.pageId), rev: 1 };
    this.doc.elements.set(local.id, local);
    this.notify();
    this.record([{ kind: 'add', el: local }]);
    this.send([{ kind: 'add', el: local }], local.pageId);
  }

  patchElement(id: string, patch: Partial<WhiteboardElement>): void {
    const cur = this.doc.elements.get(id);
    if (!cur || cur.deleted || !this.canDraw()) return;

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const k of Object.keys(patch) as (keyof WhiteboardElement)[]) {
      before[k] = cur[k];
      after[k] = patch[k];
    }

    this.doc.elements.set(id, { ...cur, ...patch, rev: cur.rev + 1, updatedAt: Date.now() });
    this.notify();
    this.record([{ kind: 'patch', id, before, after }]);
    this.send([{ kind: 'patch', id, rev: cur.rev, patch }], cur.pageId);
  }

  removeElement(id: string): void {
    const cur = this.doc.elements.get(id);
    if (!cur || cur.deleted || !this.canDraw()) return;

    this.doc.elements.set(id, { ...cur, deleted: true, rev: cur.rev + 1 });
    this.selection.delete(id);
    this.notify();
    // 删除不进 undo 栈：协议第 4 条禁止同一个 id 复活
    this.send([{ kind: 'remove', id, rev: cur.rev }], cur.pageId);
  }

  /* ───────────────────────── 撤销 / 重做 ───────────────────────── */

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const actions = this.undoStack.pop();
    if (!actions) return;
    this.recording = false;
    for (let i = actions.length - 1; i >= 0; i--) {
      const a = actions[i] as HistAction;
      if (a.kind === 'add') this.removeElement(a.el.id);
      else this.patchElement(a.id, a.before as Partial<WhiteboardElement>);
    }
    this.recording = true;
    this.redoStack.push(actions);
    this.notify();
  }

  redo(): void {
    const actions = this.redoStack.pop();
    if (!actions) return;
    this.recording = false;
    for (const a of actions) {
      if (a.kind === 'add') {
        // 换新 id：墓碑不允许原地复活
        this.addElement({ ...a.el, id: uuid(), rev: 1 });
      } else {
        this.patchElement(a.id, a.after as Partial<WhiteboardElement>);
      }
    }
    this.recording = true;
    this.undoStack.push(actions);
    this.notify();
  }

  /* ───────────────────────── 笔迹预览 ───────────────────────── */

  /**
   * @param pressure 压感 0~1，鼠标传 1；数位笔直接给 event.pressure
   * @param pen 是否数位笔。只有 true 才会把压感写进元素，避免鼠标笔迹凭空多一份数组
   */
  startStroke(x: number, y: number, pressure = 1, pen = false): void {
    this.localStroke = { strokeId: uuid(), points: [x, y], pressures: [pressure], pen };
    this.pushPreview(true);
  }

  extendStroke(x: number, y: number, pressure = 1): void {
    const s = this.localStroke;
    if (!s) return;
    const pts = s.points;
    const dx = x - (pts[pts.length - 2] as number);
    const dy = y - (pts[pts.length - 1] as number);
    if (dx * dx + dy * dy < 1.2) return;
    pts.push(x, y);
    s.pressures.push(pressure);
    this.pushPreview(false);
  }

  endStroke(
    build: (points: number[], pressures?: number[]) => WhiteboardElement | null,
  ): WhiteboardElement | null {
    const stroke = this.localStroke;
    this.localStroke = null;
    if (!stroke) return null;
    this.pushPreview(true);

    const { points, pressures } = simplifyStroke(stroke.points, stroke.pressures, 1.2);
    if (points.length < 4) return null;

    // 压感全一样（轻压到底 / 驱动只报固定值）时没必要存一份数组，按普通笔画处理
    const keepPressure = stroke.pen && pressures !== undefined && hasPressureVariation(pressures);
    const el = build(points, keepPressure ? pressures : undefined);
    if (el) this.addElement(el);
    return el;
  }

  private pushPreview(done: boolean): void {
    const s = this.localStroke;
    if (!s) return;
    const now = Date.now();
    if (!done && now - this.lastPreviewAt < PREVIEW_INTERVAL_MS) return;
    this.lastPreviewAt = now;

    this.deps.sendPreview({
      pageId: this.activePageId,
      strokeId: s.strokeId,
      type: this.tool === 'highlighter' ? 'highlighter' : 'pen',
      color: this.style.stroke,
      width: this.style.strokeWidth,
      points: s.points,
      ...(s.pen ? { pressures: s.pressures } : {}),
      done,
    });
  }

  /* ───────────────────────── 光标 / 相机 ───────────────────────── */

  pushCursor(x: number | null, y: number | null): void {
    const now = Date.now();
    if (x !== null && now - this.lastCursorAt < CURSOR_INTERVAL_MS) return;
    this.lastCursorAt = now;
    this.deps.sendCursor({ pageId: this.activePageId, x, y, tool: this.tool });
  }

  panBy(dx: number, dy: number): void {
    this.camera = { ...this.camera, x: this.camera.x + dx, y: this.camera.y + dy };
    this.notify();
  }

  setCamera(cam: Camera): void {
    this.camera = cam;
    this.notify();
  }

  zoomAtPoint(sx: number, sy: number, factor: number): void {
    this.camera = zoomAt(this.camera, sx, sy, factor);
    this.notify();
  }

  fitPage(viewportW: number, viewportH: number): void {
    const page = this.currentPage();
    if (!page) return;
    const pad = 36;
    const scale = Math.min((viewportW - pad * 2) / page.width, (viewportH - pad * 2) / page.height);
    const s = Math.max(0.1, Math.min(4, scale));
    this.camera = {
      scale: s,
      x: (viewportW - page.width * s) / 2,
      y: (viewportH - page.height * s) / 2,
    };
    this.notify();
  }

  currentPage(): PageMeta | null {
    return this.doc.pages.find((p) => p.id === this.activePageId) ?? this.doc.pages[0] ?? null;
  }

  visibleOnActive(): WhiteboardElement[] {
    return visibleElements(this.doc, this.activePageId);
  }

  /* ───────────────────────── 页面管理（老师） ───────────────────────── */

  addPage(name?: string): void {
    if (!this.isTeacher() || this.doc.pages.length >= MAX_PAGES) return;
    const cur = this.currentPage();
    const page: PageMeta = {
      id: uuid(),
      index: this.doc.pages.length,
      name: name ?? `第 ${this.doc.pages.length + 1} 页`,
      width: cur?.width ?? 1600,
      height: cur?.height ?? 900,
      background: null,
    };
    this.doc.pages.push(page);
    // 注意：op 的 pageId 必须是「已经存在的页」。服务端会校验它，
    // 如果传新页的 id，此时服务端还没这页，整个 op 会被判成 bad_op。
    this.send([{ kind: 'page.add', page }], cur?.id ?? '');
    this.deps.sendPage(page.id);
    this.setActivePage(page.id);
  }

  deletePage(pageId: string): void {
    if (!this.isTeacher() || this.doc.pages.length <= 1) return;
    this.doc.pages = this.doc.pages.filter((p) => p.id !== pageId);
    if (this.activePageId === pageId) this.activePageId = this.doc.pages[0]?.id ?? '';
    this.send([{ kind: 'page.del', pageId }], this.activePageId);
    this.notify();
  }

  /**
   * 导入课件：一次加多页，每页带一张背景图，然后跳到第一页。
   *
   * 多页合成一条 wb:op 发出去（同一批 op 服务端会按顺序处理），
   * 比逐页发少了 N-1 次往返，也不会出现「只加了一半」的中间态。
   */
  addPagesWithBackground(
    items: { name: string; width: number; height: number; fileId: string }[],
  ): string[] {
    if (!this.isTeacher() || items.length === 0) return [];

    // 服务端会在超限时拒绝 page.add；客户端先截断，避免留下服务端不存在的幽灵页
    const budget = MAX_PAGES - this.doc.pages.length;
    if (budget <= 0) return [];
    const accepted = items.slice(0, budget);

    const anchor = this.currentPage()?.id ?? this.activePageId;
    const baseIndex = this.doc.pages.length;
    const ops: WbOp[] = [];
    const ids: string[] = [];

    accepted.forEach((item, i) => {
      const page: PageMeta = {
        id: uuid(),
        index: baseIndex + i,
        name: item.name,
        width: item.width,
        height: item.height,
        background: { fileId: item.fileId, width: item.width, height: item.height },
      };
      this.doc.pages.push(page);
      ops.push({ kind: 'page.add', page });
      ids.push(page.id);
    });

    this.send(ops, anchor);
    const first = ids[0];
    if (first) {
      this.deps.sendPage(first);
      this.setActivePage(first);
    }
    this.notify();
    return ids;
  }

  goToPage(pageId: string): void {
    if (!this.isTeacher()) return;
    if (pageId === this.activePageId) return;
    if (!this.doc.pages.some((p) => p.id === pageId)) return;
    this.setActivePage(pageId);
    this.queuePageSend();
  }

  /**
   * 翻页消息合并发送。
   *
   * 本地页立即切换；发给服务端的只保留 60ms 窗口内的最终页，
   * 避免连点 5 次就让全班跟着加载 5 张中间页背景。
   */
  private queuePageSend(): void {
    this.pendingPageSend = this.activePageId;
    if (this.pageSendTimer) return;
    this.pageSendTimer = setTimeout(() => {
      this.pageSendTimer = null;
      const pageId = this.pendingPageSend;
      this.pendingPageSend = null;
      // 期间可能又加了页/导入了课件，只有仍是当前页才值得广播
      if (pageId && pageId === this.activePageId) this.deps.sendPage(pageId);
    }, PAGE_SEND_COALESCE_MS);
    this.pageSendTimer.unref?.();
  }

  toggleLock(): void {
    if (!this.isTeacher()) return;
    this.studentsCanDraw = !this.studentsCanDraw;
    this.deps.sendLock(this.studentsCanDraw);
    this.notify();
  }
}
