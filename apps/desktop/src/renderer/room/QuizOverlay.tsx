import { useEffect, useState } from 'react';
import { useRoom, useSelfStaff } from '../store/room';

const TYPE_LABEL = {
  single: '单选题',
  multiple: '多选题',
  judge: '判断题',
} as const;

export function QuizOverlay() {
  const quiz = useRoom((s) => s.quiz);
  const quizResult = useRoom((s) => s.quizResult);
  const myAnswer = useRoom((s) => s.myQuizAnswer);
  const answerQuiz = useRoom((s) => s.answerQuiz);
  const endQuiz = useRoom((s) => s.endQuiz);
  const dismissQuiz = useRoom((s) => s.dismissQuiz);
  const staff = useSelfStaff();

  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    setSelected([]);
  }, [quiz?.quizId]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  if (!quiz && !quizResult) return null;

  const state = quizResult ?? quiz;
  if (!state) return null;

  const active = !!quiz;
  const chosen = quizResult ? (myAnswer ?? []) : selected;
  const left = quiz ? Math.max(0, quiz.endsAt - now) : 0;
  // 服务端到点后拒绝作答，但不会自动广播结果；不给关闭入口会把整间教室锁在遮罩里
  const expired = !!quiz && now > quiz.endsAt + 1500;
  const answeredPct = state.totalStudents
    ? Math.round((state.answeredCount / state.totalStudents) * 100)
    : 0;

  const pick = (key: string) => {
    if (!active || expired || staff || myAnswer) return;
    if (state.type === 'multiple') {
      setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
    } else {
      setSelected([key]);
    }
  };

  const submit = async () => {
    if (selected.length === 0 || busy || expired) return;
    setBusy(true);
    await answerQuiz(selected);
    setBusy(false);
  };

  return (
    <div className="quiz-overlay">
      <div className="quiz-card">
        <div className="quiz-head">
          <span className="quiz-type">{TYPE_LABEL[state.type]}</span>
          <span className="quiz-stem">{state.stem}</span>
          {active && <span className="quiz-clock">{Math.ceil(left / 1000)}s</span>}
        </div>

        <div className="quiz-options">
          {state.options.map((opt) => {
            const isChosen = chosen.includes(opt.key);
            const correct = quizResult ? quizResult.correctAnswer.includes(opt.key) : null;
            const count = state.counts.find((c) => c.key === opt.key)?.count ?? 0;
            const pct = state.answeredCount ? Math.round((count / state.answeredCount) * 100) : 0;
            return (
              <button
                key={opt.key}
                className="quiz-option"
                data-chosen={isChosen}
                data-correct={correct === null ? undefined : correct}
                disabled={!active || expired || staff || !!myAnswer}
                onClick={() => pick(opt.key)}
              >
                <span className="quiz-option-key">{opt.key}</span>
                <span className="quiz-option-text">{opt.text}</span>
                {quizResult && (
                  <span className="quiz-option-stat">
                    {count} 人 · {pct}%
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="quiz-meta">
          <span>
            {state.answeredCount}/{state.totalStudents} 人已作答（{answeredPct}%）
          </span>
          {active && <span>{state.byName} 发起</span>}
          {quizResult && <span>正确答案：{quizResult.correctAnswer.join('、') || '—'}</span>}
        </div>

        {quizResult?.analysis && <div className="quiz-analysis">{quizResult.analysis}</div>}

        {quizResult?.answers && staff && (
          <div className="quiz-answers">
            <div className="quiz-answers-title">逐人作答</div>
            <div className="quiz-answers-list">
              {quizResult.answers.map((a) => (
                <span key={a.userId} className="quiz-answer-chip" data-correct={a.correct}>
                  {a.displayName}：{a.answer.join('、') || '未答'}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="quiz-actions">
          {active && !expired && !staff && !myAnswer && (
            <button className="btn btn-primary" disabled={selected.length === 0 || busy} onClick={() => void submit()}>
              提交答案
            </button>
          )}
          {active && !expired && !staff && myAnswer && <span className="quiz-hint">已提交，等待老师结束答题</span>}
          {active && expired && <span className="quiz-hint">答题已截止</span>}
          {active && staff && (
            <button className="btn btn-primary" onClick={() => void endQuiz()}>
              结束答题并公布答案
            </button>
          )}
          {(quizResult || expired) && (
            <button className="btn" onClick={dismissQuiz}>
              关闭
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
