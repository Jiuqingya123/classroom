import { useCallback, useEffect, useState } from 'react';
import type { RoomDTO } from '@classroom/shared';
import { Avatar } from '../components/Avatar';
import { RoomReportModal } from '../components/RoomReportModal';
import { BoardIcon, LogoutIcon, PlusIcon } from '../components/Icons';
import { getApi } from '../lib/api';
import { formatDate, normalizeCode } from '../lib/format';
import { useNav } from '../store/nav';
import { useSession } from '../store/session';

const API = '/api/v1';

const STATUS_LABEL: Record<string, string> = {
  open: '未开始',
  live: '进行中',
  ended: '已结束',
};

export function LobbyPage() {
  const user = useSession((s) => s.user);
  const logout = useSession((s) => s.logout);
  const goRoom = useNav((s) => s.goRoom);

  const [rooms, setRooms] = useState<RoomDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [code, setCode] = useState('');
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [reportRoomId, setReportRoomId] = useState<string | null>(null);

  const isTeacher = user?.role === 'teacher';

  const refresh = useCallback(async () => {
    try {
      const r = await getApi().get<{ rooms: RoomDTO[] }>(`${API}/rooms`);
      setRooms(r.rooms);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createRoom = async () => {
    if (!title.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const r = await getApi().post<{ room: RoomDTO }>(`${API}/rooms`, { title: title.trim() });
      setTitle('');
      goRoom(r.room.id, r.room.joinCode);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const joinByCode = async () => {
    const c = normalizeCode(code);
    if (c.length !== 6 || joining) return;
    setJoining(true);
    setError(null);
    try {
      const r = await getApi().post<{ room: RoomDTO }>(`${API}/rooms/join`, { code: c });
      setCode('');
      goRoom(r.room.id, c);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setJoining(false);
    }
  };

  return (
    <div className="lobby">
      <header className="topbar">
        <div className="brand" style={{ gap: 8 }}>
          <div className="brand-mark" style={{ width: 28, height: 28, borderRadius: 8 }}>
            <BoardIcon size={16} />
          </div>
          <div className="brand-name" style={{ fontSize: 14.5 }}>
            ClassRoom
          </div>
        </div>

        <div className="topbar-spacer" />

        <div className="user-chip">
          <Avatar name={user?.displayName ?? '?'} size={24} />
          <span className="user-chip-name">{user?.displayName}</span>
          {isTeacher && <span className="tag tag-teacher">老师</span>}
        </div>
        <button className="btn btn-ghost" onClick={() => void logout()} title="退出登录">
          <LogoutIcon size={17} />
        </button>
      </header>

      <div className="lobby-body">
        <div className="lobby-inner">
          <div>
            <h1 className="lobby-heading">今天想上哪节课？</h1>
            <p className="lobby-heading-sub">
              {isTeacher ? '创建一个课堂并把入会码发给学生，或者进入你已有的课堂。' : '向老师要一个 6 位入会码，输入后即可进入课堂。'}
            </p>
          </div>

          {error && <div className="alert alert-error">{error}</div>}

          <div className="entry-grid">
            {isTeacher ? (
              <div className="card">
                <h2 className="card-title">
                  <PlusIcon size={15} /> 创建课堂
                </h2>
                <p className="card-desc">创建后会生成 6 位入会码，学生在客户端输入即可进来。</p>
                <div className="card-row">
                  <input
                    className="input"
                    placeholder="课堂名称，例如「初二数学 · 勾股定理」"
                    value={title}
                    maxLength={60}
                    onChange={(e) => setTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void createRoom();
                    }}
                  />
                  <button
                    className="btn btn-primary"
                    onClick={() => void createRoom()}
                    disabled={!title.trim() || creating}
                  >
                    {creating ? <span className="spinner" /> : '创建'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="card">
                <h2 className="card-title">进入课堂</h2>
                <p className="card-desc">输入老师给你的 6 位数字入会码。</p>
                <div className="card-row">
                  <input
                    className="input code-input"
                    inputMode="numeric"
                    placeholder="000000"
                    value={code}
                    maxLength={6}
                    onChange={(e) => setCode(normalizeCode(e.target.value))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void joinByCode();
                    }}
                  />
                  <button
                    className="btn btn-primary"
                    onClick={() => void joinByCode()}
                    disabled={code.length !== 6 || joining}
                  >
                    {joining ? <span className="spinner" /> : '进入'}
                  </button>
                </div>
              </div>
            )}

            <div className="card">
              <h2 className="card-title">我参与过的课堂</h2>
              <p className="card-desc">点任意一条可以直接回到该课堂，不需要再输入入会码。</p>
              <div className="hint-bar">
                最多 5 人在线（1 位老师 + 4 位学生），白板与音视频点对点直连。
              </div>
            </div>
          </div>

          <div>
            <p className="section-title">课堂列表</p>
            <div className="room-list" style={{ marginTop: 10 }}>
              {loading ? (
                <div className="empty">加载中…</div>
              ) : rooms.length === 0 ? (
                <div className="empty">
                  {isTeacher ? '还没有课堂，先在上方创建一个。' : '还没有加入过课堂，输入入会码试试。'}
                </div>
              ) : (
                rooms.map((r) => (
                  <button
                    className="room-row"
                    key={r.id}
                    onClick={() => (r.status === 'ended' ? setReportRoomId(r.id) : goRoom(r.id, null))}
                    title={r.status === 'ended' ? '查看课堂记录' : '进入课堂'}
                  >
                    <div className="room-row-main">
                      <div className="room-row-title">
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.title}</span>
                        <span className={`tag ${r.status === 'live' ? 'tag-live' : r.status === 'ended' ? 'tag-ended' : 'tag-muted'}`}>
                          {STATUS_LABEL[r.status] ?? r.status}
                        </span>
                      </div>
                      <div className="room-row-meta">
                        <span>{r.hostName} 老师</span>
                        <span>{formatDate(r.createdAt)}</span>
                        {r.joinCode !== '******' && (
                          <span>
                            入会码 <span className="room-code">{r.joinCode}</span>
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="room-row-meta">
                      {r.status === 'ended' ? (
                        <span style={{ color: 'var(--brand)' }}>查看记录 →</span>
                      ) : (
                        <span>{r.participantCount} 人在线</span>
                      )}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      {reportRoomId && (
        <RoomReportModal roomId={reportRoomId} onClose={() => setReportRoomId(null)} />
      )}
    </div>
  );
}
