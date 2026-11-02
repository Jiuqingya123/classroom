import { useEffect, useMemo, useState } from 'react';
import type { AwardKind, ParticipantDTO, QuestionDTO, QuestionType } from '@classroom/shared';
import { Modal } from '../components/ui';
import { getApi } from '../lib/api';
import { formatDuration } from '../lib/format';
import { useRoom, useSelfStaff } from '../store/room';

const API = '/api/v1';

type ModalKind = 'announce' | 'award' | 'quiz' | 'timer' | 'signin' | null;

function timeLeft(now: number, endsAt: number | null): number {
  if (!endsAt) return 0;
  return Math.max(0, endsAt - now);
}

export function InteractionPanel() {
  const room = useRoom((s) => s.room);
  const participants = useRoom((s) => s.participants);
  const selfId = useRoom((s) => s.selfId);
  const timer = useRoom((s) => s.timer);
  const signin = useRoom((s) => s.signin);
  const quiz = useRoom((s) => s.quiz);
  const quizResult = useRoom((s) => s.quizResult);
  const myQuizAnswer = useRoom((s) => s.myQuizAnswer);
  const awards = useRoom((s) => s.awards);
  const allMuted = useRoom((s) => s.allMuted);

  const control = useRoom((s) => s.control);
  const randomPick = useRoom((s) => s.randomPick);
  const announce = useRoom((s) => s.announce);
  const award = useRoom((s) => s.award);
  const startQuiz = useRoom((s) => s.startQuiz);
  const answerQuiz = useRoom((s) => s.answerQuiz);
  const endQuiz = useRoom((s) => s.endQuiz);
  const startTimer = useRoom((s) => s.startTimer);
  const stopTimer = useRoom((s) => s.stopTimer);
  const startSignin = useRoom((s) => s.startSignin);
  const markSignin = useRoom((s) => s.markSignin);
  const endSignin = useRoom((s) => s.endSignin);

  const staff = useSelfStaff();
  const [modal, setModal] = useState<ModalKind>(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);

  const [announceText, setAnnounceText] = useState('');
  const [awardTarget, setAwardTarget] = useState('');
  const [awardKind, setAwardKind] = useState<AwardKind>('star');
  const [awardPoints, setAwardPoints] = useState(5);
  const [awardRemark, setAwardRemark] = useState('');

  const [qType, setQType] = useState<QuestionType>('single');
  const [qStem, setQStem] = useState('');
  const [qOptions, setQOptions] = useState([
    { key: 'A', text: '' },
    { key: 'B', text: '' },
    { key: 'C', text: '' },
    { key: 'D', text: '' },
  ]);
  const [qAnswer, setQAnswer] = useState<string[]>([]);
  /** 切到判断题时暂存选择题的选项与答案，切回来不丢已输入内容 */
  const [choiceDraft, setChoiceDraft] = useState<{
    options: { key: string; text: string }[];
    answer: string[];
  } | null>(null);
  const [judgeAnswer, setJudgeAnswer] = useState<string[]>([]);
  const [qDuration, setQDuration] = useState(60);
  const [bank, setBank] = useState<QuestionDTO[]>([]);
  const [bankId, setBankId] = useState('');
  const [answerDraft, setAnswerDraft] = useState<string[]>([]);
  const [mySigned, setMySigned] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (modal !== 'quiz' || !staff || !room?.courseId) return;
    void (async () => {
      try {
        const r = await getApi().get<{ questions: QuestionDTO[] }>(
          `${API}/courses/${room.courseId}/questions`,
        );
        setBank(r.questions);
      } catch {
        setBank([]);
      }
    })();
  }, [modal, staff, room?.courseId]);

  useEffect(() => {
    if (!quiz) setAnswerDraft([]);
  }, [quiz]);

  useEffect(() => {
    setMySigned(false);
  }, [signin?.signinId]);

  const students = useMemo(() => participants.filter((p) => p.role === 'student'), [participants]);

  const startManualQuiz = async () => {
    const options =
      qType === 'judge'
        ? [
            { key: 'T', text: '正确' },
            { key: 'F', text: '错误' },
          ]
        : qOptions.filter((o) => o.text.trim());
    if (!qStem.trim()) return;
    setBusy(true);
    const ok = await startQuiz({
      questionId: null,
      stem: qStem.trim(),
      type: qType,
      options,
      correctAnswer: qAnswer,
      durationSec: qDuration,
    });
    setBusy(false);
    if (ok) {
      setModal(null);
      setQStem('');
      setQAnswer([]);
    }
  };

  const startBankQuiz = async () => {
    const q = bank.find((x) => x.id === bankId);
    if (!q) return;
    setBusy(true);
    const ok = await startQuiz({
      questionId: q.id,
      stem: q.stem,
      type: q.type,
      options: q.options,
      correctAnswer: q.answer,
      analysis: q.analysis,
      durationSec: qDuration,
    });
    setBusy(false);
    if (ok) setModal(null);
  };

  const timerLabel = timer
    ? timer.mode === 'countdown'
      ? formatDuration(timeLeft(now, timer.endsAt))
      : formatDuration(now - timer.startedAt)
    : null;

  const signinLeft = signin ? timeLeft(now, signin.endsAt) : 0;
  const signedByMe = mySigned || (signin?.signed?.some((s) => s.userId === selfId) ?? false);

  return (
    <>
      {timer && (
        <div className="int-card">
          <div className="int-card-head">
            <span>{timer.mode === 'countdown' ? '倒计时' : '计时'}</span>
            <span className="int-timer">{timerLabel}</span>
          </div>
          {staff && (
            <button className="mini-btn" onClick={() => void stopTimer()}>
              停止
            </button>
          )}
        </div>
      )}

      {signin && (
        <div className="int-card">
          <div className="int-card-head">
            <span>签到</span>
            <span className="int-muted">
              {signin.signedCount}/{signin.totalStudents}
              {!signin.done ? ` · 剩 ${Math.ceil(signinLeft / 1000)} 秒` : ' · 已结束'}
            </span>
          </div>
          {!staff && !signin.done && (
            <button
              className="btn btn-primary btn-sm btn-block"
              disabled={signedByMe}
              onClick={() => {
                void markSignin().then((ok) => ok && setMySigned(true));
              }}
            >
              {signedByMe ? '已签到' : '签到'}
            </button>
          )}
          {staff && (
            <>
              {signin.signed && signin.signed.length > 0 && (
                <div className="int-signed">
                  {signin.signed.map((s) => (
                    <span key={s.userId} className="tag tag-muted">
                      {s.displayName}
                    </span>
                  ))}
                </div>
              )}
              {!signin.done && (
                <button className="mini-btn" onClick={() => void endSignin()}>
                  结束签到
                </button>
              )}
            </>
          )}
        </div>
      )}

      {quiz && (
        <div className="int-card int-quiz">
          <div className="int-card-head">
            <span>答题进行中</span>
            <span className="int-muted">
              {quiz.answeredCount}/{quiz.totalStudents}
            </span>
          </div>
          <div className="int-quiz-stem">{quiz.stem}</div>
          {staff ? (
            <button className="mini-btn" onClick={() => void endQuiz()}>
              结束答题
            </button>
          ) : myQuizAnswer ? (
            <div className="int-muted">已提交：{myQuizAnswer.join('、')}，等待老师结束</div>
          ) : (
            <div className="quiz-mini-options">
              {quiz.options.map((o) => (
                <button
                  key={o.key}
                  className="quiz-mini-option"
                  data-active={answerDraft.includes(o.key)}
                  onClick={() => {
                    if (quiz.type === 'multiple')
                      setAnswerDraft((prev) =>
                        prev.includes(o.key) ? prev.filter((k) => k !== o.key) : [...prev, o.key],
                      );
                    else setAnswerDraft([o.key]);
                  }}
                >
                  {o.key}. {o.text}
                </button>
              ))}
              <button
                className="btn btn-primary btn-sm btn-block"
                disabled={answerDraft.length === 0}
                onClick={() => void answerQuiz(answerDraft)}
              >
                提交答案
              </button>
            </div>
          )}
        </div>
      )}

      {staff ? (
        <>
          <div className="int-grid">
            <button
              className="int-action"
              onClick={() => void control(allMuted ? 'unmute_all' : 'mute_all')}
            >
              <span className="int-action-title">{allMuted ? '解除全员静音' : '全员静音'}</span>
              <span className="int-action-sub">{allMuted ? '学生可以重新开麦' : '立即静音所有学生'}</span>
            </button>
            <button className="int-action" onClick={() => void randomPick()}>
              <span className="int-action-title">随机点名</span>
              <span className="int-action-sub">{students.length} 名学生可选</span>
            </button>
            <button className="int-action" onClick={() => setModal('quiz')}>
              <span className="int-action-title">答题卡</span>
              <span className="int-action-sub">题库选题或现场出题</span>
            </button>
            <button className="int-action" onClick={() => setModal('timer')}>
              <span className="int-action-title">计时器</span>
              <span className="int-action-sub">倒计时 / 正计时</span>
            </button>
            <button className="int-action" onClick={() => setModal('signin')}>
              <span className="int-action-title">发起签到</span>
              <span className="int-action-sub">统计到场学生</span>
            </button>
            <button className="int-action" onClick={() => setModal('announce')}>
              <span className="int-action-title">发布公告</span>
              <span className="int-action-sub">全班可见</span>
            </button>
            <button className="int-action" onClick={() => setModal('award')}>
              <span className="int-action-title">发放奖励</span>
              <span className="int-action-sub">小红花 / 奖杯</span>
            </button>
          </div>

          {awards.length > 0 && (
            <div className="int-card">
              <div className="int-card-head">
                <span>最近奖励</span>
              </div>
              <div className="award-list">
                {awards
                  .slice(-6)
                  .reverse()
                  .map((a) => (
                    <div className="award-row" key={a.id}>
                      <span>{a.toName}</span>
                      <span className="int-muted">+{a.points}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="int-grid">
          <button
            className="int-action"
            onClick={() => {
              if (signin && !signin.done && !signedByMe) {
                void markSignin().then((ok) => ok && setMySigned(true));
              }
            }}
            disabled={!signin || signin.done || signedByMe}
          >
            <span className="int-action-title">{signedByMe ? '已签到' : '课堂签到'}</span>
            <span className="int-action-sub">{signin && !signin.done ? '点击完成签到' : '暂无进行中的签到'}</span>
          </button>
          <div className="int-action">
            <span className="int-action-title">我的奖励</span>
            <span className="int-action-sub">
              {participants.find((p) => p.userId === selfId)?.rewardCount ?? 0} 分
            </span>
          </div>
        </div>
      )}

      {quizResult && (
        <div className="int-card">
          <div className="int-card-head">
            <span>上次答题结果</span>
            <span className="int-muted">{quizResult.answeredCount} 人作答</span>
          </div>
          <div className="int-muted">
            正确答案：{quizResult.correctAnswer.join('、')}
            {quizResult.analysis ? ` · ${quizResult.analysis}` : ''}
          </div>
        </div>
      )}

      {modal === 'announce' && (
        <Modal
          title="发布公告"
          onClose={() => setModal(null)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setModal(null)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                disabled={!announceText.trim() || busy}
                onClick={() => {
                  setBusy(true);
                  void announce(announceText.trim()).then((ok) => {
                    setBusy(false);
                    if (ok) {
                      setModal(null);
                      setAnnounceText('');
                    }
                  });
                }}
              >
                发布
              </button>
            </>
          }
        >
          <textarea
            className="input textarea"
            rows={4}
            maxLength={500}
            value={announceText}
            placeholder="例如：请同学们翻到第 12 页，完成课堂练习"
            onChange={(e) => setAnnounceText(e.target.value)}
          />
        </Modal>
      )}

      {modal === 'award' && (
        <Modal
          title="发放奖励"
          onClose={() => setModal(null)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setModal(null)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                disabled={!awardTarget || busy}
                onClick={() => {
                  setBusy(true);
                  void award(awardTarget, awardKind, awardPoints, awardRemark.trim() || undefined).then((ok) => {
                    setBusy(false);
                    if (ok) setModal(null);
                  });
                }}
              >
                发放
              </button>
            </>
          }
        >
          <div className="form-grid">
            <div className="field">
              <label>学生</label>
              <select className="input" value={awardTarget} onChange={(e) => setAwardTarget(e.target.value)}>
                <option value="">选择学生</option>
                {students.map((p) => (
                  <option key={p.userId} value={p.userId}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-row">
              <div className="field">
                <label>类型</label>
                <select
                  className="input"
                  value={awardKind}
                  onChange={(e) => setAwardKind(e.target.value as AwardKind)}
                >
                  <option value="star">星星</option>
                  <option value="trophy">奖杯</option>
                  <option value="flower">小红花</option>
                </select>
              </div>
              <div className="field">
                <label>分值</label>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={100}
                  value={awardPoints}
                  onChange={(e) => setAwardPoints(Math.min(100, Math.max(1, Number(e.target.value) || 1)))}
                />
              </div>
            </div>
            <div className="field">
              <label>评语（可选）</label>
              <input
                className="input"
                maxLength={80}
                value={awardRemark}
                onChange={(e) => setAwardRemark(e.target.value)}
              />
            </div>
          </div>
        </Modal>
      )}

      {modal === 'timer' && (
        <Modal title="计时器" onClose={() => setModal(null)}>
          <div className="filter-row">
            {[60, 180, 300, 600].map((s) => (
              <button
                key={s}
                className="filter-chip"
                onClick={() => {
                  void startTimer('countdown', s).then((ok) => ok && setModal(null));
                }}
              >
                倒计时 {s / 60} 分钟
              </button>
            ))}
          </div>
          <div style={{ marginTop: 12 }}>
            <button
              className="btn btn-outline"
              onClick={() => {
                void startTimer('stopwatch', 0).then((ok) => ok && setModal(null));
              }}
            >
              开始正计时
            </button>
          </div>
        </Modal>
      )}

      {modal === 'signin' && (
        <Modal title="发起签到" onClose={() => setModal(null)}>
          <p className="assign-meta">学生会在课堂内看到签到按钮，签到结果可在互动面板实时查看。</p>
          <div className="filter-row">
            {[60, 120, 300].map((s) => (
              <button
                key={s}
                className="filter-chip"
                onClick={() => {
                  void startSignin(s).then((ok) => ok && setModal(null));
                }}
              >
                {s / 60} 分钟
              </button>
            ))}
          </div>
        </Modal>
      )}

      {modal === 'quiz' && (
        <Modal
          title="课堂答题"
          width={640}
          onClose={() => setModal(null)}
          footer={
            <>
              <button className="btn btn-ghost" onClick={() => setModal(null)}>
                取消
              </button>
              <button
                className="btn btn-primary"
                disabled={busy || (!bankId && !qStem.trim())}
                onClick={() => (bankId ? void startBankQuiz() : void startManualQuiz())}
              >
                开始答题
              </button>
            </>
          }
        >
          {bank.length > 0 && (
            <div className="field">
              <label>从题库选择</label>
              <select
                className="input"
                value={bankId}
                onChange={(e) => {
                  setBankId(e.target.value);
                  const q = bank.find((x) => x.id === e.target.value);
                  if (q) {
                    setQStem(q.stem);
                    setQType(q.type);
                    setQOptions(q.options);
                    setQAnswer(q.answer);
                  } else {
                    setQStem('');
                    setQAnswer([]);
                  }
                }}
              >
                <option value="">现场出题</option>
                {bank.map((q) => (
                  <option key={q.id} value={q.id}>
                    {q.stem.slice(0, 40)}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="form-grid">
            <div className="form-row">
              <div className="field">
                <label>题型</label>
                <select
                  className="input"
                  value={qType}
                  disabled={!!bankId}
                  onChange={(e) => {
                    const t = e.target.value as QuestionType;
                    if (t === qType) return;
                    if (t === 'judge') {
                      setChoiceDraft({ options: qOptions, answer: qAnswer });
                      setQOptions([
                        { key: 'T', text: '正确' },
                        { key: 'F', text: '错误' },
                      ]);
                      setQAnswer(judgeAnswer);
                    } else {
                      if (qType === 'judge') setJudgeAnswer(qAnswer);
                      setQOptions(
                        choiceDraft?.options ?? [
                          { key: 'A', text: '' },
                          { key: 'B', text: '' },
                          { key: 'C', text: '' },
                          { key: 'D', text: '' },
                        ],
                      );
                      setQAnswer(choiceDraft?.answer ?? []);
                    }
                    setQType(t);
                  }}
                >
                  <option value="single">单选题</option>
                  <option value="multiple">多选题</option>
                  <option value="judge">判断题</option>
                </select>
              </div>
              <div className="field">
                <label>答题时长（秒）</label>
                <input
                  className="input"
                  type="number"
                  min={10}
                  max={600}
                  value={qDuration}
                  onChange={(e) => setQDuration(Math.min(600, Math.max(10, Number(e.target.value) || 60)))}
                />
              </div>
            </div>
            <div className="field">
              <label>题干</label>
              <textarea
                className="input textarea"
                rows={2}
                value={qStem}
                maxLength={1000}
                onChange={(e) => setQStem(e.target.value)}
              />
            </div>
            <div className="field">
              <label>选项与正确答案</label>
              <div className="option-editor">
                {qOptions.map((o, i) => (
                  <div className="option-edit-row" key={o.key}>
                    <button
                      className="option-check"
                      data-active={qAnswer.includes(o.key)}
                      onClick={() => {
                        if (qType === 'single' || qType === 'judge') setQAnswer([o.key]);
                        else
                          setQAnswer((prev) =>
                            prev.includes(o.key) ? prev.filter((k) => k !== o.key) : [...prev, o.key],
                          );
                      }}
                    >
                      {o.key}
                    </button>
                    <input
                      className="input"
                      value={o.text}
                      disabled={qType === 'judge'}
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
          </div>
        </Modal>
      )}
    </>
  );
}
