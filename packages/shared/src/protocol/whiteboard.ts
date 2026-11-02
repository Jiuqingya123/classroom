/**
 * 白板数据模型与协同协议。
 *
 * 协同模型：服务端权威 doc + op 广播 + 房间级单调 seq。不用 CRDT。
 * 收敛规则（顺序不可交换，实现时必须逐条对齐）：
 *  1. 创建：`order` 由服务端生成，客户端传来的被忽略 → 永不撞车
 *  2. 修改：`rev` 乐观锁，先到服务端者胜，后到者收 reject 并回拉权威值
 *  3. 自由笔迹：pointerup 前只发 `wb:preview`（不入 seq / 不落库），commit 时才发一条 add
 *  4. 删除：软删 `deleted:true`，后续 patch 一律 reject → 不会「已删元素被改活」
 */

export type ElementType =
  | 'pen'
  | 'highlighter'
  | 'rect'
  | 'ellipse'
  | 'arrow'
  | 'line'
  | 'text'
  | 'image';

/** 白板元素。纯 JSON 可序列化，直接落库与广播。坐标均为「世界坐标」。 */
export interface WhiteboardElement {
  id: string;
  pageId: string;
  type: ElementType;
  /** 乐观锁版本，每次被服务端成功 patch 后 +1 */
  rev: number;
  /** fractional index，决定 z 序；服务端分配 */
  order: string;

  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  scaleX: number;
  scaleY: number;

  /** pen / highlighter / line：扁平点集 [x0,y0,x1,y1,...]，相对 (x,y) */
  points?: number[];
  /**
   * 逐点压感 [0,1]，与 points 一一对应。
   *
   * 只有数位笔（pointerType === 'pen'）绘制时才有值；鼠标/触屏笔迹没有这个字段，
   * 渲染端必须能同时处理「有压感」和「无压感」两种情况（老客户端也会忽略它）。
   */
  pressures?: number[];
  stroke?: string;
  strokeWidth?: number;
  fill?: string;
  opacity?: number;

  text?: string;
  fontSize?: number;
  fontFamily?: string;
  fontStyle?: string;

  /** image：fileId，渲染为 `/files/<fileId>` */
  src?: string;

  /** 老师锁定的元素，仅创建者可改 */
  locked?: boolean;
  /** 软删标记（墓碑），防止晚到的 patch 复活元素 */
  deleted?: boolean;

  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

/** 页面背景（PDF 课件导入后为一张图片） */
export interface PageBackground {
  fileId: string;
  width: number;
  height: number;
}

export interface PageMeta {
  id: string;
  index: number;
  name: string;
  /** 逻辑画布尺寸，决定白板页比例 */
  width: number;
  height: number;
  background: PageBackground | null;
}

export type WbOp =
  | { kind: 'add'; el: WhiteboardElement }
  | { kind: 'patch'; id: string; rev: number; patch: Partial<WhiteboardElement> }
  | { kind: 'remove'; id: string; rev: number }
  | { kind: 'page.add'; page: PageMeta }
  | { kind: 'page.del'; pageId: string }
  | { kind: 'page.reorder'; order: string[] };

export type WbRejectReason =
  | 'rev_conflict'
  | 'locked'
  | 'forbidden'
  | 'rate_limited'
  | 'bad_op'
  | 'too_large';

/** C→S：一批 op（一次指针抬起通常只有 1 条） */
export interface WbOpPayload {
  pageId: string;
  /** 客户端生成的幂等键，服务端据此去重 */
  opId: string;
  ops: WbOp[];
}

/** S→C：服务端已接受并落 seq 后广播（含发起者自己） */
export interface WbBroadcast {
  pageId: string;
  seq: number;
  by: string;
  opId: string;
  ops: WbOp[];
  /** 服务端回填的权威 rev，客户端据此校正本地版本 */
  revs: Record<string, number>;
}

/** S→C：join / resync 时的全量快照。永不做增量。 */
export interface WbSyncPayload {
  pageId: string;
  seq: number;
  pages: PageMeta[];
  elements: WhiteboardElement[];
  studentsCanDraw: boolean;
}

/** 绘制中的临时笔迹，高频但无状态，不入 seq */
export interface WbPreviewPayload {
  pageId: string;
  strokeId: string;
  type: ElementType;
  color: string;
  width: number;
  points: number[];
  /** 逐点压感，语义同 WhiteboardElement.pressures；预览和最终笔画必须用同一套宽度映射 */
  pressures?: number[];
  /** 抬手时为 true，对端据此清掉临时笔迹（真正的元素随后经 wb:op 到达） */
  done?: boolean;
}

export interface WbPreviewBroadcast extends WbPreviewPayload {
  userId: string;
  done: boolean;
}

export interface WbCursor {
  userId: string;
  pageId: string;
  x: number;
  y: number;
  tool: string;
  ts: number;
}

export interface WbLockState {
  studentsCanDraw: boolean;
  by: string;
}
