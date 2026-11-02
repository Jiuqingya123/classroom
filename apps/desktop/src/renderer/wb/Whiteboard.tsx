import Konva from 'konva';
import { useEffect, useRef, useState } from 'react';
import {
  screenToWorld,
  TOOL_CURSOR,
  uuid,
  worldToScreen,
  type ElementType,
  type PageMeta,
  type Tool,
  type WhiteboardElement,
} from '@classroom/shared';
import type { WhiteboardClient } from '@classroom/client-core';
import { ensureFileUrl } from '../lib/files';
import { createInkShape } from './ink';
import { DROP_LABELS, penDebug } from './penDebug';

/**
 * 从 PointerEvent 里取压感。
 *
 * 数位板（高漫 / Wacom 等）在 Windows 上通过 Windows Ink 报 pointerType='pen'，
 * pressure 是 0~1 的浮点；鼠标恒定 0.5，触屏多为 0 —— 这两种一律当满压处理，
 * 否则鼠标画的线会莫名其妙变细一半。
 *
 * 部分驱动在按下瞬间报 0，等第一个 move 才有真实值，所以 0 也按满压兜底。
 */
function pointerInfo(ev: PointerEvent | MouseEvent): { pressure: number; isPen: boolean } {
  const e = ev as PointerEvent;
  const isPen = e.pointerType === 'pen';
  const raw = typeof e.pressure === 'number' ? e.pressure : 0;
  const pressure = isPen && raw > 0.005 ? Math.min(1, raw) : 1;
  return { pressure, isPen };
}

interface Props {
  client: WhiteboardClient;
  names: Record<string, string>;
}

interface Draft {
  type: ElementType;
  startX: number;
  startY: number;
  curX: number;
  curY: number;
}

interface Editing {
  id: string;
  value: string;
  left: number;
  top: number;
  width: number;
  fontSize: number;
  color: string;
}

const TOOL_SHAPE: Partial<Record<Tool, ElementType>> = {
  rect: 'rect',
  ellipse: 'ellipse',
  arrow: 'arrow',
  line: 'line',
};

const MIN_SHAPE_SIZE = 6;

/**
 * 课件背景图缓存（按 fileId 存已解码的位图）。
 *
 * 每次翻页都重新请求 + 解码一张 1600×2264 的图，会让画面在切页后顿一下；
 * 缓存最近几页、并预取前后页，左右翻页就只剩一次 drawImage。
 * 单页解码后约 14MB，5 页封顶，避免整本课件常驻内存。
 */
const BG_CACHE_LIMIT = 5;
const BG_RETRY_MS = 2000;
const bgImages = new Map<string, HTMLImageElement>();
const bgLoading = new Map<string, Promise<HTMLImageElement | null>>();

function takeCachedBg(fileId: string): HTMLImageElement | null {
  const img = bgImages.get(fileId);
  if (!img) return null;
  bgImages.delete(fileId);
  bgImages.set(fileId, img); // LRU：刚用过的排到最后
  return img;
}

function putCachedBg(fileId: string, img: HTMLImageElement): void {
  bgImages.delete(fileId);
  bgImages.set(fileId, img);
  while (bgImages.size > BG_CACHE_LIMIT) {
    const oldest = bgImages.keys().next().value;
    if (oldest === undefined) break;
    bgImages.delete(oldest);
  }
}

async function decodeBgImage(url: string): Promise<HTMLImageElement | null> {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  try {
    // onload 只代表下载完成，decode() 才等到位图可同步绘制；不等它首帧会掉帧
    await img.decode();
    return img;
  } catch {
    return null;
  }
}

/** 取一张已解码的背景图；同一张图的并发请求合并为一次加载 */
function loadBgImage(fileId: string): Promise<HTMLImageElement | null> {
  const hit = takeCachedBg(fileId);
  if (hit) return Promise.resolve(hit);
  const pending = bgLoading.get(fileId);
  if (pending) return pending;

  const task = (async () => {
    try {
      const url = await ensureFileUrl(fileId);
      if (!url) return null;
      const img = await decodeBgImage(url);
      if (img) putCachedBg(fileId, img);
      return img;
    } catch {
      return null;
    }
  })().finally(() => {
    bgLoading.delete(fileId);
  });
  bgLoading.set(fileId, task);
  return task;
}

/**
 * Konva 白板。
 *
 * 刻意不用 react-konva：手写时预览笔迹会以 60Hz 更新，走 React 重渲染
 * 会连带整棵元素树 diff 一遍。这里 Stage 只建一次，状态变更走订阅 + 命令式重绘，
 * React 只负责工具栏和文本编辑框这种低频 UI。
 */
