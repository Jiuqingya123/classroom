import { useState } from 'react';
import type { UserDTO } from '@classroom/shared';
import { ROLE_LABEL } from '@classroom/shared';
import { Avatar } from '../../components/Avatar';
import { ErrorBar, PageHead, fmtDateTime } from '../../components/ui';
import { getApi } from '../../lib/api';
import { useSession } from '../../store/session';

const API = '/api/v1';

export function ProfilePage() {
  const user = useSession((s) => s.user);
  const setUser = useSession((s) => s.setUser);
  const logout = useSession((s) => s.logout);

  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [bio, setBio] = useState(user?.bio ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [pwdBusy, setPwdBusy] = useState(false);
  const [pwdMsg, setPwdMsg] = useState<string | null>(null);
  const [pwdError, setPwdError] = useState<string | null>(null);

  if (!user) return null;

  const save = async () => {
    if (!displayName.trim()) {
      setError('昵称不能为空');
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const r = await getApi().patch<{ user: UserDTO }>(`${API}/auth/me`, {
        displayName: displayName.trim(),
        phone: phone.trim(),
        bio: bio.trim(),
      });
      setUser(r.user);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const changePassword = async () => {
    setPwdMsg(null);
    setPwdError(null);
    if (newPwd.length < 8) {
      setPwdError('新密码至少 8 位');
      return;
    }
    if (newPwd !== confirmPwd) {
      setPwdError('两次输入的新密码不一致');
      return;
    }
    setPwdBusy(true);
    try {
      await getApi().post(`${API}/auth/password`, { oldPassword: oldPwd, newPassword: newPwd });
      setOldPwd('');
      setNewPwd('');
      setConfirmPwd('');
      setPwdMsg('密码已修改，下次登录请使用新密码');
    } catch (e) {
      setPwdError((e as Error).message);
    } finally {
      setPwdBusy(false);
    }
  };

  return (
    <div className="wb-page">
      <PageHead title="个人中心" desc="账号资料与安全设置" />
      <ErrorBar message={error} onClose={() => setError(null)} />

      <div className="profile-grid">
        <section className="panel profile-card">
          <div className="profile-head">
            <Avatar name={user.displayName} size={64} />
            <div>
              <h2>{user.displayName}</h2>
              <div className="profile-meta">
                <span className="tag tag-teacher">{ROLE_LABEL[user.role]}</span>
                <span>{user.email}</span>
              </div>
              <div className="profile-meta">加入于 {fmtDateTime(user.createdAt)}</div>
            </div>
          </div>

          <div className="form-grid">
            <div className="field">
              <label>昵称</label>
              <input
                className="input"
                value={displayName}
                maxLength={24}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
            <div className="field">
              <label>手机号（可用于登录）</label>
              <input
                className="input"
                value={phone}
                maxLength={24}
                placeholder="例如 13800138000"
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
            <div className="field">
              <label>个人简介</label>
              <textarea
                className="input textarea"
                rows={3}
                value={bio}
                maxLength={200}
                onChange={(e) => setBio(e.target.value)}
              />
            </div>
          </div>
          <div className="filter-row" style={{ marginTop: 8 }}>
            <button className="btn btn-primary" disabled={saving} onClick={() => void save()}>
              {saving ? <span className="spinner" /> : '保存资料'}
            </button>
            {saved && <span className="ok-text">已保存</span>}
          </div>
        </section>

        <section className="panel profile-card">
          <h2>修改密码</h2>
          {pwdError && <ErrorBar message={pwdError} onClose={() => setPwdError(null)} />}
          {pwdMsg && <div className="ok-banner">{pwdMsg}</div>}
          <div className="form-grid">
            <div className="field">
              <label>当前密码</label>
              <input
                className="input"
                type="password"
                value={oldPwd}
                onChange={(e) => setOldPwd(e.target.value)}
              />
            </div>
            <div className="field">
              <label>新密码（至少 8 位）</label>
              <input
                className="input"
                type="password"
                value={newPwd}
                onChange={(e) => setNewPwd(e.target.value)}
              />
            </div>
            <div className="field">
              <label>确认新密码</label>
              <input
                className="input"
                type="password"
                value={confirmPwd}
                onChange={(e) => setConfirmPwd(e.target.value)}
              />
            </div>
          </div>
          <div className="filter-row" style={{ marginTop: 8 }}>
            <button
              className="btn btn-outline"
              disabled={pwdBusy || !oldPwd || !newPwd}
              onClick={() => void changePassword()}
            >
              {pwdBusy ? <span className="spinner" /> : '修改密码'}
            </button>
          </div>

          <div className="profile-logout">
            <div>
              <div className="profile-meta">退出后需要重新输入账号密码，课堂中的设备采集也会停止。</div>
            </div>
            <button className="btn btn-ghost danger" onClick={() => void logout()}>
              退出登录
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
