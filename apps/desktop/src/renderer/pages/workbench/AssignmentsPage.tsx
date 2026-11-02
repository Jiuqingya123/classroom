import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AssignmentDTO, SubmissionDTO } from '@classroom/shared';
import {
  Empty,
  ErrorBar,
  Loading,
  PageHead,
  fmtDateTime,
} from '../../components/ui';
import { getApi } from '../../lib/api';
import { cachedFileUrl, ensureFileUrls, uploadFile } from '../../lib/files';
import { useNav } from '../../store/nav';
import { useSession } from '../../store/session';

const API = '/api/v1';

interface Detail {
  assignment: AssignmentDTO;
  submissions: SubmissionDTO[];
  canManage: boolean;
}

function FileLinks({ ids }: { ids: string[] }) {
  const [, force] = useState(0);
  useEffect(() => {
    if (ids.length === 0) return;
    void ensureFileUrls(ids).then(() => force((n) => n + 1));
  }, [ids]);

  if (ids.length === 0) return null;
  return (
    <div className="file-links">
      {ids.map((id) => {
        const url = cachedFileUrl(id);
        if (!url) return <span key={id} className="file-link muted">附件加载中…</span>;
        return (
          <a key={id} className="file-link" href={url} target="_blank" rel="noreferrer">
            附件 {id.slice(0, 6)}
          </a>
        );
      })}
    </div>
  );
}

