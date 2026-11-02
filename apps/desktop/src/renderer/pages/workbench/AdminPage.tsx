import { useCallback, useEffect, useState } from 'react';
import type { AdminOverviewDTO, AdminUserDTO, Role } from '@classroom/shared';
import { ROLE_LABEL } from '@classroom/shared';
import { ErrorBar, Loading, PageHead, fmtDateTime } from '../../components/ui';
import { getApi } from '../../lib/api';
import { useNav } from '../../store/nav';
import { useSession } from '../../store/session';

const API = '/api/v1';
const PAGE_SIZE = 20;
const ROLES: Role[] = ['admin', 'teacher', 'assistant', 'student'];

export function AdminPage() {
  const me = useSession((s) => s.user);
  const goCourse = useNav((s) => s.goCourse);

  const [overview, setOverview] = useState<AdminOverviewDTO | null>(null);
  const [users, setUsers] = useState<AdminUserDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [role, setRole] = useState<Role | ''>('');
  const [loading, setLoading] = useState(true);
  const [usersLoading, setUsersLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    try {
      setOverview(await getApi().get<AdminOverviewDTO>(`${API}/admin/overview`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    try {
      const qs = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (search) qs.set('search', search);
      if (role) qs.set('role', role);
      const r = await getApi().get<{ users: AdminUserDTO[]; total: number }>(
        `${API}/admin/users?${qs}`,
      );
      setUsers(r.users);
      setTotal(r.total);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUsersLoading(false);
    }
  }, [offset, search, role]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const changeRole = async (u: AdminUserDTO, next: Role) => {
    if (next === u.role) return;
    if (!window.confirm(`将 ${u.displayName} 的角色改为「${ROLE_LABEL[next]}」？`)) return;
    setBusyId(u.id);
    setError(null);
    try {
      await getApi().patch(`${API}/admin/users/${u.id}/role`, { role: next });
      setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, role: next } : x)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const stats = overview?.stats;

  return (
    <div className="wb-page">
      <PageHead title="管理后台" desc="机构账号、角色与课程数据总览" />
      <ErrorBar message={error} onClose={() => setError(null)} />

      {loading ? (
        <Loading />
      ) : (
        <>
          <div className="admin-stats">
            {[
              ['总用户', stats?.users ?? 0],
              ['老师', stats?.teachers ?? 0],
              ['助教', stats?.assistants ?? 0],
              ['学生', stats?.students ?? 0],
              ['课程', stats?.courses ?? 0],
              ['课节', stats?.lessons ?? 0],
              ['直播中', stats?.liveRooms ?? 0],
              ['作业', stats?.assignments ?? 0],
            ].map(([label, value]) => (
              <div className="admin-stat" key={String(label)}>
                <div className="stat-num">{value}</div>
                <div className="stat-label">{label}</div>
              </div>
            ))}
          </div>

          <section className="panel" style={{ marginTop: 18 }}>
            <div className="panel-head">
              <h2>账号管理</h2>
              <div className="filter-row">
                <input
                  className="input"
                  style={{ width: 220 }}
                  placeholder="搜索昵称或邮箱"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      setOffset(0);
                      setSearch(searchInput.trim());
                    }
                  }}
                />
                <select
                  className="input"
                  style={{ width: 120 }}
                  value={role}
                  onChange={(e) => {
                    setRole(e.target.value as Role | '');
                    setOffset(0);
                  }}
                >
                  <option value="">全部角色</option>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
                <button
                  className="btn btn-outline btn-sm"
                  onClick={() => {
                    setOffset(0);
                    setSearch(searchInput.trim());
                  }}
                >
                  搜索
                </button>
              </div>
            </div>

            {usersLoading ? (
              <Loading />
            ) : (
              <div className="admin-table">
                <div className="admin-row admin-row-head">
                  <span>用户</span>
                  <span>邮箱</span>
                  <span>课程</span>
                  <span>注册时间</span>
                  <span>角色</span>
                </div>
                {users.map((u) => (
                  <div className="admin-row" key={u.id}>
                    <span className="admin-name">
                      {u.displayName}
                      {u.id === me?.id ? '（我）' : ''}
                    </span>
                    <span className="admin-mail">{u.email}</span>
                    <span>{u.courseCount}</span>
                    <span className="admin-mail">{fmtDateTime(u.createdAt)}</span>
                    <span>
                      <select
                        className="input input-sm"
                        value={u.role}
                        disabled={busyId === u.id}
                        onChange={(e) => void changeRole(u, e.target.value as Role)}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABEL[r]}
                          </option>
                        ))}
                      </select>
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="pager">
              <span className="assign-meta">
                共 {total} 人 · 当前第 {Math.floor(offset / PAGE_SIZE) + 1} 页
              </span>
              <button
                className="btn btn-ghost btn-sm"
                disabled={offset === 0}
                onClick={() => setOffset((v) => Math.max(0, v - PAGE_SIZE))}
              >
                上一页
              </button>
              <button
                className="btn btn-ghost btn-sm"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset((v) => v + PAGE_SIZE)}
              >
                下一页
              </button>
            </div>
          </section>

          <section className="panel" style={{ marginTop: 18 }}>
            <div className="panel-head">
              <h2>最近课程</h2>
            </div>
            {overview?.recentCourses.length === 0 ? (
              <div className="empty">暂无课程</div>
            ) : (
              <div className="course-grid">
                {overview?.recentCourses.map((c) => (
                  <button key={c.id} className="course-card" onClick={() => goCourse(c.id)}>
                    <div className="course-cover" style={{ background: c.cover || undefined }}>
                      {c.title.slice(0, 1)}
                    </div>
                    <div className="course-info">
                      <div className="course-title">{c.title}</div>
                      <div className="course-meta">
                        {c.teacherName} · {c.memberCount} 人 · {c.lessonCount} 节课
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
