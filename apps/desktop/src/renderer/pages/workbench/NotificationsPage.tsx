import { useCallback, useEffect, useState } from 'react';
import type { NotificationDTO } from '@classroom/shared';
import { ErrorBar, Loading, PageHead } from '../../components/ui';
import { getApi } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { useNav } from '../../store/nav';
import { useNotify } from '../../store/notify';

const API = '/api/v1';

const KIND_LABEL: Record<string, string> = {
  lesson: '课程安排',
  course: '课程',
  assignment: '作业',
  grade: '批改',
  classroom: '课堂',
  system: '系统',
};

export function NotificationsPage() {
  const go = useNav((s) => s.go);
  const goCourse = useNav((s) => s.goCourse);
  const goAssignment = useNav((s) => s.goAssignment);
  const setUnread = useNotify((s) => s.setUnread);

  const [items, setItems] = useState<NotificationDTO[]>([]);
  const [unread, setLocalUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [onlyUnread, setOnlyUnread] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await getApi().get<{ notifications: NotificationDTO[]; unread: number }>(
        `${API}/notifications?limit=200`,
      );
      setItems(r.notifications);
      setLocalUnread(r.unread);
      setUnread(r.unread);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [setUnread]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async (n: NotificationDTO) => {
    if (!n.readAt) {
      try {
        await getApi().post(`${API}/notifications/${n.id}/read`);
        setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, readAt: Date.now() } : x)));
        setLocalUnread((v) => {
          const next = Math.max(0, v - 1);
          setUnread(next);
          return next;
        });
      } catch {
        /* 已读失败不阻塞跳转 */
      }
    }
    if (n.link.startsWith('course:')) goCourse(n.link.slice(7));
    else if (n.link.startsWith('assignment:')) goAssignment(n.link.slice(11));
    else if (n.link.startsWith('room:')) go('lobby');
    else go('dashboard');
  };

  const readAll = async () => {
    try {
      await getApi().post(`${API}/notifications/read_all`);
      const now = Date.now();
      setItems((prev) => prev.map((x) => ({ ...x, readAt: x.readAt ?? now })));
      setLocalUnread(0);
      setUnread(0);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const visible = onlyUnread ? items.filter((n) => !n.readAt) : items;

  return (
    <div className="wb-page">
      <PageHead
        title="通知"
        desc={`${unread} 条未读 · 课程安排、作业与批改结果都会在这里汇总`}
        actions={
          <button className="btn btn-outline" onClick={() => void readAll()} disabled={unread === 0}>
            全部标为已读
          </button>
        }
      />
      <ErrorBar message={error} onClose={() => setError(null)} />
      <div className="filter-row">
        <button className="filter-chip" data-active={!onlyUnread} onClick={() => setOnlyUnread(false)}>
          全部
        </button>
        <button className="filter-chip" data-active={onlyUnread} onClick={() => setOnlyUnread(true)}>
          未读
        </button>
      </div>

      {loading ? (
        <Loading />
      ) : visible.length === 0 ? (
        <div className="empty">没有通知</div>
      ) : (
        <div className="notify-list">
          {visible.map((n) => (
            <button
              key={n.id}
              className="notify-row"
              data-unread={!n.readAt}
              onClick={() => void open(n)}
            >
              <span className="notify-dot" />
              <div className="notify-main">
                <div className="notify-title">
                  <span className="tag tag-muted">{KIND_LABEL[n.kind] ?? n.kind}</span>
                  {n.title}
                </div>
                {n.body && <div className="notify-body">{n.body}</div>}
              </div>
              <span className="notify-time">{formatDate(n.createdAt)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
