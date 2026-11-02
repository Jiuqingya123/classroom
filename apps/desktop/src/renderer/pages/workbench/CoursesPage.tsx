import { useCallback, useEffect, useState } from 'react';
import type { CourseDTO } from '@classroom/shared';
import { ErrorBar, Loading, Modal, PageHead } from '../../components/ui';
import { PlusIcon } from '../../components/Icons';
import { getApi } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { useNav } from '../../store/nav';
import { useSession } from '../../store/session';

const API = '/api/v1';

type Filter = 'all' | 'teaching' | 'learning';

export function CoursesPage() {
  const user = useSession((s) => s.user);
  const goCourse = useNav((s) => s.goCourse);

  const [courses, setCourses] = useState<CourseDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState('');
  const [desc, setDesc] = useState('');
  const [saving, setSaving] = useState(false);

  const canCreate = user?.role === 'teacher' || user?.role === 'admin';

  const load = useCallback(async () => {
    try {
      const r = await getApi().get<{ courses: CourseDTO[] }>(`${API}/courses`);
      setCourses(r.courses);
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

  const create = async () => {
    if (!title.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const r = await getApi().post<{ course: CourseDTO }>(`${API}/courses`, {
        title: title.trim(),
        subject: subject.trim() || undefined,
        description: desc.trim() || undefined,
      });
      setCreateOpen(false);
      setTitle('');
      setSubject('');
      setDesc('');
      goCourse(r.course.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const visible = courses.filter((c) =>
    filter === 'all'
      ? true
      : filter === 'teaching'
        ? c.myRole === 'teacher' || c.myRole === 'assistant'
        : c.myRole === 'student',
  );

  return (
    <div className="wb-page">
      <PageHead
        title="课程"
        desc="课程是课节、花名册、课件、题库与作业的组织单位。"
        actions={
          canCreate ? (
            <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>
              <PlusIcon size={14} /> 创建课程
            </button>
          ) : undefined
        }
      />
      <ErrorBar message={error} onClose={() => setError(null)} />

      <div className="filter-row">
        {(
          [
            ['all', '全部'],
            ['teaching', '我教的'],
            ['learning', '我学的'],
          ] as Array<[Filter, string]>
        ).map(([k, label]) => (
          <button key={k} className="filter-chip" data-active={filter === k} onClick={() => setFilter(k)}>
            {label}
          </button>
        ))}
      </div>

      {loading ? (
        <Loading />
      ) : visible.length === 0 ? (
        <div className="empty">
          没有课程。{canCreate ? '点击右上角创建第一门课程。' : '等待老师把你加入课程。'}
        </div>
      ) : (
        <div className="course-grid">
          {visible.map((c) => (
            <button key={c.id} className="course-card course-card-lg" onClick={() => goCourse(c.id)}>
              <div
                className="course-cover course-cover-lg"
                style={{ background: c.cover || 'linear-gradient(135deg,#3b82f6,#6366f1)' }}
              >
                {c.title.slice(0, 1)}
                <span className="course-role">
                  {c.myRole === 'teacher'
                    ? '老师'
                    : c.myRole === 'assistant'
                      ? '助教'
                      : '学生'}
                </span>
              </div>
              <div className="course-info">
                <div className="course-title">{c.title}</div>
                <div className="course-meta">
                  {c.subject || '通识'} · {c.teacherName}
                </div>
                <div className="course-meta">
                  {c.memberCount} 名成员 · {c.lessonCount} 节课
                </div>
                <div className="course-next">
                  {c.nextLessonAt ? `下节课 ${formatDate(c.nextLessonAt)}` : '暂无排课'}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {createOpen && (
        <Modal
          title="创建课程"
          onClose={() => setCreateOpen(false)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setCreateOpen(false)}>
                取消
              </button>
              <button className="btn btn-primary" onClick={() => void create()} disabled={!title.trim() || saving}>
                {saving ? <span className="spinner" /> : '创建'}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <div className="field">
              <label>课程名称</label>
              <input
                className="input"
                value={title}
                maxLength={60}
                placeholder="例如：初二数学 · 秋季班"
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div className="field">
              <label>学科</label>
              <input
                className="input"
                value={subject}
                maxLength={20}
                placeholder="数学 / 英语 / 编程…"
                onChange={(e) => setSubject(e.target.value)}
              />
            </div>
            <div className="field">
              <label>课程简介</label>
              <textarea
                className="input textarea"
                value={desc}
                maxLength={500}
                rows={3}
                placeholder="这门课讲什么、适合谁"
                onChange={(e) => setDesc(e.target.value)}
              />
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
