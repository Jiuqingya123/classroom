import { useEffect, useState } from 'react';
import { DROP_LABELS, penDebug, type PenSample } from './penDebug';

const MAX_ROWS = 12;

/**
 * 手写笔诊断面板（Ctrl + Shift + D 开关）。
 *
 * 只在需要排查数位板问题时打开，平时完全不渲染、不采集。
 */
export function PenDebugHud() {
  const [on, setOn] = useState(penDebug.enabled);
  const [rows, setRows] = useState<PenSample[]>([]);
  const [dropped, setDropped] = useState<Record<string, number>>({});

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyD') {
        e.preventDefault();
        const next = penDebug.toggle();
        penDebug.resetCounters();
        setRows([]);
        setDropped({});
        setOn(next);
      }
    };
    window.addEventListener('keydown', onKey);

    const offToggle = penDebug.onToggle((v) => {
      if (!v) setRows([]);
    });
    const offSample = penDebug.onSample((s) => {
      setRows((prev) => [...prev.slice(-(MAX_ROWS - 1)), s]);
      setDropped(penDebug.counters());
    });

    return () => {
      window.removeEventListener('keydown', onKey);
      offToggle();
      offSample();
    };
  }, []);

  // 丢弃计数是「累计值」，没有新采样时也要能刷新，所以低频轮询一下
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setDropped(penDebug.counters()), 500);
    return () => clearInterval(t);
  }, [on]);

  if (!on) return null;

  const dropItems = Object.entries(dropped).filter(([, n]) => n > 0);

  return (
    <div className="pen-hud">
      <div className="pen-hud-head">
        <strong>笔输入诊断</strong>
        <span>Ctrl+Shift+D 关闭</span>
      </div>

      <table className="pen-hud-table">
        <thead>
          <tr>
            <th>ms</th>
            <th>阶段</th>
            <th>类型</th>
            <th>id</th>
            <th>btn</th>
            <th>压感</th>
            <th>x,y</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="pen-hud-empty">
                用笔在画布上画一下，这里会实时显示事件
              </td>
            </tr>
          )}
          {rows.map((r, i) => (
            <tr key={`${r.t}-${i}`} data-kind={r.kind} data-dropped={r.note ? 'true' : 'false'}>
              <td>{r.t}</td>
              <td title={r.note ?? ''}>{r.phase}{r.note ? ' · 丢弃' : ''}</td>
              <td>{r.kind}</td>
              <td>{r.id}</td>
              <td>{r.button}</td>
              <td>{r.pressure.toFixed(2)}</td>
              <td>
                {Math.round(r.x)},{Math.round(r.y)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="pen-hud-drops">
        {dropItems.length === 0 ? (
          <span className="pen-hud-ok">没有被规则丢弃的事件</span>
        ) : (
          dropItems.map(([k, n]) => (
            <span key={k} className="pen-hud-drop">
              {DROP_LABELS[k] ?? k} × {n}
            </span>
          ))
        )}
      </div>
    </div>
  );
}
