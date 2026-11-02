import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AssignmentDTO,
  CourseDetailDTO,
  CoursewareDTO,
  LcicLaunchDTO,
  LcicStatusDTO,
  LessonDTO,
  QuestionDTO,
  QuestionType,
} from '@classroom/shared';
import {
  ErrorBar,
  Loading,
  Modal,
  PageHead,
  StatusTag,
  Tabs,
  fmtDateTime,
  fmtSize,
  fromLocalInput,
  toLocalInput,
} from '../../components/ui';
import { BoardIcon, PlusIcon } from '../../components/Icons';
import { RoomReportModal } from '../../components/RoomReportModal';
import { getApi } from '../../lib/api';
import { absoluteFileUrl, uploadFile } from '../../lib/files';
import { formatDate } from '../../lib/format';
import { useNav } from '../../store/nav';
import { useSession } from '../../store/session';

const API = '/api/v1';

type Tab = 'lessons' | 'members' | 'courseware' | 'questions' | 'assignments';

const QUESTION_TYPE_LABEL: Record<QuestionType, string> = {
  single: '单选题',
  multiple: '多选题',
  judge: '判断题',
};

export function CourseDetailPage() {
  const user = useSession((s) => s.user);
  const courseId = useNav((s) => s.courseId);
  const go = useNav((s) => s.go);
  const goRoom = useNav((s) => s.goRoom);
  const goAssignment = useNav((s) => s.goAssignment);

  const [data, setData] = useState<CourseDetailDTO | null>(null);
  const [assignments, setAssignments] = useState<AssignmentDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('lessons');
  const [busy, setBusy] = useState<string | null>(null);
  const [reportRoomId, setReportRoomId] = useState<string | null>(null);

  const [lessonModal, setLessonModal] = useState<{ mode: 'create' | 'edit'; lesson?: LessonDTO } | null>(null);
  const [lessonTitle, setLessonTitle] = useState('');
  const [lessonStart, setLessonStart] = useState(toLocalInput(Date.now() + 3600_000));
  const [lessonMinutes, setLessonMinutes] = useState(45);

  const [memberModal, setMemberModal] = useState(false);
  const [memberEmails, setMemberEmails] = useState('');
  const [memberRole, setMemberRole] = useState<'student' | 'assistant'>('student');

  const [questionModal, setQuestionModal] = useState(false);
  const [qType, setQType] = useState<QuestionType>('single');
  const [qStem, setQStem] = useState('');
  const [qOptions, setQOptions] = useState([
    { key: 'A', text: '' },
    { key: 'B', text: '' },
    { key: 'C', text: '' },
    { key: 'D', text: '' },
  ]);
  const [qAnswer, setQAnswer] = useState<string[]>([]);
  const [qAnalysis, setQAnalysis] = useState('');

  const [assignmentModal, setAssignmentModal] = useState(false);
  const [aTitle, setATitle] = useState('');
  const [aDesc, setADesc] = useState('');
  const [aDue, setADue] = useState(toLocalInput(Date.now() + 7 * 86400_000));
  const [aMax, setAMax] = useState(100);

  const [editCourseOpen, setEditCourseOpen] = useState(false);
  const [cTitle, setCTitle] = useState('');
  const [cSubject, setCSubject] = useState('');
  const [cDesc, setCDesc] = useState('');
  const [lcicStatus, setLcicStatus] = useState<LcicStatusDTO | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!courseId) return;
    try {
      const d = await getApi().get<CourseDetailDTO>(`${API}/courses/${courseId}`);
      setData(d);
      const a = await getApi().get<{ assignments: AssignmentDTO[] }>(
        `${API}/courses/${courseId}/assignments`,
      );
      setAssignments(a.assignments);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [courseId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let alive = true;
    getApi()
      .get<LcicStatusDTO>(`${API}/lcic/status`)
      .then(
        (s) => {
          if (alive) setLcicStatus(s);
        },
        () => {
          // 老版本服务端没有该接口时静默隐藏入口
          if (alive) setLcicStatus(null);
        },
      );
    return () => {
      alive = false;
    };
  }, []);

  const manager = useMemo(() => {
    if (!data || !user) return false;
    return data.course.myRole === 'teacher' || data.course.myRole === 'assistant' || user.role === 'admin';
  }, [data, user]);

  const enterLesson = async (lesson: LessonDTO) => {
    setBusy(`enter:${lesson.id}`);
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

  const enterLcic = () => {
    if (!courseId || busy === 'lcic') return;
    // 浏览器里先同步开窗，等接口返回后再改地址，避免被弹窗拦截
    const tab = window.desktop ? null : window.open('about:blank', '_blank');
    if (tab) tab.opener = null;
    setBusy('lcic');
    setError(null);
    void (async () => {
      try {
        const r = await getApi().post<LcicLaunchDTO>(`${API}/lcic/courses/${courseId}/launch`);
        if (window.desktop) await window.desktop.openExternal(r.url);
        else if (tab) tab.location.href = r.url;
        else window.location.href = r.url;
      } catch (e) {
        tab?.close();
        setError((e as Error).message);
      } finally {
        setBusy(null);
      }
    })();
  };

  const openLessonModal = (lesson?: LessonDTO) => {
    setLessonTitle(lesson?.title ?? '');
    setLessonStart(toLocalInput(lesson?.startsAt ?? Date.now() + 3600_000));
    setLessonMinutes(lesson?.durationMin ?? 45);
    setLessonModal({ mode: lesson ? 'edit' : 'create', lesson });
  };

  const saveLesson = async () => {
    if (!courseId || !lessonModal) return;
    const startsAt = fromLocalInput(lessonStart);
    if (!startsAt) {
      setError('请选择开课时间');
      return;
    }
    setBusy('lesson-save');
    setError(null);
    try {
      if (lessonModal.mode === 'create') {
        await getApi().post(`${API}/courses/${courseId}/lessons`, {
          title: lessonTitle.trim() || undefined,
          startsAt,
          durationMin: lessonMinutes,
        });
      } else if (lessonModal.lesson) {
        await getApi().patch(`${API}/lessons/${lessonModal.lesson.id}`, {
          title: lessonTitle.trim() || undefined,
          startsAt,
          durationMin: lessonMinutes,
        });
      }
      setLessonModal(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const cancelLesson = async (lesson: LessonDTO) => {
    if (!window.confirm(`取消课节「${lesson.title}」？学生将收到取消通知。`)) return;
    setBusy(`cancel:${lesson.id}`);
    try {
      await getApi().post(`${API}/lessons/${lesson.id}/cancel`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const addMembers = async () => {
    if (!courseId) return;
    const emails = memberEmails
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (emails.length === 0) return;
    setBusy('members');
    setError(null);
    try {
      const r = await getApi().post<{ added: unknown[]; missing: string[] }>(
        `${API}/courses/${courseId}/members`,
        { emails, role: memberRole },
      );
      setMemberModal(false);
      setMemberEmails('');
      if (r.missing.length > 0) {
        window.alert(`以下邮箱尚未注册，未加入：\n${r.missing.join('\n')}`);
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const removeMember = async (userId: string, name: string) => {
    if (!courseId || !window.confirm(`将 ${name} 移出课程？`)) return;
    setBusy(`member:${userId}`);
    try {
      await getApi().delete(`${API}/courses/${courseId}/members/${userId}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const uploadCourseware = async (file: File) => {
    if (!courseId || !manager) return;
    setBusy('courseware');
    setError(null);
    try {
      const uploaded = await uploadFile(file, {
        filename: file.name,
        courseId,
        purpose: 'courseware',
      });
      await getApi().post(`${API}/courses/${courseId}/courseware`, {
        fileId: uploaded.id,
        title: file.name,
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const removeCourseware = async (cw: CoursewareDTO) => {
    if (!courseId || !window.confirm(`删除课件「${cw.title}」？`)) return;
    setBusy(`cw:${cw.id}`);
    try {
      await getApi().delete(`${API}/courses/${courseId}/courseware/${cw.id}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const resetQuestionForm = () => {
    setQType('single');
    setQStem('');
    setQOptions([
      { key: 'A', text: '' },
      { key: 'B', text: '' },
      { key: 'C', text: '' },
      { key: 'D', text: '' },
    ]);
    setQAnswer([]);
    setQAnalysis('');
  };

  const saveQuestion = async () => {
    if (!courseId) return;
    const options =
      qType === 'judge'
        ? [
            { key: 'T', text: '正确' },
            { key: 'F', text: '错误' },
          ]
        : qOptions.filter((o) => o.text.trim());
    const answer = qType === 'judge' ? qAnswer.slice(0, 1) : qAnswer;
    if (!qStem.trim()) {
      setError('请填写题干');
      return;
    }
    if (qType !== 'judge' && options.length < 2) {
      setError('至少填写两个选项');
      return;
    }
    if (answer.length === 0) {
      setError('请选择正确答案');
      return;
    }
    setBusy('question');
    setError(null);
    try {
      await getApi().post(`${API}/courses/${courseId}/questions`, {
        type: qType,
        stem: qStem.trim(),
        options,
        answer,
        analysis: qAnalysis.trim() || undefined,
      });
      setQuestionModal(false);
      resetQuestionForm();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const removeQuestion = async (q: QuestionDTO) => {
    if (!courseId || !window.confirm('删除这道题？')) return;
    setBusy(`q:${q.id}`);
    try {
      await getApi().delete(`${API}/courses/${courseId}/questions/${q.id}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const saveAssignment = async () => {
    if (!courseId) return;
    const dueAt = fromLocalInput(aDue);
    if (!aTitle.trim() || !dueAt) {
      setError('请填写作业标题和截止时间');
      return;
    }
    setBusy('assignment');
    setError(null);
    try {
      await getApi().post(`${API}/courses/${courseId}/assignments`, {
        title: aTitle.trim(),
        description: aDesc.trim() || undefined,
        dueAt,
        maxScore: aMax,
      });
      setAssignmentModal(false);
      setATitle('');
      setADesc('');
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const saveCourse = async () => {
    if (!courseId || !cTitle.trim()) return;
    setBusy('course');
    try {
      await getApi().patch(`${API}/courses/${courseId}`, {
        title: cTitle.trim(),
        subject: cSubject.trim(),
        description: cDesc.trim(),
      });
      setEditCourseOpen(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!courseId) return null;
  if (loading) return <Loading />;
  if (!data) {
    return (
      <div className="wb-page">
        <ErrorBar message={error ?? '课程不存在'} />
        <button className="btn btn-outline" onClick={() => go('courses')}>
          返回课程列表
        </button>
      </div>
    );
  }

  const { course, members, lessons, courseware, questions } = data;

  const tabs: Array<{ key: Tab; label: string; count?: number }> = [
    { key: 'lessons', label: '课节', count: lessons.length },
    { key: 'members', label: '花名册', count: members.length },
    { key: 'courseware', label: '课件', count: courseware.length },
    ...(manager ? [{ key: 'questions' as Tab, label: '题库', count: questions.length }] : []),
    { key: 'assignments', label: '作业', count: assignments.length },
  ];

  return (
    <div className="wb-page">
      <button className="back-link" onClick={() => go('courses')}>
        ← 全部课程
      </button>
      <div className="course-hero">
        <div className="course-hero-mark" style={{ background: course.cover || undefined }}>
          {course.title.slice(0, 1)}
        </div>
        <div className="course-hero-main">
          <PageHead
            title={course.title}
            desc={`${course.subject || '通识'} · ${course.teacherName} · ${course.description || '暂无简介'}`}
          />
        </div>
        <div className="course-hero-actions">
          {manager && (
            <button
              className="btn btn-outline"
              onClick={() => {
                setCTitle(course.title);
                setCSubject(course.subject);
                setCDesc(course.description);
                setEditCourseOpen(true);
              }}
            >
              编辑课程
            </button>
          )}
          {lcicStatus?.enabled && (
            <button
              className="btn btn-primary"
              disabled={busy === 'lcic'}
              title="腾讯云实时互动课堂会在浏览器中打开"
              onClick={() => void enterLcic()}
            >
              {busy === 'lcic' ? <span className="spinner" /> : '进入腾讯课堂'}
            </button>
          )}
        </div>
      </div>

      <ErrorBar message={error} onClose={() => setError(null)} />
      <Tabs<Tab> tabs={tabs} value={tab} onChange={setTab} />

      {tab === 'lessons' && (
        <section className="panel">
          <div className="panel-head">
            <h2>课节安排</h2>
            {manager && (
              <button className="btn btn-primary" onClick={() => openLessonModal()}>
                <PlusIcon size={13} /> 安排课节
              </button>
            )}
          </div>
          {lessons.length === 0 ? (
            <div className="empty">还没有课节</div>
          ) : (
            <div className="lesson-table">
              {lessons.map((l) => (
                <div className="lesson-row" key={l.id}>
                  <div className="lesson-date">
                    <div className="lesson-date-day">
                      {new Date(l.startsAt).getMonth() + 1}/{new Date(l.startsAt).getDate()}
                    </div>
                    <div className="lesson-date-time">
                      {String(new Date(l.startsAt).getHours()).padStart(2, '0')}:
                      {String(new Date(l.startsAt).getMinutes()).padStart(2, '0')}
                    </div>
                  </div>
                  <div className="lesson-main">
                    <div className="lesson-title">
                      {l.title} <StatusTag status={l.status} />
                    </div>
                    <div className="lesson-meta">
                      {l.durationMin} 分钟 · 出勤 {l.attendanceCount} 人
                      {l.joinCode && manager ? ` · 入会码 ${l.joinCode}` : ''}
                    </div>
                  </div>
                  <div className="lesson-actions">
                    {l.status === 'scheduled' || l.status === 'live' ? (
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={!l.canEnter || busy === `enter:${l.id}`}
                        title={l.canEnter ? '' : '开课前 15 分钟开放'}
                        onClick={() => void enterLesson(l)}
                      >
                        {busy === `enter:${l.id}` ? <span className="spinner" /> : '进入'}
                      </button>
                    ) : l.status === 'ended' ? (
                      <button className="btn btn-outline btn-sm" onClick={() => setReportRoomId(l.roomId)}>
                        课堂记录
                      </button>
                    ) : null}
                    {manager && l.status === 'scheduled' && (
                      <>
                        <button className="btn btn-ghost btn-sm" onClick={() => openLessonModal(l)}>
                          调整
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          disabled={busy === `cancel:${l.id}`}
                          onClick={() => void cancelLesson(l)}
                        >
                          取消
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === 'members' && (
        <section className="panel">
          <div className="panel-head">
            <h2>花名册</h2>
            {manager && (
              <button className="btn btn-primary" onClick={() => setMemberModal(true)}>
                <PlusIcon size={13} /> 添加成员
              </button>
            )}
          </div>
          <div className="member-table">
            {members.map((m) => (
              <div className="member-row" key={m.userId}>
                <div className="member-avatar">{m.displayName.slice(0, 1)}</div>
                <div className="member-main">
                  <div className="member-name">
                    {m.displayName}
                    {m.userId === user?.id ? '（我）' : ''}
                  </div>
                  <div className="member-mail">{m.email}</div>
                </div>
                <span className={`tag ${m.memberRole === 'teacher' ? 'tag-teacher' : 'tag-muted'}`}>
                  {m.memberRole === 'teacher' ? '老师' : m.memberRole === 'assistant' ? '助教' : '学生'}
                </span>
                <span className="member-time">{formatDate(m.joinedAt)} 加入</span>
                {manager && m.memberRole !== 'teacher' && (
                  <button
                    className="link-btn danger"
                    disabled={busy === `member:${m.userId}`}
                    onClick={() => void removeMember(m.userId, m.displayName)}
                  >
                    移出
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {tab === 'courseware' && (
        <section className="panel">
          <div className="panel-head">
            <h2>课件库</h2>
            {manager && (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  hidden
                  accept=".pdf,.ppt,.pptx,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.webp,.gif,.mp3,.mp4,.webm,.txt"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void uploadCourseware(f);
                  }}
                />
                <button
                  className="btn btn-primary"
                  disabled={busy === 'courseware'}
                  onClick={() => fileRef.current?.click()}
                >
                  {busy === 'courseware' ? <span className="spinner" /> : '上传课件'}
                </button>
              </>
            )}
          </div>
          {courseware.length === 0 ? (
            <div className="empty">还没有课件。支持 PDF、Office、图片、音视频。</div>
          ) : (
            <div className="cw-grid">
              {courseware.map((cw) => (
                <div className="cw-card" key={cw.id}>
                  <div className="cw-icon">{cw.mime.includes('pdf') ? 'PDF' : cw.mime.split('/')[0]}</div>
                  <div className="cw-main">
                    <div className="cw-title" title={cw.title}>
                      {cw.title}
                    </div>
                    <div className="cw-meta">
                      {fmtSize(cw.size)} · {formatDate(cw.createdAt)}
                    </div>
                  </div>
                  <div className="cw-actions">
                    {cw.url && (
                      <a className="link-btn" href={absoluteFileUrl(cw.url)} target="_blank" rel="noreferrer">
                        打开
                      </a>
                    )}
                    {manager && (
                      <button
                        className="link-btn danger"
                        disabled={busy === `cw:${cw.id}`}
                        onClick={() => void removeCourseware(cw)}
                      >
                        删除
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === 'questions' && manager && (
        <section className="panel">
          <div className="panel-head">
            <h2>题库</h2>
            <button className="btn btn-primary" onClick={() => setQuestionModal(true)}>
              <PlusIcon size={13} /> 新建题目
            </button>
          </div>
          {questions.length === 0 ? (
            <div className="empty">还没有题目。课堂答题卡可以直接引用这里的题目。</div>
          ) : (
            <div className="question-list">
              {questions.map((q, i) => (
                <div className="question-card" key={q.id}>
                  <div className="question-head">
                    <span className="tag tag-muted">{QUESTION_TYPE_LABEL[q.type]}</span>
                    <span className="question-index">第 {i + 1} 题</span>
                    <div style={{ flex: 1 }} />
                    <button className="link-btn danger" onClick={() => void removeQuestion(q)}>
                      删除
                    </button>
                  </div>
                  <div className="question-stem">{q.stem}</div>
                  <div className="question-options">
                    {q.options.map((o) => (
                      <span key={o.key} className="question-option" data-correct={q.answer.includes(o.key)}>
                        {o.key}. {o.text}
                      </span>
                    ))}
                  </div>
                  <div className="question-meta">
                    答案：{q.answer.join('、')}
                    {q.analysis ? ` · 解析：${q.analysis}` : ''}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === 'assignments' && (
        <section className="panel">
          <div className="panel-head">
            <h2>作业</h2>
            {manager && (
              <button className="btn btn-primary" onClick={() => setAssignmentModal(true)}>
                <PlusIcon size={13} /> 布置作业
              </button>
            )}
          </div>
          {assignments.length === 0 ? (
            <div className="empty">还没有作业</div>
          ) : (
            <div className="assign-list">
              {assignments.map((a) => (
                <button className="assign-row" key={a.id} onClick={() => goAssignment(a.id)}>
                  <div className="assign-main">
                    <div className="assign-title">{a.title}</div>
                    <div className="assign-meta">
                      截止 {fmtDateTime(a.dueAt)} · 满分 {a.maxScore}
                      {manager ? ` · 已交 ${a.submissionCount} · 已批 ${a.gradedCount}` : ''}
                    </div>
                  </div>
                  <span className={`tag ${a.mySubmission ? (a.mySubmission.status === 'graded' ? 'tag-live' : 'tag-muted') : 'tag-ended'}`}>
                    {a.mySubmission
                      ? a.mySubmission.status === 'graded'
                        ? `已批改 ${a.mySubmission.score} 分`
                        : '已提交'
                      : manager
                        ? '收起'
                        : '未提交'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {lessonModal && (
        <Modal
          title={lessonModal.mode === 'create' ? '安排课节' : '调整课节'}
          onClose={() => setLessonModal(null)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setLessonModal(null)}>
                取消
              </button>
              <button className="btn btn-primary" onClick={() => void saveLesson()} disabled={busy === 'lesson-save'}>
                {busy === 'lesson-save' ? <span className="spinner" /> : '保存'}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <div className="field">
              <label>课节名称</label>
              <input
                className="input"
                value={lessonTitle}
                maxLength={60}
                placeholder="留空自动命名"
                onChange={(e) => setLessonTitle(e.target.value)}
              />
            </div>
            <div className="field">
              <label>开课时间</label>
              <input
                className="input"
                type="datetime-local"
                value={lessonStart}
                onChange={(e) => setLessonStart(e.target.value)}
              />
            </div>
            <div className="field">
              <label>时长（分钟）</label>
              <input
                className="input"
                type="number"
                min={10}
                max={240}
                value={lessonMinutes}
                onChange={(e) => setLessonMinutes(Number(e.target.value) || 45)}
              />
            </div>
            <div className="hint-bar">系统会自动检查老师在该时间段是否已有其他课节。</div>
          </div>
        </Modal>
      )}

      {memberModal && (
        <Modal
          title="添加成员"
          onClose={() => setMemberModal(false)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setMemberModal(false)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void addMembers()}
                disabled={!memberEmails.trim() || busy === 'members'}
              >
                {busy === 'members' ? <span className="spinner" /> : '添加'}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <div className="field">
              <label>成员邮箱（每行一个，或逗号分隔）</label>
              <textarea
                className="input textarea"
                rows={5}
                value={memberEmails}
                placeholder="student1@example.com&#10;student2@example.com"
                onChange={(e) => setMemberEmails(e.target.value)}
              />
            </div>
            <div className="field">
              <label>角色</label>
              <select className="input" value={memberRole} onChange={(e) => setMemberRole(e.target.value as 'student' | 'assistant')}>
                <option value="student">学生</option>
                <option value="assistant">助教</option>
              </select>
            </div>
            <div className="hint-bar">成员需先注册账号。未注册的邮箱会在提交后列出。</div>
          </div>
        </Modal>
      )}

      {questionModal && (
        <Modal
          title="新建题目"
          width={620}
          onClose={() => setQuestionModal(false)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setQuestionModal(false)}>
                取消
              </button>
              <button className="btn btn-primary" onClick={() => void saveQuestion()} disabled={busy === 'question'}>
                {busy === 'question' ? <span className="spinner" /> : '保存'}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <div className="field">
              <label>题型</label>
              <select
                className="input"
                value={qType}
                onChange={(e) => {
                  const t = e.target.value as QuestionType;
                  setQType(t);
                  setQAnswer([]);
                  if (t === 'judge') setQOptions([]);
                }}
              >
                <option value="single">单选题</option>
                <option value="multiple">多选题</option>
                <option value="judge">判断题</option>
              </select>
            </div>
            <div className="field">
              <label>题干</label>
              <textarea
                className="input textarea"
                rows={3}
                value={qStem}
                maxLength={1000}
                onChange={(e) => setQStem(e.target.value)}
              />
            </div>
            {qType !== 'judge' && (
              <div className="field">
                <label>选项与答案</label>
                <div className="option-editor">
                  {qOptions.map((o, i) => (
                    <div className="option-edit-row" key={o.key}>
                      <button
                        className="option-check"
                        data-active={qAnswer.includes(o.key)}
                        onClick={() => {
                          if (qType === 'single') setQAnswer([o.key]);
                          else
                            setQAnswer((prev) =>
                              prev.includes(o.key) ? prev.filter((k) => k !== o.key) : [...prev, o.key],
                            );
                        }}
                        title="设为正确答案"
                      >
                        {o.key}
                      </button>
                      <input
                        className="input"
                        value={o.text}
                        placeholder={`选项 ${o.key}`}
                        onChange={(e) =>
                          setQOptions((prev) =>
                            prev.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)),
                          )
                        }
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
            {qType === 'judge' && (
              <div className="field">
                <label>正确答案</label>
                <div className="filter-row">
                  {(
                    [
                      ['T', '正确'],
                      ['F', '错误'],
                    ] as const
                  ).map(([k, label]) => (
                    <button
                      key={k}
                      className="filter-chip"
                      data-active={qAnswer.includes(k)}
                      onClick={() => setQAnswer([k])}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="field">
              <label>解析（可选）</label>
              <textarea
                className="input textarea"
                rows={2}
                value={qAnalysis}
                maxLength={1000}
                onChange={(e) => setQAnalysis(e.target.value)}
              />
            </div>
          </div>
        </Modal>
      )}

      {assignmentModal && (
        <Modal
          title="布置作业"
          onClose={() => setAssignmentModal(false)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setAssignmentModal(false)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void saveAssignment()}
                disabled={!aTitle.trim() || busy === 'assignment'}
              >
                {busy === 'assignment' ? <span className="spinner" /> : '布置'}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <div className="field">
              <label>作业标题</label>
              <input className="input" value={aTitle} maxLength={120} onChange={(e) => setATitle(e.target.value)} />
            </div>
            <div className="field">
              <label>作业说明</label>
              <textarea
                className="input textarea"
                rows={3}
                value={aDesc}
                maxLength={2000}
                onChange={(e) => setADesc(e.target.value)}
              />
            </div>
            <div className="form-row">
              <div className="field">
                <label>截止时间</label>
                <input
                  className="input"
                  type="datetime-local"
                  value={aDue}
                  onChange={(e) => setADue(e.target.value)}
                />
              </div>
              <div className="field">
                <label>满分</label>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={1000}
                  value={aMax}
                  onChange={(e) => setAMax(Number(e.target.value) || 100)}
                />
              </div>
            </div>
          </div>
        </Modal>
      )}

      {editCourseOpen && (
        <Modal
          title="编辑课程"
          onClose={() => setEditCourseOpen(false)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setEditCourseOpen(false)}>
                取消
              </button>
              <button className="btn btn-primary" onClick={() => void saveCourse()} disabled={!cTitle.trim() || busy === 'course'}>
                {busy === 'course' ? <span className="spinner" /> : '保存'}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <div className="field">
              <label>课程名称</label>
              <input className="input" value={cTitle} maxLength={60} onChange={(e) => setCTitle(e.target.value)} />
            </div>
            <div className="field">
              <label>学科</label>
              <input className="input" value={cSubject} maxLength={40} onChange={(e) => setCSubject(e.target.value)} />
            </div>
            <div className="field">
              <label>简介</label>
              <textarea
                className="input textarea"
                rows={3}
                value={cDesc}
                maxLength={1000}
                onChange={(e) => setCDesc(e.target.value)}
              />
            </div>
          </div>
        </Modal>
      )}

      {reportRoomId && <RoomReportModal roomId={reportRoomId} onClose={() => setReportRoomId(null)} />}
    </div>
  );
}
