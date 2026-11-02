import { useEffect, useState } from 'react';
import type { RoomReportDTO } from '@classroom/shared';
import { getApi } from '../lib/api';
import { formatClock, formatDate, formatSpan } from '../lib/format';

interface Props {
  roomId: string;
  onClose(): void;
}

const STATUS_LABEL: Record<string, string> = {
  open: '未开始',
  live: '进行中',
  ended: '已结束',
};

/**
 * 课堂记录。
 *
 * 数据全部来自服务端的聚合接口，不在客户端二次统计 —— 「每人时长」要按进出记录累加，
 * 客户端拿不到完整历史，自己算必然和老师看到的数字对不上。
 */
export function RoomReportModal({ roomId, onClose }: Props) {
  const [report, setReport] = useState<RoomReportDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getApi()
      .get<RoomReportDTO>(`/api/v1/rooms/${roomId}/report`)
      .then((r) => {
        if (alive) setReport(r);
      })
      .catch((e: Error) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [roomId]);

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="report" onClick={(e) => e.stopPropagation()}>
        <div className="report-head">
          <h2 className="report-title">{report?.title ?? '课堂记录'}</h2>
          <div className="report-meta">
            <span>{STATUS_LABEL[report?.status ?? ''] ?? report?.status ?? ''}</span>
            {report?.startedAt && <span>开始于 {formatDate(report.startedAt)}</span>}
            {report?.endedAt && <span>结束于 {formatClock(report.endedAt)}</span>}
          </div>
        </div>

        {error && (
          <div className="report-body">
            <div className="alert alert-error" style={{ marginTop: 16 }}>
              {error}
            </div>
          </div>
        )}

        {report && !error && (
          <>
            <div className="report-stats">
              <div className="report-stat">
                <div className="report-stat-value">{formatSpan(report.durationMs)}</div>
                <div className="report-stat-label">课堂时长</div>
              </div>
              <div className="report-stat">
                <div className="report-stat-value">{report.participants.length}</div>
                <div className="report-stat-label">参与人数</div>
              </div>
              <div className="report-stat">
                <div className="report-stat-value">{report.messageCount}</div>
                <div className="report-stat-label">聊天消息</div>
              </div>
              <div className="report-stat">
                <div className="report-stat-value">{report.pageCount}</div>
                <div className="report-stat-label">白板页数</div>
              </div>
            </div>

            <div className="report-body">
              {report.participants.length === 0 ? (
                <div className="report-empty">这个课堂还没有人进去过</div>
              ) : (
                <table className="report-table">
                  <thead>
                    <tr>
                      <th>成员</th>
                      <th>进入</th>
                      <th>离开</th>
                      <th style={{ textAlign: 'right' }}>在线时长</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.participants.map((p) => (
                      <tr key={p.userId}>
                        <td>
                          {p.displayName}
                          {p.role === 'teacher' && <span className="report-role">老师</span>}
                        </td>
                        <td className="num">{formatClock(p.joinedAt)}</td>
                        <td className="num">{p.leftAt ? formatClock(p.leftAt) : <span style={{ color: 'var(--success)' }}>在课堂中</span>}</td>
                        <td className="num" style={{ textAlign: 'right' }}>
                          {formatSpan(p.totalMs)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <p className="report-meta" style={{ margin: '14px 0 4px' }}>
                白板共产生 {report.elementCount} 个元素（含已擦除的）。中途断线重进会累加时长，不是简单相减。
              </p>
            </div>
          </>
        )}

        <div className="modal-foot">
          <button className="btn btn-outline" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
