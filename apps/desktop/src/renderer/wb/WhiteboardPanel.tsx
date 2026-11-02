import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_PAGES, type ElementStyle, type Tool } from '@classroom/shared';
import type { WhiteboardClient } from '@classroom/client-core';
import { Toolbar } from './Toolbar';
import { PenDebugHud } from './PenDebugHud';
import { Whiteboard } from './Whiteboard';
import { importPdfCourseware } from '../lib/import';
import { useRoom } from '../store/room';

const SHORTCUTS: Record<string, Tool> = {
  v: 'select',
  p: 'pen',
  h: 'highlighter',
  e: 'eraser',
  r: 'rect',
  o: 'ellipse',
  a: 'arrow',
  l: 'line',
  t: 'text',
};

interface Props {
  client: WhiteboardClient;
  names: Record<string, string>;
}

/**
 * 白板面板。
 *
 * 这里面唯一高频的东西（笔迹、光标）由 Konva 自己按帧重绘，
 * React 只按 300ms 轮询刷新工具栏上那几个低频状态（撤销栈、页码），
 * 否则一笔画下去会触发几十次整棵树重渲染。
 */
export function WhiteboardPanel({ client, names }: Props) {
  const [tool, setTool] = useState<Tool>(client.tool);
  const [style, setStyle] = useState<ElementStyle>({ ...client.style });
  const [tick, setTick] = useState(0);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{ phase: string; done: number; total: number } | null>(null);
  const stageWrapRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 300);
    return () => clearInterval(t);
  }, []);

  // 翻页是低频但要求跟手的动作：只靠 300ms 轮询会让页码/按钮状态明显滞后，
  // 这里额外只对「页集合或当前页变化」立即重渲染，光标/笔迹仍走 Konva 不触发 React
  useEffect(() => {
    let lastActive = client.activePageId;
    let lastPages = client.doc.pages;
    return client.subscribe(() => {
      if (client.activePageId === lastActive && client.doc.pages === lastPages) return;
      lastActive = client.activePageId;
      lastPages = client.doc.pages;
      setTick((v) => v + 1);
    });
  }, [client]);

  const pickTool = useCallback(
    (next: Tool) => {
      client.setTool(next);
      setTool(next);
      setStyle({ ...client.style });
    },
    [client],
  );

  const patchStyle = useCallback(
    (patch: Partial<ElementStyle>) => {
      client.setStyle(patch);
      setStyle({ ...client.style });
    },
    [client],
  );

  const fit = useCallback(() => {
    const el = stageWrapRef.current;
    if (el) client.fitPage(el.clientWidth, el.clientHeight);
  }, [client]);

  /**
   * 按「点击瞬间」的实时页序翻页。
   *
   * 不能用渲染时的 activeIndex：那是由 300ms 轮询刷新的快照，
   * 连点时第二次点击拿到的还是旧索引，目标页与当前页相同，翻页就会「卡住不动」。
   */
  const stepPage = useCallback(
    (delta: number) => {
      const list = client.doc.pages;
      const idx = list.findIndex((p) => p.id === client.activePageId);
      const target = list[idx + delta];
      if (target) client.goToPage(target.id);
    },
    [client],
  );

  const handleImport = useCallback(
    async (file: File) => {
      setImporting(true);
      setProgress({ phase: '解析 PDF', done: 0, total: 1 });
      try {
        const added = await importPdfCourseware(file, {
          client,
          roomId: useRoom.getState().room?.id,
          onProgress: setProgress,
        });
        useRoom.setState({ notice: `已导入 ${added} 页课件` });
      } catch (err) {
        useRoom.setState({ notice: `导入失败：${(err as Error).message}` });
      } finally {
        setImporting(false);
        setProgress(null);
      }
    },
    [client],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;

      if (e.metaKey || e.ctrlKey) {
        if (e.key.toLowerCase() === 'z') {
          e.preventDefault();
          if (e.shiftKey) client.redo();
          else client.undo();
          return;
        }
        if (e.key === '0') {
          e.preventDefault();
          fit();
        }
        return;
      }

      const next = SHORTCUTS[e.key.toLowerCase()];
      if (next) {
        e.preventDefault();
        pickTool(next);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [client, fit, pickTool]);

  const studentsCanDraw = client.studentsCanDraw;
  const isTeacher = client.isTeacher();
  const pages = client.doc.pages;
  const activeIndex = pages.findIndex((p) => p.id === client.activePageId);

  // tick 只是为了强制刷新下面这些低频派生值
  void tick;

  return (
    <div className="wb-panel">
      <Toolbar
        tool={tool}
        style={style}
        canDraw={client.canDraw()}
        isTeacher={isTeacher}
        studentsCanDraw={studentsCanDraw}
        canUndo={client.canUndo()}
        canRedo={client.canRedo()}
        onTool={pickTool}
        onStyle={patchStyle}
        onUndo={() => client.undo()}
        onRedo={() => client.redo()}
        onToggleLock={() => client.toggleLock()}
        onFit={fit}
        onImport={() => fileRef.current?.click()}
        importing={importing}
        showStyle={tool !== 'select' && tool !== 'eraser'}
      />

      <input
        ref={fileRef}
        type="file"
        accept="application/pdf,.pdf"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void handleImport(f);
        }}
      />

      <div className="wb-stage-wrap" ref={stageWrapRef}>
        <Whiteboard client={client} names={names} />
        <PenDebugHud />

        <div className="wb-pages">
          <button
            className="wb-page-btn"
            disabled={!isTeacher || activeIndex <= 0}
            onClick={() => stepPage(-1)}
            title="上一页"
          >
            ‹
          </button>
          <span className="wb-page-label">
            {activeIndex + 1} / {pages.length}
            <span className="wb-page-name">{pages[activeIndex]?.name ?? ''}</span>
          </span>
          <button
            className="wb-page-btn"
            disabled={!isTeacher || activeIndex >= pages.length - 1}
            onClick={() => stepPage(1)}
            title="下一页"
          >
            ›
          </button>
          {isTeacher && (
            <>
              <div className="wb-page-sep" />
              <button
                className="wb-page-btn"
                onClick={() => client.addPage()}
                disabled={!isTeacher || pages.length >= MAX_PAGES}
                title={pages.length >= MAX_PAGES ? `最多 ${MAX_PAGES} 页` : '新建空白页'}
              >
                ＋
              </button>
              <button
                className="wb-page-btn"
                disabled={pages.length <= 1}
                onClick={() => client.deletePage(client.activePageId)}
                title="删除当前页（不可撤销）"
              >
                －
              </button>
            </>
          )}
        </div>

        {!studentsCanDraw && !isTeacher && (
          <div className="wb-locked-hint">老师已锁定白板，你暂时只能观看</div>
        )}
        {!studentsCanDraw && isTeacher && (
          <div className="wb-locked-hint">白板已锁定（只有你可以画）</div>
        )}

        {progress && (
          <div className="wb-import-mask">
            <div className="wb-import-box">
              <span className="spinner" />
              <div>
                <div className="wb-import-title">{progress.phase}</div>
                <div className="wb-import-sub">
                  {progress.total > 1 ? `${progress.done} / ${progress.total}` : '正在读取…'}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
