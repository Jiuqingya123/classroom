import type { ScreenSource } from '../../shared/ipc';

interface Props {
  sources: ScreenSource[];
  onPick(id: string): void;
  onClose(): void;
}

export function ScreenPicker({ sources, onPick, onClose }: Props) {
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 className="modal-title">选择共享内容</h2>
          <p className="modal-sub">共享期间对方能看到这个屏幕或窗口的全部内容</p>
        </div>

        <div className="source-grid">
          {sources.map((s) => (
            <button className="source-card" key={s.id} onClick={() => onPick(s.id)}>
              <div className="source-thumb">
                {s.thumbnail ? (
                  <img src={s.thumbnail} alt="" />
                ) : (
                  <span className="source-thumb-empty">{s.isScreen ? '屏幕' : '窗口'}</span>
                )}
              </div>
              <div className="source-name" title={s.name}>
                <span className="source-kind">{s.isScreen ? '屏幕' : '窗口'}</span>
                {s.name}
              </div>
            </button>
          ))}
        </div>

        <div className="modal-foot">
          <button className="btn btn-outline" onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
