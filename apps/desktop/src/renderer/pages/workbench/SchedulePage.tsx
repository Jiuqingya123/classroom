import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LessonDTO } from '@classroom/shared';
import { ErrorBar, Loading, PageHead, StatusTag, Tabs, fmtDateTime } from '../../components/ui';
import { RoomReportModal } from '../../components/RoomReportModal';
import { getApi } from '../../lib/api';
import { useNav } from '../../store/nav';

const API = '/api/v1';

function countdown(ms: number): string {
  if (ms <= 0) return '现在可进入';
  const min = Math.ceil(ms / 60000);
  if (min < 60) return `${min} 分钟后可进入`;
  const h = Math.floor(min / 60);
  return `${h} 小时 ${min % 60} 分钟后可进入`;
}

export function SchedulePage() {
  const goRoom = useNav((s) => s.goRoom);
  const goCourse = useNav((s) => s.goCourse);
  const [tab, setTab] = useState<'upcoming' | 'history'>('upcoming');
  const [upcoming, setUpcoming] = useState<LessonDTO[]>([]);
  const [history, setHistory] = useState<LessonDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reportRoomId, setReportRoomId] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    try {
      const [u, h] = await Promise.all([
        getApi().get<{ lessons: LessonDTO[] }>(`${API}/lessons`),
        getApi().get<{ lessons: LessonDTO[] }>(`${API}/lessons/history`),
      ]);
      setUpcoming(u.lessons);
      setHistory(h.lessons);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const enter = async (lesson: LessonDTO) => {
    setBusy(lesson.id);
    setError(null);
    try {
      const r = await getApi().post<{ roomId: string; joinCode: string | null }>(
        `${API}/lessons/${lesson.id}/enter`,
      );
      goRoom(r.roomId, r.joinCode);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const list = tab === 'upcoming' ? upcoming : history;
  const groups = useMemo(() => {
    const map = new Map<string, LessonDTO[]>();
    for (const l of list) {
      const d = new Date(l.startsAt);
      const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      const arr = map.get(key) ?? [];
      arr.push(l);
      map.set(key, arr);
    }
    return [...map.entries()];
  }, [list]);

  return (
    <div className="wb-page">
      <PageHead title="课表" desc="正式课节在开课前 15 分钟开放进入；老师与助教可提前进入准备。" />
      <ErrorBar message={error} onClose={() => setError(null)} />
      <Tabs<'upcoming' | 'history'>
        tabs={[
          { key: 'upcoming', label: '待上课', count: upcoming.length },
          { key: 'history', label: '历史课节', count: history.length },
        ]}
        value={tab}
        onChange={setTab}
      />

      {loading ? (
        <Loading />
      ) : list.length === 0 ? (
        <div className="empty">{tab === 'upcoming' ? '暂时没有排课' : '还没有历史课节'}</div>
      ) : (
        <div className="schedule-groups">
          {groups.map(([day, lessons]) => (
            <div key={day} className="schedule-group">
              <div className="schedule-day">
                {day.replace(/-/g, ' / ')}
                <span>{lessons.length} 节</span>
              </div>
              {lessons.map((l) => (
                <div className="schedule-row" key={l.id}>
                  <div className="schedule-time">
                    {String(new Date(l.startsAt).getHours()).padStart(2, '0')}:
                    {String(new Date(l.startsAt).getMinutes()).padStart(2, '0')}
                  </div>
                  <div className="schedule-main">
                    <div className="schedule-title">
                      {l.title} <StatusTag status={l.status} />
                    </div>
                    <div className="schedule-meta">
                      <button className="link-btn" onClick={() => goCourse(l.courseId)}>
                        {l.courseTitle}
                      </button>
                      <span> · {l.hostName} · {l.durationMin} 分钟</span>
                      {l.joinCode && <span> · 入会码 {l.joinCode}</span>}
                    </div>
                    {tab === 'upcoming' && !l.canEnter && (
                      <div className="schedule-hint">{countdown(l.startsAt - now - 15 * 60000)}</div>
                    )}
                  </div>
                  <div className="schedule-actions">
                    {l.status === 'scheduled' || l.status === 'live' ? (
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={!l.canEnter || busy === l.id}
                        onClick={() => void enter(l)}
                      >
                        {busy === l.id ? <span className="spinner" /> : l.status === 'live' ? '进入课堂' : '进入教室'}
                      </button>
                    ) : l.status === 'ended' ? (
                      <button className="btn btn-outline btn-sm" onClick={() => setReportRoomId(l.roomId)}>
                        课堂记录
                      </button>
                    ) : (
                      <span className="schedule-meta">已取消</span>
                    )}
                    <span className="schedule-meta">{fmtDateTime(l.startsAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {reportRoomId && <RoomReportModal roomId={reportRoomId} onClose={() => setReportRoomId(null)} />}
    </div>
  );
}
