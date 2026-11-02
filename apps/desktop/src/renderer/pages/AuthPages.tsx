import { useState } from 'react';
import { resetApi } from '../lib/api';
import { runtime, saveServerUrl } from '../lib/config';
import { useSession } from '../store/session';
import { BoardIcon, ShieldIcon, VideoIcon } from '../components/Icons';

function ServerSettings() {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(runtime.serverUrl);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const apply = (): void => {
    try {
      const url = saveServerUrl(value);
      resetApi();
      useSession.getState().clearError();
      setValue(url);
      setError(null);
      setSaved(true);
    } catch (e) {
      setSaved(false);
      setError((e as Error).message);
    }
  };

  return (
    <div className="server-settings">
      <button type="button" className="server-settings-toggle" onClick={() => setOpen((v) => !v)}>
        <span className="server-dot" data-on={open} />
        <span className="server-label">服务器</span>
        <span className="server-current">{runtime.serverUrl}</span>
        <span className="server-edit">{open ? '收起' : '修改'}</span>
      </button>

      {open && (
        <div className="server-settings-body">
          <div className="field">
            <label htmlFor="server-url">服务器地址</label>
            <input
              id="server-url"
              className="input"
              type="url"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setSaved(false);
              }}
              placeholder="http://192.168.1.5:8080"
            />
          </div>
          <div className="form-hint">
            Android 模拟器用 http://10.0.2.2:8080；真机用电脑的局域网 IP（如 http://192.168.1.5:8080），手机和电脑需在同一网络。
          </div>
          {error && <div className="alert alert-error">{error}</div>}
          <div className="server-actions">
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() => {
                setValue(runtime.serverUrl);
                setError(null);
                setSaved(false);
              }}
            >
              重置
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={apply}>
              保存地址
            </button>
            {saved && <span className="server-saved">已保存</span>}
          </div>
        </div>
      )}
    </div>
  );
}

export function LoginPage({ onSwitch }: { onSwitch: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const login = useSession((s) => s.login);
  const busy = useSession((s) => s.busy);
  const error = useSession((s) => s.error);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    await login(email.trim(), password);
  };

  return (
    <form className="auth-form" onSubmit={submit}>
      <div>
        <h1 className="auth-title">登录课堂</h1>
        <p className="auth-sub">用你的账号进入在线教室</p>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="field">
        <label htmlFor="email">邮箱</label>
        <input
          id="email"
          className="input"
          type="email"
          autoComplete="username"
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />
      </div>

      <div className="field">
        <label htmlFor="password">密码</label>
        <input
          id="password"
          className="input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="至少 8 位"
        />
      </div>

      <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy || !email || !password}>
        {busy ? <span className="spinner" /> : null}
        {busy ? '登录中…' : '登录'}
      </button>

      <div className="auth-switch">
        还没有账号？
        <button type="button" onClick={onSwitch}>
          立即注册
        </button>
      </div>
    </form>
  );
}

export function RegisterPage({ onSwitch }: { onSwitch: () => void }) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'teacher' | 'student'>('teacher');
  const register = useSession((s) => s.register);
  const busy = useSession((s) => s.busy);
  const error = useSession((s) => s.error);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    await register({ email: email.trim(), password, displayName: displayName.trim(), role });
  };

  return (
    <form className="auth-form" onSubmit={submit}>
      <div>
        <h1 className="auth-title">创建账号</h1>
        <p className="auth-sub">选择你的身份，之后可以随时建课或进课</p>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="field">
        <label>我是</label>
        <div className="role-picker">
          <button
            type="button"
            className="role-option"
            data-active={role === 'teacher'}
            onClick={() => setRole('teacher')}
          >
            <div className="role-option-title">老师</div>
            <div className="role-option-desc">创建课堂、获得 6 位入会码</div>
          </button>
          <button
            type="button"
            className="role-option"
            data-active={role === 'student'}
            onClick={() => setRole('student')}
          >
            <div className="role-option-title">学生</div>
            <div className="role-option-desc">凭入会码进入课堂</div>
          </button>
        </div>
      </div>

      <div className="field">
        <label htmlFor="name">昵称</label>
        <input
          id="name"
          className="input"
          value={displayName}
          maxLength={24}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="课堂上显示的名字"
        />
      </div>

      <div className="field">
        <label htmlFor="remail">邮箱</label>
        <input
          id="remail"
          className="input"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />
      </div>

      <div className="field">
        <label htmlFor="rpassword">密码</label>
        <input
          id="rpassword"
          className="input"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="至少 8 位"
        />
      </div>

      <button
        className="btn btn-primary btn-lg btn-block"
        type="submit"
        disabled={busy || !email || !password || !displayName}
      >
        {busy ? <span className="spinner" /> : null}
        {busy ? '创建中…' : '创建并登录'}
      </button>

      <div className="auth-switch">
        已经有账号？
        <button type="button" onClick={onSwitch}>
          返回登录
        </button>
      </div>
    </form>
  );
}

export function AuthScreen() {
  const [mode, setMode] = useState<'login' | 'register'>('login');

  return (
    <div className="auth">
      <div className="auth-hero">
        <div className="brand">
          <div className="brand-mark">
            <BoardIcon size={18} />
          </div>
          <div>
            <div className="brand-name">ClassRoom</div>
            <div className="brand-sub">在线互动教室</div>
          </div>
        </div>

        <div className="auth-hero-content">
          <h2 className="auth-hero-title">
            把一间教室
            <br />
            装进你的桌面
          </h2>
          <p className="auth-hero-desc">
            多人协同白板、低延迟音视频、屏幕共享与课堂互动。1 位老师 + 4 位学生，跨网络真上课。
          </p>
        </div>

        <div className="auth-features">
          <div className="auth-feature">
            <span className="auth-feature-dot">
              <VideoIcon size={13} />
            </span>
            端到端 WebRTC，点对点直连
          </div>
          <div className="auth-feature">
            <span className="auth-feature-dot">
              <BoardIcon size={13} />
            </span>
            白板实时协同，断线自动重同步
          </div>
          <div className="auth-feature">
            <span className="auth-feature-dot">
              <ShieldIcon size={13} />
            </span>
            账号独立鉴权，课堂记录落库
          </div>
        </div>
      </div>

      <div className="auth-panel">
        <div className="auth-mobile-brand">
          <div className="brand-mark">
            <BoardIcon size={18} />
          </div>
          <div>
            <div className="brand-name">ClassRoom</div>
            <div className="brand-sub">在线互动教室</div>
          </div>
        </div>

        <div className="auth-card">
          {mode === 'login' ? (
            <LoginPage onSwitch={() => setMode('register')} />
          ) : (
            <RegisterPage onSwitch={() => setMode('login')} />
          )}

          {!runtime.isElectron && <ServerSettings />}
        </div>
      </div>
    </div>
  );
}
