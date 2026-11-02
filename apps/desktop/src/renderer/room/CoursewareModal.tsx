import { useCallback, useEffect, useRef, useState } from 'react';
import type { CoursewareDTO } from '@classroom/shared';
import { Modal, fmtSize } from '../components/ui';
import { getApi } from '../lib/api';
import { absoluteFileUrl, cachedFileUrl, ensureFileUrls } from '../lib/files';
import {
  addImagePages,
  importImageCourseware,
  importPdfCourseware,
  probeImageSize,
} from '../lib/import';
import { useRoom, useSelfStaff } from '../store/room';

const API = '/api/v1';

function kindLabel(mime: string): string {
  if (mime.startsWith('image/')) return '图片';
  if (mime === 'application/pdf') return 'PDF';
  return '文件';
}

interface Props {
  onClose(): void;
  onGoBoard(): void;
}

export function CoursewareModal({ onClose, onGoBoard }: Props) {
  const room = useRoom((s) => s.room);
  const wb = useRoom((s) => s.wb);
  const staff = useSelfStaff();

  const [items, setItems] = useState<CoursewareDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!room?.courseId) {
      setLoading(false);
      return;
    }
    try {
      const r = await getApi().get<{ courseware: CoursewareDTO[] }>(
        `${API}/courses/${room.courseId}`,
      );
      setItems(r.courseware);
      await ensureFileUrls(r.courseware.map((c) => c.fileId));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [room?.courseId]);

  useEffect(() => {
    void load();
  }, [load]);

  const resolveUrl = async (cw: CoursewareDTO): Promise<string> => {
    if (cw.url) return absoluteFileUrl(cw.url);
    const hit = cachedFileUrl(cw.fileId);
    if (hit) return hit;
    await ensureFileUrls([cw.fileId]);
    return cachedFileUrl(cw.fileId) ?? '';
  };

  const importing = busyId !== null || progress !== null;

  const insert = async (cw: CoursewareDTO) => {
    if (!wb || importing) return;
    setBusyId(cw.id);
    setError(null);
    try {
      if (cw.mime.startsWith('image/')) {
        const url = await resolveUrl(cw);
        if (!url) throw new Error('课件地址已失效，请重新上传');
        const dim = await probeImageSize(url);
        const added = addImagePages(
          [{ fileId: cw.fileId, name: cw.title.replace(/\.[^.]+$/, ''), width: dim.width, height: dim.height }],
          { client: wb },
        );
        useRoom.setState({ notice: `已插入 ${added} 页图片课件` });
        onGoBoard();
        onClose();
      } else if (cw.mime === 'application/pdf') {
        const url = await resolveUrl(cw);
        if (!url) throw new Error('课件地址已失效，请重新上传');
        const res = await fetch(url);
        if (!res.ok) throw new Error(`下载课件失败（${res.status}）`);
        const blob = await res.blob();
        const file = new File([blob], cw.title, { type: 'application/pdf' });
        const added = await importPdfCourseware(file, {
          client: wb,
          roomId: room?.id,
          onProgress: (p) => setProgress(`${p.phase} ${p.done}/${p.total}`),
        });
        useRoom.setState({ notice: `已导入 ${added} 页 PDF 课件` });
        onGoBoard();
        onClose();
      } else {
        const url = await resolveUrl(cw);
        if (url) window.open(url, '_blank');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
      setProgress(null);
    }
  };

  const uploadLocal = async (file: File) => {
    if (!wb || importing) return;
    setBusyId('local');
    setError(null);
    try {
      if (file.type.startsWith('image/')) {
        const added = await importImageCourseware(file, {
          client: wb,
          roomId: room?.id,
          onProgress: (p) => setProgress(`${p.phase} ${p.done}/${p.total}`),
        });
        useRoom.setState({ notice: `已插入 ${added} 页图片课件` });
      } else if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        const added = await importPdfCourseware(file, {
          client: wb,
          roomId: room?.id,
          onProgress: (p) => setProgress(`${p.phase} ${p.done}/${p.total}`),
        });
        useRoom.setState({ notice: `已导入 ${added} 页 PDF 课件` });
      } else {
        throw new Error('课堂白板仅支持 PDF 或图片');
      }
      onGoBoard();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
      setProgress(null);
    }
  };

  return (
    <Modal title="课件" width={620} onClose={onClose}>
      <div className="cw-modal">
        {!room?.courseId && <div className="form-hint">这是一节临时课堂，未关联课程，暂无课程课件。</div>}

        {staff && wb && (
          <div className="cw-upload">
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,.pdf,image/*"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void uploadLocal(f);
              }}
            />
            <button className="btn" onClick={() => fileRef.current?.click()} disabled={importing}>
              {busyId === 'local' ? '处理中…' : '从本地插入课件'}
            </button>
            <span className="form-hint">PDF 按页渲染，图片各成一页</span>
          </div>
        )}

        {progress && <div className="form-hint">处理中：{progress}</div>}
        {error && <div className="alert alert-error">{error}</div>}

        {loading ? (
          <div className="form-hint">正在加载课件…</div>
        ) : items.length === 0 ? (
          <div className="form-hint">课程还没有上传课件，可在「课程详情 → 课件」中上传。</div>
        ) : (
          <div className="cw-list">
            {items.map((cw) => (
              <div className="cw-row" key={cw.id}>
                <div className="cw-main">
                  <div className="cw-title">{cw.title}</div>
                  <div className="form-hint">
                    {kindLabel(cw.mime)} · {fmtSize(cw.size)}
                  </div>
                </div>
                {staff ? (
                  <button className="mini-btn primary" disabled={!wb || importing} onClick={() => void insert(cw)}>
                    {busyId === cw.id ? '处理中…' : cw.mime === 'application/pdf' ? '导入白板' : '插入白板'}
                  </button>
                ) : (
                  <button
                    className="mini-btn"
                    onClick={() => {
                      void resolveUrl(cw).then((u) => u && window.open(u, '_blank'));
                    }}
                  >
                    打开
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
