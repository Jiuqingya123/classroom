import type { ReactNode } from 'react';
import type { ElementStyle, Tool } from '@classroom/shared';
import { PALETTE } from '@classroom/shared';

const TOOL_ICONS: Partial<Record<Tool, ReactNode>> = {
  select: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <path d="M5 3l14 8-6 1.5L10 19z" />
    </svg>
  ),
  pen: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4.5 1.5L5 15z" />
    </svg>
  ),
  highlighter: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 20h6M6 16l7-7 4 4-7 7H6z" />
      <path d="M13 5l3-2 4 4-2 3" />
    </svg>
  ),
  eraser: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 20H4l-1.5-1.5a2 2 0 0 1 0-2.8L13 5.2a2 2 0 0 1 2.8 0l4 4a2 2 0 0 1 0 2.8L12 20z" />
      <path d="M9 9l6 6" />
    </svg>
  ),
  rect: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="4" y="6" width="16" height="12" rx="1.5" />
    </svg>
  ),
  ellipse: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <ellipse cx="12" cy="12" rx="8" ry="6" />
    </svg>
  ),
  arrow: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 19 19 5M11 5h8v8" />
    </svg>
  ),
  line: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M5 19 19 5" />
    </svg>
  ),
  text: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M5 6h14M12 6v13M9 19h6" />
    </svg>
  ),
};

const TOOLS_UI: { tool: Tool; label: string; key: string }[] = [
  { tool: 'select', label: '选择', key: 'V' },
  { tool: 'pen', label: '画笔', key: 'P' },
  { tool: 'highlighter', label: '荧光笔', key: 'H' },
  { tool: 'eraser', label: '橡皮', key: 'E' },
  { tool: 'rect', label: '矩形', key: 'R' },
  { tool: 'ellipse', label: '椭圆', key: 'O' },
  { tool: 'arrow', label: '箭头', key: 'A' },
  { tool: 'line', label: '直线', key: 'L' },
  { tool: 'text', label: '文本', key: 'T' },
];

const WIDTHS = [2, 3, 5, 8, 14];

interface Props {
  tool: Tool;
  style: ElementStyle;
  canDraw: boolean;
  isTeacher: boolean;
  studentsCanDraw: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onTool(tool: Tool): void;
  onStyle(patch: Partial<ElementStyle>): void;
  onUndo(): void;
  onRedo(): void;
  onToggleLock(): void;
  onFit(): void;
  onImport(): void;
  importing: boolean;
  showStyle: boolean;
}

export function Toolbar({
  tool,
  style,
  canDraw,
  isTeacher,
  studentsCanDraw,
  canUndo,
  canRedo,
  onTool,
  onStyle,
  onUndo,
  onRedo,
  onToggleLock,
  onFit,
  onImport,
  importing,
  showStyle,
}: Props) {
  return (
    <div className="wb-toolbar">
      <div className="wb-tools">
        {TOOLS_UI.map((t) => (
          <button
            key={t.tool}
            className="wb-tool"
            data-active={tool === t.tool}
            disabled={!canDraw}
            onClick={() => onTool(t.tool)}
            title={`${t.label}（${t.key}）`}
          >
            {TOOL_ICONS[t.tool]}
          </button>
        ))}
      </div>

      {showStyle && (
        <>
          <div className="wb-divider" />
          <div className="wb-colors">
            {PALETTE.map((c) => (
              <button
                key={c}
                className="wb-color"
                style={{ background: c }}
                data-active={style.stroke === c}
                onClick={() => onStyle({ stroke: c })}
                title={c}
              />
            ))}
          </div>
          <div className="wb-divider" />
          <div className="wb-widths">
            {WIDTHS.map((w) => (
              <button
                key={w}
                className="wb-width"
                data-active={Math.round(style.strokeWidth) === w}
                onClick={() => onStyle({ strokeWidth: w })}
                title={`粗细 ${w}`}
              >
                <span style={{ width: w + 4, height: w + 4 }} />
              </button>
            ))}
          </div>
        </>
      )}

      <div className="wb-divider" />

      <button className="wb-tool" disabled={!canUndo} onClick={onUndo} title="撤销（⌘Z）">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 7 4 12l5 5" />
          <path d="M4 12h9a5 5 0 0 1 0 10h-2" />
        </svg>
      </button>
      <button className="wb-tool" disabled={!canRedo} onClick={onRedo} title="重做（⇧⌘Z）">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="m15 7 5 5-5 5" />
          <path d="M20 12h-9a5 5 0 0 0 0 10h2" />
        </svg>
      </button>

      <button className="wb-tool" onClick={onFit} title="适应窗口（⌘0）">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" />
        </svg>
      </button>

      {isTeacher && (
        <button className="wb-tool" onClick={onImport} disabled={importing} title="导入 PDF 课件">
          {importing ? (
            <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 16V4M8 8l4-4 4 4" />
              <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
            </svg>
          )}
        </button>
      )}

      {isTeacher && (
        <button
          className="wb-lock"
          data-locked={!studentsCanDraw}
          onClick={onToggleLock}
          title={studentsCanDraw ? '禁止学生绘制' : '允许学生绘制'}
        >
          {studentsCanDraw ? '学生可画' : '学生已锁定'}
        </button>
      )}
    </div>
  );
}
