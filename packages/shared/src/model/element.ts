import type { ElementType, WhiteboardElement } from '../protocol/whiteboard';
import { uuid } from '../util';

export interface CreateElementInput {
  pageId: string;
  type: ElementType;
  createdBy: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  order?: string;
  [key: string]: unknown;
}

/** 生成一个「未提交」的元素骨架。order 由服务端在 add 时重写，这里的值只是占位。 */
export function createElement(input: CreateElementInput): WhiteboardElement {
  const t = Date.now();
  return {
    id: uuid(),
    pageId: input.pageId,
    type: input.type,
    rev: 1,
    order: input.order ?? 'aV',
    x: input.x ?? 0,
    y: input.y ?? 0,
    width: input.width ?? 0,
    height: input.height ?? 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    createdBy: input.createdBy,
    createdAt: t,
    updatedAt: t,
  };
}

/** 元素是否可见（未被软删） */
export function isVisible(el: WhiteboardElement): boolean {
  return el.deleted !== true;
}

/** 该元素是否属于「一次性笔迹」类（提交后不可再变换，走不可变路径） */
export function isStroke(type: ElementType): boolean {
  return type === 'pen' || type === 'highlighter';
}

/** 该元素是否允许被 Transformer 变换 */
export function isTransformable(type: ElementType): boolean {
  return type === 'rect' || type === 'ellipse' || type === 'arrow' || type === 'line' || type === 'text' || type === 'image';
}

/** 从元素上剥掉不可由客户端修改的字段，用于服务端校验前的清洗 */
export function stripServerFields(el: WhiteboardElement): WhiteboardElement {
  return { ...el, rev: 1 };
}