export function Whiteboard({ client, names }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const editingRef = useRef<Editing | null>(null);
  editingRef.current = editing;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    const stage = new Konva.Stage({
      container: wrap,
      width: Math.max(1, wrap.clientWidth),
      height: Math.max(1, wrap.clientHeight),
    });

    const pageLayer = new Konva.Layer({ listening: false });
    const content = new Konva.Layer();
    const uiLayer = new Konva.Layer();
    const previewLayer = new Konva.Layer({ listening: false });
    const overlay = new Konva.Layer({ listening: false });
    stage.add(pageLayer, content, uiLayer, previewLayer, overlay);

    const pageRect = new Konva.Rect({
      x: 0,
      y: 0,
      fill: '#ffffff',
      shadowColor: 'rgba(8, 12, 20, 0.45)',
      shadowBlur: 28,
      shadowOffsetY: 8,
      listening: false,
    });
    pageLayer.add(pageRect);

    const transformer = new Konva.Transformer({
      rotateEnabled: true,
      borderStroke: '#2f6bff',
      anchorStroke: '#2f6bff',
      anchorFill: '#ffffff',
      anchorSize: 8,
      anchorCornerRadius: 3,
      ignoreStroke: true,
      rotateAnchorOffset: 26,
      padding: 2,
    });
    uiLayer.add(transformer);

    const nodes = new Map<string, Konva.Node>();
    // 文档里的元素是不可变替换的：引用没变就不必每帧重设几十个 Konva 属性
    const nodeEls = new Map<string, WhiteboardElement>();
    const nodeZ = new Map<string, number>();
    let lastTool = client.tool;
    const imageCache = new Map<string, HTMLImageElement>();
    let draft: Draft | null = null;
    let pan: { sx: number; sy: number; camX: number; camY: number; pointerId: number } | null = null;
    let bgImage: Konva.Image | null = null;
    let bgFileId: string | null = null;
    /** 每发起一次背景加载就加一，用来丢弃「翻页前发出的、现在才回来」的结果 */
    let bgGeneration = 0;
    let bgRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let bgFailedFile: string | null = null;
    let bgFailedAt = 0;

    /* ───────────────── 相机 ───────────────── */

    function applyCamera(): void {
      const { x, y, scale } = client.camera;
      for (const layer of [pageLayer, content, uiLayer, previewLayer]) {
        layer.position({ x, y });
        layer.scale({ x: scale, y: scale });
      }
      stage.batchDraw();
    }

    /* ───────────────── 元素节点 ───────────────── */

    function buildNode(el: WhiteboardElement): Konva.Shape {
      const common = {
        x: el.x,
        y: el.y,
        scaleX: el.scaleX ?? 1,
        scaleY: el.scaleY ?? 1,
        rotation: el.rotation ?? 0,
        draggable: client.tool === 'select',
      };

      switch (el.type) {
        case 'pen':
        case 'highlighter': {
          // 数位笔画出的可变宽笔迹，走自绘节点；鼠标笔迹没有 pressures，继续用 Konva.Line
          if (el.pressures && el.pressures.length > 0) {
            return createInkShape({
              points: el.points ?? [],
              pressures: el.pressures,
              strokeWidth: el.strokeWidth ?? 3,
              color: el.stroke ?? '#1f2937',
              opacity: el.opacity ?? 1,
              highlighter: el.type === 'highlighter',
            });
          }
          return new Konva.Line({
            ...common,
            points: el.points ?? [],
            stroke: el.stroke ?? '#1f2937',
            strokeWidth: el.strokeWidth ?? 3,
            opacity: el.opacity ?? 1,
            lineCap: 'round',
            lineJoin: 'round',
            tension: 0.35,
            globalCompositeOperation: el.type === 'highlighter' ? 'multiply' : 'source-over',
            // 细线不好点中，放大命中区域
            hitStrokeWidth: Math.max(14, (el.strokeWidth ?? 3) + 10),
          });
        }
        case 'rect':
          return new Konva.Rect({
            ...common,
            width: el.width,
            height: el.height,
            stroke: el.stroke ?? '#1f2937',
            strokeWidth: el.strokeWidth ?? 3,
            fill: el.fill && el.fill !== 'transparent' ? el.fill : undefined,
            cornerRadius: 2,
          });
        case 'ellipse':
          return new Konva.Ellipse({
            ...common,
            // Ellipse 的 x/y 是圆心，模型里存的是包围盒左上角
            x: el.x + el.width / 2,
            y: el.y + el.height / 2,
            radiusX: Math.max(el.width / 2, 0.5),
            radiusY: Math.max(el.height / 2, 0.5),
            stroke: el.stroke ?? '#1f2937',
            strokeWidth: el.strokeWidth ?? 3,
            fill: el.fill && el.fill !== 'transparent' ? el.fill : undefined,
          });
        case 'arrow':
          return new Konva.Arrow({
            ...common,
            points: el.points ?? [0, 0, 1, 1],
            stroke: el.stroke ?? '#1f2937',
            fill: el.stroke ?? '#1f2937',
            strokeWidth: el.strokeWidth ?? 3,
            pointerLength: 10 + (el.strokeWidth ?? 3) * 1.6,
            pointerWidth: 9 + (el.strokeWidth ?? 3) * 1.5,
            lineCap: 'round',
            hitStrokeWidth: Math.max(16, (el.strokeWidth ?? 3) + 12),
          });
        case 'line':
          return new Konva.Line({
            ...common,
            points: el.points ?? [0, 0, 1, 1],
            stroke: el.stroke ?? '#1f2937',
            strokeWidth: el.strokeWidth ?? 3,
            lineCap: 'round',
            hitStrokeWidth: Math.max(16, (el.strokeWidth ?? 3) + 12),
          });
        case 'text':
          return new Konva.Text({
            ...common,
            text: el.text ?? '',
            fontSize: el.fontSize ?? 24,
            fontFamily: el.fontFamily ?? '"PingFang SC", "Microsoft YaHei", sans-serif',
            fontStyle: el.fontStyle ?? 'normal',
            fill: el.stroke ?? '#1f2937',
            width: el.width > 0 ? el.width : undefined,
            lineHeight: 1.3,
            wrap: 'word',
          });
        case 'image':
        default: {
          const img = el.src ? imageCache.get(el.src) : undefined;
          return new Konva.Image({
            ...common,
            image: img,
            width: el.width,
            height: el.height,
            stroke: '#cbd5e1',
            strokeWidth: 1,
          });
        }
      }
    }

    function updateNode(node: Konva.Shape, el: WhiteboardElement): void {
      const scaleX = el.scaleX ?? 1;
      const scaleY = el.scaleY ?? 1;
      const rot = el.rotation ?? 0;

      if (el.type === 'ellipse') {
        node.setAttrs({
          x: el.x + (el.width * scaleX) / 2,
          y: el.y + (el.height * scaleY) / 2,
        });
        (node as Konva.Ellipse).radiusX(Math.max((el.width * scaleX) / 2, 0.5));
        (node as Konva.Ellipse).radiusY(Math.max((el.height * scaleY) / 2, 0.5));
        node.setAttrs({ scaleX: 1, scaleY: 1, rotation: rot });
      } else {
        node.setAttrs({ x: el.x, y: el.y, scaleX, scaleY, rotation: rot });
      }

      if (el.points) node.setAttr('points', el.points);

      if (el.type === 'text') {
        // 文本的 width=0 表示「自适应宽度」。直接 setAttr('width', 0) 会把文字压成 0 宽，
        // 表现就是「第一帧还在、第二帧消失」，必须显式还原成 auto。
        // Konva 的 TS 类型把 width 限成 number，但运行时接受 'auto'，这里绕开类型。
        (node as unknown as { setAttr(k: string, v: unknown): void }).setAttr(
          'width',
          el.width > 0 ? el.width : 'auto',
        );
      } else if (el.type !== 'ellipse' && el.width !== undefined) {
        node.setAttr('width', el.width);
      }
      if (el.type !== 'ellipse' && el.type !== 'text' && el.height !== undefined) {
        node.setAttr('height', el.height);
      }

      if (el.stroke !== undefined) {
        if (el.type === 'text') node.setAttr('fill', el.stroke);
        else node.setAttr('stroke', el.stroke);
        if (el.type === 'arrow') node.setAttr('fill', el.stroke);
      }
      if (el.strokeWidth !== undefined && el.type !== 'text') node.setAttr('strokeWidth', el.strokeWidth);
      if (el.opacity !== undefined) node.setAttr('opacity', el.opacity);
      if (el.text !== undefined) node.setAttr('text', el.text);
      if (el.fontSize !== undefined) node.setAttr('fontSize', el.fontSize);
    }

    function patchFromNode(el: WhiteboardElement, node: Konva.Shape): Partial<WhiteboardElement> {
      if (el.points && el.points.length >= 4 && el.type !== 'rect' && el.type !== 'ellipse') {
        return {
          x: node.x(),
          y: node.y(),
          scaleX: node.scaleX(),
          scaleY: node.scaleY(),
          rotation: node.rotation(),
        };
      }
      if (el.type === 'ellipse') {
        const scaleX = node.scaleX();
        const scaleY = node.scaleY();
        return {
          x: node.x() - (el.width * scaleX) / 2,
          y: node.y() - (el.height * scaleY) / 2,
          scaleX,
          scaleY,
          rotation: node.rotation(),
        };
      }
      return {
        x: node.x(),
        y: node.y(),
        scaleX: node.scaleX(),
        scaleY: node.scaleY(),
        rotation: node.rotation(),
      };
    }

    function syncContent(): void {
      const page = client.currentPage();
      if (page) {
        pageRect.setAttrs({ width: page.width, height: page.height });
      }
      void syncBackground(page);

      const els = client.visibleOnActive();
      const seen = new Set<string>();
      const toolChanged = lastTool !== client.tool;
      if (toolChanged) lastTool = client.tool;

      els.forEach((el, index) => {
        seen.add(el.id);
        const node = nodes.get(el.id);
        if (!node) {
          const created = buildNode(el);
          created.id(el.id);
          content.add(created);
          created.zIndex(index);
          nodes.set(el.id, created);
          nodeEls.set(el.id, el);
          nodeZ.set(el.id, index);

          created.on('dragend', () => {
            const cur = client.doc.elements.get(el.id);
            if (cur) client.patchElement(el.id, patchFromNode(cur, created));
          });
          created.on('pointerdown', (e) => {
            if (client.tool !== 'select') return;
            e.cancelBubble = true;
            if (!e.evt.shiftKey) client.selection.clear();
            client.selection.add(el.id);
            client.notify();
          });
        } else {
          if (toolChanged || nodeEls.get(el.id) !== el) {
            updateNode(node as Konva.Shape, el);
            (node as Konva.Shape).draggable(client.tool === 'select');
            nodeEls.set(el.id, el);
          }
          if (nodeZ.get(el.id) !== index) {
            node.zIndex(index);
            nodeZ.set(el.id, index);
          }
        }
      });

      for (const [id, node] of [...nodes]) {
        if (!seen.has(id)) {
          node.destroy();
          nodes.delete(id);
          nodeEls.delete(id);
          nodeZ.delete(id);
        }
      }

      const selectedNodes = client.tool === 'select'
        ? [...client.selection].map((id) => nodes.get(id)).filter((n): n is Konva.Node => !!n)
        : [];
      transformer.nodes(selectedNodes);
      transformer.visible(selectedNodes.length > 0);
      content.batchDraw();
      uiLayer.batchDraw();
    }

    /* ───────────────── 页面背景（课件图） ───────────────── */

    function applyBackground(img: HTMLImageElement, bg: NonNullable<PageMeta['background']>): void {
      bgImage?.destroy();
      bgImage = new Konva.Image({
        image: img,
        x: 0,
        y: 0,
        width: bg.width,
        height: bg.height,
        listening: false,
      });
      pageLayer.add(bgImage);
      // 保证白底在下、背景图在上
      pageRect.moveToBottom();
      schedule();
    }

    /** 预取前后页：左右翻页是最常见的操作，等点下去再下载就晚了 */
    function preloadNeighborBackgrounds(): void {
      const list = client.doc.pages;
      const idx = list.findIndex((p) => p.id === client.activePageId);
      if (idx < 0) return;
      for (const bg of [list[idx + 1]?.background, list[idx - 1]?.background]) {
        if (bg) void loadBgImage(bg.fileId);
      }
    }

    function retryFailedBackground(fileId: string): void {
      bgRetryTimer = setTimeout(() => {
        bgRetryTimer = null;
        if (bgFileId !== fileId) return; // 已经翻到别的页，没必要再试
        bgFileId = null; // 放开去重，下一次调度重新加载
        schedule();
      }, BG_RETRY_MS);
      bgRetryTimer.unref?.();
    }

    /**
     * 背景是签名 URL 的位图，同步拿不到，只能异步加载。
     * 用 bgGeneration 做竞态守卫：加载期间用户可能已经翻到别的页了。
     */
    async function syncBackground(page: PageMeta | null): Promise<void> {
      const bg = page?.background ?? null;
      if (!bg) {
        if (bgFileId !== null || bgImage) {
          bgGeneration += 1; // 作废在途加载，否则旧页的图会落到没有背景的新页上
          bgFileId = null;
          bgImage?.destroy();
          bgImage = null;
        }
        return;
      }
      if (bgFileId === bg.fileId) {
        bgImage?.width(bg.width);
        bgImage?.height(bg.height);
        return;
      }

      bgFileId = bg.fileId;
      const generation = ++bgGeneration;

      // 新页的元素已经画上来了，底下再压着上一页课件会让人误判成「没翻过去」
      bgImage?.destroy();
      bgImage = null;

      // 刚失败过的图先冷却，避免每帧重绘都重新打一次网络
      if (bgFailedFile === bg.fileId && Date.now() - bgFailedAt < BG_RETRY_MS) {
        if (!bgRetryTimer) retryFailedBackground(bg.fileId);
        return;
      }

      const cached = takeCachedBg(bg.fileId);
      if (cached) {
        applyBackground(cached, bg);
        preloadNeighborBackgrounds();
        return;
      }

      const img = await loadBgImage(bg.fileId);
      if (generation !== bgGeneration) return;
      if (!img) {
        console.warn('[wb] 背景图加载失败', bg.fileId);
        bgFailedFile = bg.fileId;
        bgFailedAt = Date.now();
        if (!bgRetryTimer) retryFailedBackground(bg.fileId);
        return;
      }
      applyBackground(img, bg);
      preloadNeighborBackgrounds();
    }

    /* ───────────────── 预览层 ───────────────── */

    function drawPreview(): void {
      previewLayer.destroyChildren();

      // 远端正在画的笔迹
      for (const p of client.previews.values()) {
        if (p.pageId !== client.activePageId) continue;
        previewLayer.add(
          p.pressures && p.pressures.length > 0
            ? createInkShape({
                points: p.points,
                pressures: p.pressures,
                strokeWidth: p.width,
                color: p.color,
                opacity: p.type === 'highlighter' ? 0.35 : 1,
                highlighter: p.type === 'highlighter',
              })
            : new Konva.Line({
                points: p.points,
                stroke: p.color,
                strokeWidth: p.width,
                opacity: p.type === 'highlighter' ? 0.35 : 1,
                lineCap: 'round',
                lineJoin: 'round',
                tension: 0.35,
                listening: false,
                globalCompositeOperation: p.type === 'highlighter' ? 'multiply' : 'source-over',
              }),
        );
      }

      // 本地正在画的笔迹
      if (client.localStroke) {
        const ls = client.localStroke;
        previewLayer.add(
          ls.pen && ls.pressures.length > 0
            ? createInkShape({
                points: ls.points,
                pressures: ls.pressures,
                strokeWidth: client.style.strokeWidth,
                color: client.style.stroke,
                opacity: client.style.opacity,
              })
            : new Konva.Line({
                points: ls.points,
                stroke: client.style.stroke,
                strokeWidth: client.style.strokeWidth,
                opacity: client.style.opacity,
                lineCap: 'round',
                lineJoin: 'round',
                tension: 0.35,
                listening: false,
              }),
        );
      }

      // 正在拖出的形状
      if (draft) {
        const x = Math.min(draft.startX, draft.curX);
        const y = Math.min(draft.startY, draft.curY);
        const w = Math.abs(draft.curX - draft.startX);
        const h = Math.abs(draft.curY - draft.startY);
        const stroke = client.style.stroke;
        const strokeWidth = client.style.strokeWidth;
        if (draft.type === 'rect') {
          previewLayer.add(new Konva.Rect({ x, y, width: w, height: h, stroke, strokeWidth, dash: [6, 4] }));
        } else if (draft.type === 'ellipse') {
          previewLayer.add(
            new Konva.Ellipse({
              x: x + w / 2,
              y: y + h / 2,
              radiusX: w / 2,
              radiusY: h / 2,
              stroke,
              strokeWidth,
              dash: [6, 4],
            }),
          );
        } else {
          previewLayer.add(
            new Konva.Arrow({
              points: [draft.startX, draft.startY, draft.curX, draft.curY],
              stroke,
              fill: stroke,
              strokeWidth,
              pointerLength: 10 + strokeWidth * 1.6,
              pointerWidth: 9 + strokeWidth * 1.5,
            }),
          );
        }
      }

      previewLayer.batchDraw();
    }

    /* ───────────────── 光标层（屏幕坐标，不随缩放变形） ───────────────── */

    function drawCursors(): void {
      overlay.destroyChildren();
      const { x, y, scale } = client.camera;
      for (const [userId, c] of client.cursors) {
        if (c.pageId !== client.activePageId) continue;
        const sx = c.x * scale + x;
        const sy = c.y * scale + y;
        const group = new Konva.Group({ x: sx, y: sy, listening: false, opacity: 0.92 });
        group.add(
          new Konva.Line({
            points: [0, 0, 0, 15, 4.5, 11, 8, 17, 10.5, 15.5, 7, 10, 12.5, 9.5],
            closed: true,
            fill: colorFor(userId),
            stroke: '#ffffff',
            strokeWidth: 1,
          }),
        );
        const label = names[userId] ?? '';
        if (label) {
          const text = new Konva.Text({
            x: 12,
            y: 14,
            text: label,
            fontSize: 11,
            fontFamily: '"PingFang SC", sans-serif',
            fill: '#ffffff',
            padding: 3,
          });
          const bg = new Konva.Rect({
            x: 12,
            y: 14,
            width: text.width() + 6,
            height: text.height() + 4,
            fill: colorFor(userId),
            cornerRadius: 4,
          });
          group.add(bg, text);
        }
        overlay.add(group);
      }
      overlay.batchDraw();
    }

    const CURSOR_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#0ea5e9', '#8b5cf6'];
    function colorFor(userId: string): string {
      let h = 0;
      for (let i = 0; i < userId.length; i++) h = (h * 31 + userId.charCodeAt(i)) % 997;
      return CURSOR_COLORS[h % CURSOR_COLORS.length] as string;
    }

    /* ───────────────── 重绘调度 ───────────────── */

    let scheduled = 0;
    function schedule(): void {
      if (scheduled) return;
      scheduled = requestAnimationFrame(() => {
        scheduled = 0;
        if (!pan) stage.container().style.cursor = TOOL_CURSOR[client.tool] ?? 'default';
        applyCamera();
        syncContent();
        drawPreview();
        drawCursors();
      });
    }

    /* ───────────────── 指针交互 ───────────────── */

    function worldPos(): { x: number; y: number } | null {
      const p = stage.getPointerPosition();
      if (!p) return null;
      return screenToWorld(client.camera, p.x, p.y);
    }

    function eraseAt(wx: number, wy: number): void {
      const tolerance = Math.max(6, client.style.strokeWidth / 2);
      // 元素不多（<4000）时线性扫描足够快；Konva 的命中缓存对斜线不友好，这里用共享的几何判定
      let best: WhiteboardElement | null = null;
      for (const el of client.visibleOnActive()) {
        if (hitTest(el, wx, wy, tolerance)) best = el;
      }
      if (best) client.removeElement(best.id);
    }

    function hitTest(el: WhiteboardElement, x: number, y: number, tol: number): boolean {
      const sx = el.scaleX ?? 1;
      const sy = el.scaleY ?? 1;
      if (el.points && el.points.length >= 4) {
        for (let i = 0; i < el.points.length - 2; i += 2) {
          const ax = (el.points[i] as number) * sx + el.x;
          const ay = (el.points[i + 1] as number) * sy + el.y;
          const bx = (el.points[i + 2] as number) * sx + el.x;
          const by = (el.points[i + 3] as number) * sy + el.y;
          const dx = bx - ax;
          const dy = by - ay;
          const len = dx * dx + dy * dy;
          let t = len === 0 ? 0 : ((x - ax) * dx + (y - ay) * dy) / len;
          t = Math.max(0, Math.min(1, t));
          const cx = ax + t * dx;
          const cy = ay + t * dy;
          const d2 = (x - cx) ** 2 + (y - cy) ** 2;
          if (d2 <= Math.max(tol, (el.strokeWidth ?? 2) / 2 + 4) ** 2) return true;
        }
        return false;
      }
      const w = el.width * Math.abs(sx);
      const h = el.height * Math.abs(sy);
      return x >= el.x - tol && x <= el.x + w + tol && y >= el.y - tol && y <= el.y + h + tol;
    }

    let erasing = false;
    let spaceDown = false;
    /**
     * 正在画/擦的那个指针 id。
     * 一块板子上可能同时有笔、鼠标、手掌三种输入源，它们都会往同一个 stage 发事件；
     * 不按 id 过滤的话，笔在画、鼠标随便一动就会把笔迹拽到鼠标位置 —— 这就是「乱飞」。
     */
    let activePointerId: number | null = null;
    /** 最近一次数位笔活动时间，用于掌托抑制 */
    let lastPenAt = 0;
    /** 诊断面板用的时间基准 */
    const traceOrigin = performance.now();
    let lastMoveTraceAt = 0;

    /** 记录一次指针事件（只在诊断面板打开时真正采集） */
    function trace(ev: PointerEvent, phase: 'down' | 'move' | 'up', note?: string): void {
      if (!penDebug.enabled) return;
      // move 太密，60ms 采样一次就够看趋势了
      if (phase === 'move') {
        const now = performance.now();
        if (now - lastMoveTraceAt < 60) return;
        lastMoveTraceAt = now;
      }
      penDebug.push({
        t: Math.round(performance.now() - traceOrigin),
        phase,
        kind: kindOf(ev),
        id: ev.pointerId,
        button: ev.button,
        buttons: ev.buttons,
        pressure: typeof ev.pressure === 'number' ? ev.pressure : 0,
        x: ev.clientX,
        y: ev.clientY,
        note,
      });
    }

    function dropTrace(ev: PointerEvent, phase: 'down' | 'move' | 'up', rule: keyof typeof DROP_LABELS): void {
      penDebug.drop(rule);
      trace(ev, phase, DROP_LABELS[rule]);
    }

    const onKeyDown = (ev: KeyboardEvent): void => {
      if (ev.code === 'Space' && !isTyping(ev.target)) spaceDown = true;
    };
    const onKeyUp = (ev: KeyboardEvent): void => {
      if (ev.code === 'Space') spaceDown = false;
    };
    // 窗口失焦时收不到 keyup，spaceDown 会永久卡在 true ——
    // 之后每一次落笔都被当成「平移画布」，表现就是画布乱飞、根本画不了
    const onWindowBlur = (): void => {
      spaceDown = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onWindowBlur);

    function isTyping(target: EventTarget | null): boolean {
      const el = target as HTMLElement | null;
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
    }

    function kindOf(ev: PointerEvent): string {
      return ev.pointerType || 'mouse';
    }

    /**
     * 事件坐标 → 舞台坐标。
     *
     * 刻意不用 stage.getPointerPosition()：它记录的是「最后一次任何设备」的坐标，
     * 笔和鼠标交替上报时会取到另一个设备的残留位置，笔迹就会跳。
     */
    function toWorld(cx: number, cy: number, rect: DOMRect): { x: number; y: number } {
      return screenToWorld(client.camera, cx - rect.left, cy - rect.top);
    }

    stage.on('pointerdown', (e) => {
      const ev = e.evt as PointerEvent;
      const kind = kindOf(ev);
      if (kind === 'pen') lastPenAt = performance.now();

      // 掌托抑制：笔刚在板面上用过，紧跟着的触摸是手掌边缘，不是想画
      if (kind === 'touch' && performance.now() - lastPenAt < 1500) {
        dropTrace(ev, 'down', 'touchPalm');
        return;
      }

      // 数位板驱动常把同一支笔同时上报成 pen 和 mouse 两套事件（Windows Ink + 鼠标模拟），
      // 位置一样但 pointerId 不同。笔刚动过时的鼠标事件必然是笔的模拟：
      //   · 它带 button=1/2 时会被当成「中键/右键」→ 画布被拖飞
      //   · 它带 pointerup 时会把正在画的一笔提前结束
      // 所以笔活动期间一律忽略鼠标事件。
      if (kind === 'mouse' && lastPenAt !== 0 && performance.now() - lastPenAt < 2000) {
        dropTrace(ev, 'down', 'mouseDuringPen');
        return;
      }
      if (ev.isPrimary === false) {
        dropTrace(ev, 'down', 'notPrimary');
        return;
      }
      if (activePointerId !== null) {
        dropTrace(ev, 'down', 'busy'); // 已经有一支笔在画，别插队
        return;
      }
      trace(ev, 'down');

      const rect = stage.container().getBoundingClientRect();
      const world = toWorld(ev.clientX, ev.clientY, rect);
      const tool = client.tool;

      // 平移只认鼠标：数位笔的侧键在 Windows 上普遍被映射成「中键」，
      // 沿用旧逻辑会让握笔时拇指蹭到侧键就把整个画布甩走
      const isMouse = kind === 'mouse';
      if (isMouse && (ev.button === 1 || (spaceDown && ev.button === 0))) {
        pan = {
          sx: ev.clientX - rect.left,
          sy: ev.clientY - rect.top,
          camX: client.camera.x,
          camY: client.camera.y,
          pointerId: ev.pointerId,
        };
        activePointerId = ev.pointerId;
        stage.container().style.cursor = 'grabbing';
        return;
      }

      // 右键/笔侧键（button 2、5）不参与绘制
      if (ev.button !== 0) {
        dropTrace(ev, 'down', 'nonLeftButton');
        return;
      }

      if (tool === 'select') {
        if (e.target === stage || e.target === pageRect) {
          if (!ev.shiftKey) client.selection.clear();
          transformer.nodes([]);
          transformer.visible(false);
          client.notify();
        }
        return;
      }

      if (!client.canDraw()) return;

      if (tool === 'pen' || tool === 'highlighter') {
        activePointerId = ev.pointerId;
        const pen = pointerInfo(ev);
        client.startStroke(world.x, world.y, pen.pressure, pen.isPen);
        schedule();
        return;
      }

      if (tool === 'eraser') {
        activePointerId = ev.pointerId;
        erasing = true;
        eraseAt(world.x, world.y);
        return;
      }

      if (tool === 'text') {
        createTextAt(world.x, world.y);
        return;
      }

      const shapeType = TOOL_SHAPE[tool];
      if (shapeType) {
        activePointerId = ev.pointerId;
        draft = { type: shapeType, startX: world.x, startY: world.y, curX: world.x, curY: world.y };
        schedule();
      }
    });

    stage.on('pointermove', (e) => {
      const ev = e.evt as PointerEvent;
      const kind = kindOf(ev);
      if (kind === 'pen') lastPenAt = performance.now();

      const rect = stage.container().getBoundingClientRect();

      if (pan) {
        if (ev.pointerId !== pan.pointerId) return;
        client.setCamera({
          scale: client.camera.scale,
          x: pan.camX + (ev.clientX - rect.left - pan.sx),
          y: pan.camY + (ev.clientY - rect.top - pan.sy),
        });
        return;
      }

      // 动的不是当前这支笔/鼠标 → 与这一笔无关，丢弃
      if (activePointerId !== null && ev.pointerId !== activePointerId) {
        dropTrace(ev, 'move', 'otherPointer');
        return;
      }
      trace(ev, 'move');

      const world = toWorld(ev.clientX, ev.clientY, rect);
      client.pushCursor(world.x, world.y);

      if (client.localStroke) {
        // 笔离开板面悬停时 buttons 为 0，不能续画
        if (ev.buttons === 0) {
          dropTrace(ev, 'move', 'hover');
          return;
        }

        // 数位笔上报频率很高（120~200Hz），一次 pointermove 里可能合并了多个采样点。
        // 只取最后一个点会让快速运笔变成明显折线，这里全部取出来逐点追加。
        const samples =
          typeof ev.getCoalescedEvents === 'function' ? ev.getCoalescedEvents() : [];
        if (samples.length > 1) {
          for (const sp of samples) {
            const w = toWorld(sp.clientX, sp.clientY, rect);
            client.extendStroke(w.x, w.y, pointerInfo(sp).pressure);
          }
        } else {
          client.extendStroke(world.x, world.y, pointerInfo(ev).pressure);
        }
        schedule();
        return;
      }
      if (draft) {
        draft = { ...draft, curX: world.x, curY: world.y };
        schedule();
        return;
      }
      if (erasing) {
        eraseAt(world.x, world.y);
      }
    });

    /** 统一收尾：抬起、取消、在画布外松手，都走这里 */
    function finishPointer(ev: PointerEvent): void {
      trace(ev, 'up');
      if (pan) {
        if (ev.pointerId !== pan.pointerId) return;
        pan = null;
        activePointerId = null;
        stage.container().style.cursor = TOOL_CURSOR[client.tool] ?? 'default';
        return;
      }

      if (activePointerId !== null && ev.pointerId !== activePointerId) return;
      activePointerId = null;

      if (client.localStroke) {
        const { stroke, strokeWidth, opacity } = client.style;
        const type = client.tool === 'highlighter' ? 'highlighter' : 'pen';
        client.endStroke((points, pressures) => ({
          id: uuid(),
          pageId: client.activePageId,
          type,
          rev: 1,
          order: 'a0',
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          points,
          ...(pressures ? { pressures } : {}),
          stroke,
          strokeWidth,
          opacity,
          createdBy: client.selfId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }));
        schedule();
        return;
      }

      if (draft) {
        commitShape(draft);
        draft = null;
        schedule();
      }
      erasing = false;
    }

    stage.on('pointerup', (e) => finishPointer(e.evt as PointerEvent));
    stage.on('pointercancel', (e) => finishPointer(e.evt as PointerEvent));

    // 兜底：在某些平板上终点落在画布外时 stage 收不到 pointerup，
    // 笔迹会永远停在「未提交」状态，后续落笔也被 activePointerId 挡住
    const onWindowPointerUp = (ev: PointerEvent): void => {
      if (activePointerId !== null && ev.pointerId === activePointerId) finishPointer(ev);
    };
    window.addEventListener('pointerup', onWindowPointerUp);
    window.addEventListener('pointercancel', onWindowPointerUp);

    stage.on('pointerleave', (e) => {
      client.pushCursor(null, null);
      // 笔已离开画布且没按着 → 收尾，别把半截笔迹挂在那里
      const ev = e.evt as PointerEvent;
      if (client.localStroke && ev.buttons === 0) finishPointer(ev);
    });

    stage.on('wheel', (e) => {
      e.evt.preventDefault();
      const pos = stage.getPointerPosition();
      if (!pos) return;
      client.zoomAtPoint(pos.x, pos.y, e.evt.deltaY > 0 ? 0.92 : 1.08);
    });

    function commitShape(d: Draft): void {
      const x = Math.min(d.startX, d.curX);
      const y = Math.min(d.startY, d.curY);
      const w = Math.abs(d.curX - d.startX);
      const h = Math.abs(d.curY - d.startY);

      if (d.type === 'rect' || d.type === 'ellipse') {
        if (w < MIN_SHAPE_SIZE || h < MIN_SHAPE_SIZE) return;
        client.addElement({
          id: uuid(),
          pageId: client.activePageId,
          type: d.type,
          rev: 1,
          order: 'a0',
          x,
          y,
          width: w,
          height: h,
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
          stroke: client.style.stroke,
          strokeWidth: client.style.strokeWidth,
          fill: 'transparent',
          opacity: 1,
          createdBy: client.selfId,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        return;
      }

      const len = Math.hypot(d.curX - d.startX, d.curY - d.startY);
      if (len < MIN_SHAPE_SIZE) return;
      client.addElement({
        id: uuid(),
        pageId: client.activePageId,
        type: d.type,
        rev: 1,
        order: 'a0',
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        points: [d.startX, d.startY, d.curX, d.curY],
        stroke: client.style.stroke,
        strokeWidth: client.style.strokeWidth,
        opacity: 1,
        createdBy: client.selfId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    function createTextAt(wx: number, wy: number): void {
      const id = uuid();
      const fontSize = 26;
      client.addElement({
        id,
        pageId: client.activePageId,
        type: 'text',
        rev: 1,
        order: 'a0',
        x: wx,
        y: wy,
        width: 0,
        height: 0,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        text: '',
        fontSize,
        fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif',
        stroke: client.style.stroke,
        opacity: 1,
        createdBy: client.selfId,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      const screen = worldToScreen(client.camera, wx, wy);
      setEditing({
        id,
        value: '',
        left: screen.x,
        top: screen.y,
        width: 260,
        fontSize: fontSize * client.camera.scale,
        color: client.style.stroke,
      });
      requestAnimationFrame(() => textareaRef.current?.focus());
    }

    transformer.on('transformend', () => {
      for (const node of transformer.nodes()) {
        const el = client.doc.elements.get(node.id());
        if (el) client.patchElement(el.id, patchFromNode(el, node as Konva.Shape));
      }
    });

    const unsubscribe = client.subscribe(schedule);
    const ro = new ResizeObserver(() => {
      stage.size({ width: Math.max(1, wrap.clientWidth), height: Math.max(1, wrap.clientHeight) });
      schedule();
    });
    ro.observe(wrap);

    client.fitPage(stage.width(), stage.height());
    schedule();

    return () => {
      unsubscribe();
      ro.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('pointerup', onWindowPointerUp);
      window.removeEventListener('pointercancel', onWindowPointerUp);
      if (scheduled) cancelAnimationFrame(scheduled);
      if (bgRetryTimer) clearTimeout(bgRetryTimer);
      stage.destroy();
    };
  }, [client, names]);

  const commitEditing = (): void => {
    const ed = editingRef.current;
    if (!ed) return;
    const value = ed.value.trim();
    if (value.length === 0) {
      // 空文本不留下一个看不见的元素
      client.removeElement(ed.id);
    } else {
      client.patchElement(ed.id, { text: value });
    }
    setEditing(null);
  };

  return (
    <div className="wb-canvas" ref={wrapRef}>
      {editing && (
        <textarea
          ref={textareaRef}
          className="wb-text-input"
          style={{
            left: editing.left,
            top: editing.top,
            width: editing.width,
            fontSize: Math.max(12, editing.fontSize),
            color: editing.color,
          }}
          value={editing.value}
          onChange={(e) => setEditing({ ...editing, value: e.target.value })}
          onBlur={commitEditing}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              commitEditing();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              client.removeElement(editing.id);
              setEditing(null);
            }
          }}
        />
      )}
    </div>
  );
}
