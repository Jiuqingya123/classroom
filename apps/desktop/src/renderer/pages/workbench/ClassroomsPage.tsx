import { useCallback, useEffect, useState } from 'react';
import type { RoomDTO } from '@classroom/shared';
import { RoomReportModal } from '../../components/RoomReportModal';
import { ErrorBar, Loading, PageHead, StatusTag } from '../../components/ui';
import { PlusIcon } from '../../components/Icons';
import { getApi } from '../../lib/api';
import { formatDate, normalizeCode } from '../../lib/format';
import { useNav } from '../../store/nav';
import { useSession } from '../../store/session';

const API = '/api/v1';

export function ClassroomsPage() {
  const user = useSession((s) => s.user);
  const goRoom = useNav((s) => s.goRoom);

  const [rooms, setRooms] = useState<RoomDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [code, setCode] = useState('');
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [reportRoomId, setReportRoomId] = useState<string | null>(null);

  const canCreate = user?.role !== 'student';

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
    <div className="wb-page">
      <PageHead
        title="我的课堂"
        desc="临时课堂用于快速开课；正式排课请使用「课程 → 课节」，学生只能在上课前 15 分钟进入。"
      />
      <ErrorBar message={error} onClose={() => setError(null)} />

      <div className="entry-grid" style={{ marginBottom: 18 }}>
        {canCreate && (
          <div className="card">
            <h2 className="card-title">
              <PlusIcon size={15} /> 创建临时课堂
            </h2>
            <p className="card-desc">创建后生成 6 位入会码，学生在工作台输入即可进入。</p>
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
        )}
        <div className="card">
          <h2 className="card-title">输入入会码</h2>
          <p className="card-desc">正式课节请从「课表」进入；这里用于临时课堂。</p>
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
      </div>

      {loading ? (
        <Loading />
      ) : rooms.length === 0 ? (
        <div className="empty">{canCreate ? '还没有课堂，先创建一个。' : '还没有加入过课堂。'}</div>
      ) : (
        <div className="room-list">
          {rooms.map((r) => (
            <button
              className="room-row"
              key={r.id}
              onClick={() => (r.status === 'ended' ? setReportRoomId(r.id) : goRoom(r.id, null))}
              title={r.status === 'ended' ? '查看课堂记录' : '进入课堂'}
            >
              <div className="room-row-main">
                <div className="room-row-title">
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.title}</span>
                  <StatusTag status={r.status} />
                </div>
                <div className="room-row-meta">
                  <span>{r.hostName} 老师</span>
                  <span>{formatDate(r.createdAt)}</span>
                  {r.courseTitle && <span>{r.courseTitle}</span>}
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
          ))}
        </div>
      )}

      {reportRoomId && <RoomReportModal roomId={reportRoomId} onClose={() => setReportRoomId(null)} />}
    </div>
  );
}