export function AssignmentsPage() {
  const user = useSession((s) => s.user);
  const assignmentId = useNav((s) => s.assignmentId);
  const goAssignment = useNav((s) => s.goAssignment);
  const go = useNav((s) => s.go);

  const [list, setList] = useState<AssignmentDTO[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [content, setContent] = useState('');
  const [fileIds, setFileIds] = useState<string[]>([]);
  const [grading, setGrading] = useState<SubmissionDTO | null>(null);
  const [score, setScore] = useState(0);
  const [feedback, setFeedback] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const selectedId = assignmentId ?? list[0]?.id ?? null;

  const loadList = useCallback(async () => {
    try {
      const r = await getApi().get<{ assignments: AssignmentDTO[] }>(`${API}/assignments`);
      setList(r.assignments);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    setGrading(null);
    try {
      const d = await getApi().get<Detail>(`${API}/assignments/${id}`);
      setDetail(d);
      setContent(d.assignment.mySubmission?.content ?? '');
      setFileIds(d.assignment.mySubmission?.fileIds ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  // 通知里指向的作业可能已被删除：列表加载完后清掉失效的选择
  useEffect(() => {
    if (loading || !assignmentId) return;
    if (!list.some((a) => a.id === assignmentId)) go('assignments');
  }, [assignmentId, list, loading, go]);

  const submit = async () => {
    if (!selectedId) return;
    if (detail && Date.now() > detail.assignment.dueAt) {
      setError('作业已过截止时间，无法提交');
      return;
    }
    if (!content.trim() && fileIds.length === 0) {
      setError('请填写答案或上传附件');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await getApi().post(`${API}/assignments/${selectedId}/submit`, {
        content: content.trim(),
        fileIds,
      });
      await Promise.all([loadDetail(selectedId), loadList()]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const attach = async (file: File) => {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      const f = await uploadFile(file, {
        filename: file.name,
        courseId: detail.assignment.courseId,
        purpose: 'homework',
      });
      setFileIds((prev) => [...prev, f.id]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const openGrade = (s: SubmissionDTO) => {
    setGrading(s);
    setScore(s.score ?? 0);
    setFeedback(s.feedback);
  };

  const grade = async () => {
    if (!selectedId || !grading) return;
    setBusy(true);
    setError(null);
    try {
      await getApi().post(
        `${API}/assignments/${selectedId}/grade/${grading.id}`,
        { score, feedback: feedback.trim() },
      );
      setGrading(null);
      await Promise.all([loadDetail(selectedId), loadList()]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const removeAssignment = async () => {
    if (!selectedId || !window.confirm('删除这份作业及其全部提交？')) return;
    setBusy(true);
    try {
      await getApi().delete(`${API}/assignments/${selectedId}`);
      setDetail(null);
      setGrading(null);
      setList((prev) => prev.filter((a) => a.id !== selectedId));
      go('assignments');
      await loadList();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const manager = detail?.canManage ?? false;
  const mine = detail?.assignment.mySubmission ?? null;
  const overdue = detail ? Date.now() > detail.assignment.dueAt : false;

  const summary = useMemo(() => {
    if (!user) return '';
    return manager ? '点击左侧作业查看提交与批改' : '按时提交，老师批改后会收到通知';
  }, [user, manager]);

  return (
    <div className="wb-page">
      <PageHead title="作业" desc={summary} />
      <ErrorBar message={error} onClose={() => setError(null)} />

      {loading ? (
        <Loading />
      ) : list.length === 0 ? (
        <Empty>还没有作业。{user?.role === 'student' ? '等待老师布置。' : '在课程详情里布置作业。'}</Empty>
      ) : (
        <div className="assign-layout">
          <aside className="assign-side">
            {list.map((a) => (
              <button
                key={a.id}
                className="assign-item"
                data-active={a.id === selectedId}
                onClick={() => goAssignment(a.id)}
              >
                <div className="assign-item-title">{a.title}</div>
                <div className="assign-item-meta">{a.courseTitle}</div>
                <div className="assign-item-meta">
                  截止 {fmtDateTime(a.dueAt)}
                  {a.mySubmission
                    ? a.mySubmission.status === 'graded'
                      ? ` · ${a.mySubmission.score} 分`
                      : ' · 已提交'
                    : ''}
                </div>
              </button>
            ))}
          </aside>

          <section className="assign-detail">
            {detailLoading || !detail ? (
              <Loading />
            ) : (
              <>
                <div className="assign-detail-head">
                  <div>
                    <h2>{detail.assignment.title}</h2>
                    <div className="assign-meta">
                      {detail.assignment.courseTitle} · {detail.assignment.teacherName} · 满分{' '}
                      {detail.assignment.maxScore} · 截止 {fmtDateTime(detail.assignment.dueAt)}
                      {overdue ? '（已截止）' : ''}
                    </div>
                  </div>
                  {manager && (
                    <button className="link-btn danger" onClick={() => void removeAssignment()} disabled={busy}>
                      删除作业
                    </button>
                  )}
                </div>

                {detail.assignment.description && (
                  <div className="assign-desc">{detail.assignment.description}</div>
                )}

                {!manager && (
                  <div className="panel" style={{ marginTop: 16 }}>
                    <div className="panel-head">
                      <h2>{mine ? '我的提交' : '提交作业'}</h2>
                      {mine && (
                        <span className={`tag ${mine.status === 'graded' ? 'tag-live' : 'tag-muted'}`}>
                          {mine.status === 'graded' ? `已批改 ${mine.score} 分` : '已提交'}
                        </span>
                      )}
                    </div>
                    {mine?.status === 'graded' ? (
                      <div className="grade-banner">
                        <strong>得分 {mine.score}</strong>
                        {mine.feedback && <span>老师评语：{mine.feedback}</span>}
                      </div>
                    ) : (
                      <>
                        {overdue && (
                          <div className="assign-meta" style={{ color: '#b45309', marginBottom: 8 }}>
                            已过截止时间，无法再提交。
                          </div>
                        )}
                        <div className="field">
                          <label>答案 / 说明</label>
                          <textarea
                            className="input textarea"
                            rows={6}
                            value={content}
                            maxLength={5000}
                            placeholder="在这里写作业内容"
                            onChange={(e) => setContent(e.target.value)}
                          />
                        </div>
                        <div className="field">
                          <label>附件</label>
                          {fileIds.length > 0 && <FileLinks ids={fileIds} />}
                          <input
                            ref={fileRef}
                            type="file"
                            hidden
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) void attach(f);
                            }}
                          />
                          <button
                            className="btn btn-outline btn-sm"
                            disabled={busy || overdue}
                            onClick={() => fileRef.current?.click()}
                          >
                            上传附件
                          </button>
                        </div>
                        {mine && (
                          <div className="assign-meta">
                            上次提交于 {fmtDateTime(mine.submittedAt)}
                          </div>
                        )}
                        <div style={{ marginTop: 12 }}>
                          <button className="btn btn-primary" disabled={busy || overdue} onClick={() => void submit()}>
                            {busy ? <span className="spinner" /> : overdue ? '已截止' : mine ? '重新提交' : '提交作业'}
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {manager && (
                  <div className="panel" style={{ marginTop: 16 }}>
                    <div className="panel-head">
                      <h2>提交情况</h2>
                      <span className="assign-meta">
                        已提交 {detail.assignment.submissionCount} · 已批改 {detail.assignment.gradedCount}
                      </span>
                    </div>
                    {detail.submissions.length === 0 ? (
                      <Empty>还没有学生提交</Empty>
                    ) : (
                      <div className="submission-list">
                        {detail.submissions.map((s) => (
                          <div className="submission" key={s.id}>
                            <div className="submission-head">
                              <div className="member-avatar">{s.studentName.slice(0, 1)}</div>
                              <div className="member-main">
                                <div className="member-name">{s.studentName}</div>
                                <div className="member-mail">{fmtDateTime(s.submittedAt)} 提交</div>
                              </div>
                              <span className={`tag ${s.status === 'graded' ? 'tag-live' : 'tag-muted'}`}>
                                {s.status === 'graded' ? `${s.score} 分` : '待批改'}
                              </span>
                              <button className="btn btn-outline btn-sm" onClick={() => openGrade(s)}>
                                {s.status === 'graded' ? '重新批改' : '批改'}
                              </button>
                            </div>
                            {s.content && <div className="submission-content">{s.content}</div>}
                            <FileLinks ids={s.fileIds} />
                            {s.status === 'graded' && s.feedback && (
                              <div className="submission-feedback">评语：{s.feedback}</div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {grading && (
                  <div className="grade-panel">
                    <h3>批改：{grading.studentName}</h3>
                    <div className="form-row">
                      <div className="field">
                        <label>分数（满分 {detail.assignment.maxScore}）</label>
                        <input
                          className="input"
                          type="number"
                          min={0}
                          max={detail.assignment.maxScore}
                          value={score}
                          onChange={(e) => setScore(Number(e.target.value) || 0)}
                        />
                      </div>
                      <div className="field" style={{ flex: 2 }}>
                        <label>评语</label>
                        <input
                          className="input"
                          value={feedback}
                          maxLength={1000}
                          onChange={(e) => setFeedback(e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="filter-row" style={{ marginTop: 8 }}>
                      <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void grade()}>
                        {busy ? <span className="spinner" /> : '保存批改'}
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setGrading(null)}>
                        取消
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
