import type { ElementType, WhiteboardElement } from '../protocol/whiteboard';

/** 默认调色板（ClassIn 风格的柔和色，投影仪上也看得清） */
export const PALETTE = [
  '#1f2937',
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#0ea5e9',
  '#6366f1',
  '#ec4899',
] as const;

export const DEFAULT_STROKE = PALETTE[0];
export const DEFAULT_STROKE_WIDTH = 3;
export const DEFAULT_FONT_SIZE = 24;
export const DEFAULT_FONT_FAMILY = '"PingFang SC", "Microsoft YaHei", sans-serif';

export const TOOLS = [
  'select',
  'pen',
  'highlighter',
  'eraser',
  'rect',
  'ellipse',
  'arrow',
  'line',
  'text',
  'image',
  'laser',
] as const;

export type Tool = (typeof TOOLS)[number];

/** 每个工具对应的鼠标指针 */
export const TOOL_CURSOR: Record<Tool, string> = {
  select: 'default',
  pen: 'crosshair',
  highlighter: 'crosshair',
  eraser: 'cell',
  rect: 'crosshair',
  ellipse: 'crosshair',
  arrow: 'crosshair',
  line: 'crosshair',
  text: 'text',
  image: 'copy',
  laser: 'crosshair',
};

/** 工具产出哪种元素 */
export const TOOL_ELEMENT: Partial<Record<Tool, ElementType>> = {
  pen: 'pen',
  highlighter: 'highlighter',
  rect: 'rect',
  ellipse: 'ellipse',
  arrow: 'arrow',
  line: 'line',
  text: 'text',
  image: 'image',
};

export interface ElementStyle {
  stroke: string;
  strokeWidth: number;
  fill: string;
  opacity: number;
}

export const DEFAULT_STYLE: Record<Tool, ElementStyle> = {
  select: { stroke: DEFAULT_STROKE, strokeWidth: DEFAULT_STROKE_WIDTH, fill: 'transparent', opacity: 1 },
  pen: { stroke: DEFAULT_STROKE, strokeWidth: DEFAULT_STROKE_WIDTH, fill: 'transparent', opacity: 1 },
  highlighter: { stroke: '#fde047', strokeWidth: 18, fill: 'transparent', opacity: 0.35 },
  eraser: { stroke: DEFAULT_STROKE, strokeWidth: 16, fill: 'transparent', opacity: 1 },
  rect: { stroke: DEFAULT_STROKE, strokeWidth: DEFAULT_STROKE_WIDTH, fill: 'transparent', opacity: 1 },
  ellipse: { stroke: DEFAULT_STROKE, strokeWidth: DEFAULT_STROKE_WIDTH, fill: 'transparent', opacity: 1 },
  arrow: { stroke: DEFAULT_STROKE, strokeWidth: DEFAULT_STROKE_WIDTH, fill: 'transparent', opacity: 1 },
  line: { stroke: DEFAULT_STROKE, strokeWidth: DEFAULT_STROKE_WIDTH, fill: 'transparent', opacity: 1 },
  text: { stroke: DEFAULT_STROKE, strokeWidth: 1, fill: DEFAULT_STROKE, opacity: 1 },
  image: { stroke: 'transparent', strokeWidth: 0, fill: 'transparent', opacity: 1 },
  laser: { stroke: '#ef4444', strokeWidth: 4, fill: 'transparent', opacity: 1 },
};

export const TOOL_LABEL: Record<Tool, string> = {
  select: '选择',
  pen: '画笔',
  highlighter: '荧光笔',
  eraser: '橡皮',
  rect: '矩形',
  ellipse: '椭圆',
  arrow: '箭头',
  line: '直线',
  text: '文本',
  image: '图片',
  laser: '激光笔',
};
