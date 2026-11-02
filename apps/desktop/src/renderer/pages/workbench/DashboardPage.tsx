import { useCallback, useEffect, useState } from 'react';
import type { CourseDTO, LessonDTO, NotificationDTO, UserDTO } from '@classroom/shared';
import { getApi } from '../../lib/api';
import { formatDate, normalizeCode } from '../../lib/format';
import { useNav } from '../../store/nav';
import { useNotify } from '../../store/notify';
import { useSession } from '../../store/session';
import { ErrorBar, Loading } from '../../components/ui';
import { CopyIcon } from '../../components/Icons';

const API = '/api/v1';

function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return '夜深了';
  if (h < 12) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

function roleHint(user: UserDTO): string {
  if (user.role === 'admin') return '这里是机构管理与教学的统一入口';
  if (user.role === 'teacher') return '课前备好课，课中管好场，课后留好档';
  if (user.role === 'assistant') return '协助老师管理课堂与作业';
  return '按时进入课堂，别错过老师的签到与答题';
}

export function DashboardPage() {
  const user = useSession((s) => s.user);
  const go = useNav((s) => s.go);
  const goCourse = useNav((s) => s.goCourse);
  const goAssignment = useNav((s) => s.goAssignment);
  const goRoom = useNav((s) => s.goRoom);
  const setUnread = useNotify((s) => s.setUnread);

  const [lessons, setLessons] = useState<LessonDTO[]>([]);
  const [courses, setCourses] = useState<CourseDTO[]>([]);
  const [notifications, setNotifications] = useState<NotificationDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [l, c, n] = await Promise.all([
        getApi().get<{ lessons: LessonDTO[] }>(`${API}/lessons`),
        getApi().get<{ courses: CourseDTO[] }>(`${API}/courses`),
        getApi().get<{ notifications: NotificationDTO[] }>(`${API}/notifications?limit=5`),
      ]);
      setLessons(l.lessons);
      setCourses(c.courses);
      setNotifications(n.notifications);
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

  const enter = async (lesson: LessonDTO) => {
    setBusyId(lesson.id);
    setError(null);
    try {
      const r = await getApi().post<{ roomId: string; joinCode: string | null }>(
        `${API}/lessons/${lesson.id}/enter`,
      );
      goRoom(r.roomId, r.joinCode);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const joinByCode = async () => {
    const c = normalizeCode(code);
    if (c.length !== 6) return;
    setBusyId('code');
    setError(null);
    try {
      const r = await getApi().post<{ room: { id: string } }>(`${API}/rooms/join`, { code: c });
      setCode('');
      goRoom(r.room.id, c);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const next = lessons[0];
  const upcoming = lessons.filter((l) => l.status === 'scheduled').slice(0, 4);
  const unread = notifications.filter((n) => !n.readAt).length;

  const openNotification = (n: NotificationDTO) => {
    if (!n.readAt) {
      setNotifications((prev) => prev.map((x) => (x.id === n.id ? { ...x, readAt: Date.now() } : x)));
      setUnread(Math.max(0, unread - 1));
      void getApi().post(`${API}/notifications/${n.id}/read`).catch(() => {
        /* 已读标记失败不拦截跳转 */
      });
    }
    if (n.link.startsWith('course:')) goCourse(n.link.slice(7));
    else if (n.link.startsWith('assignment:')) goAssignment(n.link.slice('assignment:'.length));
    else go('notifications');
  };

  if (!user) return null;

  return (
    <div className="wb-page">
      <div className="wb-hero">
        <div>
          <h1 className="wb-hello">
            {greeting()}，{user.displayName}
          </h1>
          <p className="wb-hello-sub">{roleHint(user)}</p>
        </div>
        <div className="wb-hero-actions">
          <div className="quick-code">
            <input
              className="input code-input"
              inputMode="numeric"
              placeholder="输入 6 位入会码"
              value={code}
              maxLength={6}
              onChange={(e) => setCode(normalizeCode(e.target.value))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void joinByCode();
              }}
            />
            <button
              className="btn btn-primary"
              disabled={code.length !== 6 || busyId === 'code'}
              onClick={() => void joinByCode()}
            >
              {busyId === 'code' ? <span className="spinner" /> : '进入课堂'}
            </button>
          </div>
        </div>
      </div>

      <ErrorBar message={error} onClose={() => setError(null)} />

      {loading ? (
        <Loading />
      ) : (
        <>
          <div className="wb-grid">
            <section className="wb-card wb-next">
              <div className="wb-card-head">
                <h2>下一节课</h2>
                <button className="link-btn" onClick={() => go('schedule')}>
                  全部课表 →
                </button>
              </div>
              {next ? (
                <div className="next-lesson">
                  <div className="next-time">
                    <div className="next-day">
                      {new Date(next.startsAt).getMonth() + 1}/{new Date(next.startsAt).getDate()}
                    </div>
                    <div className="next-clock">
                      {String(new Date(next.startsAt).getHours()).padStart(2, '0')}:
                      {String(new Date(next.startsAt).getMinutes()).padStart(2, '0')}
                    </div>
                  </div>
                  <div className="next-main">
                    <div className="next-title">{next.title}</div>
                    <div className="next-meta">
                      {next.courseTitle} · {next.hostName} · {next.durationMin} 分钟
                    </div>
                    <div className="next-meta">
                      {next.canEnter
                        ? next.status === 'live'
                          ? '课堂进行中，可直接进入'
                          : '已到可进入时间（开课前 15 分钟开放）'
                        : `距可进入还有 ${Math.ceil(next.enterInMs / 60000)} 分钟`}
                    </div>
                  </div>
                  <div className="next-actions">
                    <button
                      className="btn btn-primary"
                      disabled={!next.canEnter || busyId === next.id}
                      onClick={() => void enter(next)}
                    >
                      {busyId === next.id ? <span className="spinner" /> : '进入教室'}
                    </button>
                    {next.joinCode && user.role !== 'student' && (
                      <button
                        className="btn btn-outline"
                        title="复制入会码"
                        onClick={() => void navigator.clipboard.writeText(next.joinCode ?? '')}
                      >
                        <CopyIcon size={13} /> {next.joinCode}
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="empty">
                  {user.role === 'student' ? '暂时没有安排，等待老师排课。' : '还没有排课，去课程里安排一节。'}
                  <div style={{ marginTop: 12 }}>
                    <button className="btn btn-outline" onClick={() => go('courses')}>
                      前往课程
                    </button>
                  </div>
                </div>
              )}
            </section>

            <section className="wb-card">
              <div className="wb-card-head">
                <h2>数据速览</h2>
              </div>
              <div className="stat-grid">
                <div className="stat">
                  <div className="stat-num">{lessons.length}</div>
                  <div className="stat-label">待上课节</div>
                </div>
                <div className="stat">
                  <div className="stat-num">{courses.length}</div>
                  <div className="stat-label">我的课程</div>
                </div>
                <div className="stat">
                  <div className="stat-num">{unread}</div>
                  <div className="stat-label">未读通知</div>
                </div>
              </div>
              <div className="wb-card-head" style={{ marginTop: 18 }}>
                <h2>最近通知</h2>
                <button className="link-btn" onClick={() => go('notifications')}>
                  全部 →
                </button>
              </div>
              {notifications.length === 0 ? (
                <div className="empty">暂无通知</div>
              ) : (
                <div className="mini-list">
                  {notifications.map((n) => (
                    <button key={n.id} className="mini-row" onClick={() => openNotification(n)}>
                      <span className={`dot ${n.readAt ? '' : 'dot-on'}`} />
                      <span className="mini-title">{n.title}</span>
                      <span className="mini-time">{formatDate(n.createdAt)}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </div>

          <section className="wb-card" style={{ marginTop: 18 }}>
            <div className="wb-card-head">
              <h2>即将开始</h2>
              <button className="link-btn" onClick={() => go('schedule')}>
                查看全部 →
              </button>
            </div>
            {upcoming.length === 0 ? (
              <div className="empty">没有待开课的课节</div>
            ) : (
              <div className="lesson-strip">
                {upcoming.map((l) => (
                  <button key={l.id} className="lesson-chip" onClick={() => void enter(l)} disabled={!l.canEnter}>
                    <span className="lesson-chip-time">{formatDate(l.startsAt)}</span>
                    <span className="lesson-chip-title">{l.title}</span>
                    <span className="lesson-chip-meta">{l.courseTitle}</span>
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="wb-card" style={{ marginTop: 18 }}>
            <div className="wb-card-head">
              <h2>我的课程</h2>
              <button className="link-btn" onClick={() => go('courses')}>
                全部课程 →
              </button>
            </div>
            {courses.length === 0 ? (
              <div className="empty">还没有课程</div>
            ) : (
              <div className="course-grid">
                {courses.slice(0, 3).map((c) => (
                  <button key={c.id} className="course-card" onClick={() => goCourse(c.id)}>
                    <div className="course-cover" style={{ background: c.cover || undefined }}>
                      {c.title.slice(0, 1)}
                    </div>
                    <div className="course-info">
                      <div className="course-title">{c.title}</div>
                      <div className="course-meta">
                        {c.subject || '通识'} · {c.teacherName}
                      </div>
                      <div className="course-meta">
                        {c.memberCount} 名成员 · {c.lessonCount} 节课
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
