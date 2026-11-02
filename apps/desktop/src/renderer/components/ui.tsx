import { useEffect, type ReactNode } from 'react';

export function Modal({
  title,
  children,
  footer,
  onClose,
  width = 520,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose(): void;
  width?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width }} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} title="关闭">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: Array<{ key: T; label: string; count?: number }>;
  value: T;
  onChange(v: T): void;
}) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <button key={t.key} className="tab" data-active={value === t.key} onClick={() => onChange(t.key)}>
          {t.label}
          {t.count !== undefined && <span className="tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function PageHead({
  title,
  desc,
  actions,
}: {
  title: string;
  desc?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">{title}</h1>
        {desc && <p className="page-desc">{desc}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Loading() {
  return (
    <div className="loading-row">
      <span className="spinner" /> 加载中…
    </div>
  );
}

export function ErrorBar({ message, onClose }: { message: string | null; onClose?: () => void }) {
  if (!message) return null;
  return (
    <div className="alert alert-error" style={{ marginBottom: 12 }}>
      <span style={{ flex: 1 }}>{message}</span>
      {onClose && (
        <button className="icon-btn" onClick={onClose} title="关闭">
          ✕
        </button>
      )}
    </div>
  );
}

export function StatusTag({ status }: { status: string }) {
  const label: Record<string, string> = {
    open: '未开始',
    live: '进行中',
    ended: '已结束',
    scheduled: '待开课',
    cancelled: '已取消',
  };
  const cls =
    status === 'live' || status === 'scheduled' || status === 'open'
      ? status === 'scheduled' || status === 'open'
        ? 'tag-muted'
        : 'tag-live'
      : 'tag-ended';
  return <span className={`tag ${cls}`}>{label[status] ?? status}</span>;
}

export function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local 输入框需要的本地时间字符串 */
export function toLocalInput(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): number {
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
