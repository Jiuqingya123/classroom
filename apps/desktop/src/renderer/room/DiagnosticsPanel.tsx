import type { DiagSnapshot } from '@classroom/shared';

interface Props {
  diag: DiagSnapshot | null;
  selfId: string | null;
  names: Record<string, string>;
  onClose(): void;
}

const CANDIDATE_LABEL: Record<string, { short: string; hint: string; tone: 'good' | 'warn' | 'bad' }> = {
  host: { short: 'host', hint: '同机 / 局域网直连', tone: 'good' },
  srflx: { short: 'srflx', hint: 'NAT 打洞成功，P2P 直连', tone: 'good' },
  prflx: { short: 'prflx', hint: '对端反推的穿透地址', tone: 'good' },
  relay: { short: 'relay', hint: '走 TURN 中继（打洞失败）', tone: 'warn' },
};

function candidateCell(type: string | null) {
  if (!type) return <span className="diag-bad">—</span>;
  const meta = CANDIDATE_LABEL[type] ?? { short: type, hint: type, tone: 'warn' as const };
  return (
    <span className={`diag-${meta.tone}`} title={meta.hint}>
      {meta.short}
    </span>
  );
}

function stateCell(state: string) {
  const ok = state === 'connected';
  const bad = state === 'failed' || state === 'disconnected' || state === 'closed';
  return <span className={ok ? 'diag-good' : bad ? 'diag-bad' : 'diag-warn'}>{state}</span>;
}

/**
 * 诊断面板。
 *
 * 存在的理由：TURN 不通、防火墙拦 UDP、对称 NAT 失败，在用户眼里全都是
 * 「我看得见自己，看不见别人」这一句话，没有任何区别。这里把每条连接选中的
 * candidate 类型摊开，就能一眼分辨是「压根没打洞」还是「TURN 不通」。
 */
export function DiagnosticsPanel({ diag, selfId, names, onClose }: Props) {
  const peers = diag?.peers ?? [];

  return (
    <div className="diag">
      <div className="diag-head">
        <span className="diag-title">连接诊断</span>
        <button className="icon-btn" onClick={onClose} title="关闭">
          ✕
        </button>
      </div>

      <div className="diag-body">
        <div className="diag-row diag-summary">
          <span>
            本地媒体：摄像头 {diag?.local.camera ? '✓' : '✕'} · 麦克风{' '}
            {diag?.local.mic ? '✓' : '✕'} · 共享 {diag?.local.screen ? '✓' : '✕'}
          </span>
        </div>
        <div className="diag-row diag-summary">
          <span>
            ICE 服务器 {diag?.iceServerCount ?? 0} 个 ·{' '}
            {diag?.hasTurn ? (
              <span className="diag-good">已配置 TURN</span>
            ) : (
              <span className="diag-warn">仅 STUN（跨对称 NAT 会连不上）</span>
            )}
          </span>
        </div>

        {peers.length === 0 ? (
          <div className="diag-empty">还没有其他人在课堂里</div>
        ) : (
          <table className="diag-table">
            <thead>
              <tr>
                <th>成员</th>
                <th>状态</th>
                <th>本端→对端</th>
                <th>RTT</th>
                <th>上行</th>
                <th>下行</th>
                <th>画质</th>
              </tr>
            </thead>
            <tbody>
              {peers.map((p) => (
                <tr key={p.userId}>
                  <td title={p.userId}>
                    {names[p.userId] ?? p.userId.slice(0, 8)}
                    {p.userId === selfId ? '（我）' : ''}
                  </td>
                  <td>{stateCell(p.connectionState)}</td>
                  <td>
                    {candidateCell(p.localCandidateType)} → {candidateCell(p.remoteCandidateType)}
                  </td>
                  <td>{p.rttMs === null ? '—' : `${p.rttMs} ms`}</td>
                  <td>{p.outboundKbps === null ? '—' : `${p.outboundKbps} kbps`}</td>
                  <td>{p.inboundKbps === null ? '—' : `${p.inboundKbps} kbps`}</td>
                  <td>1/{p.sendScale}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="diag-hint">
          「relay」表示走了 TURN 中继：能用但延迟更高，通常是双方都在对称 NAT 后面。
          如果对端状态一直是 <code>new</code> 且 candidate 为空，说明信令没通；
          如果 candidate 有值但一直是 <code>connecting</code>，多半是 TURN 端口或证书有问题。
        </div>
      </div>
    </div>
  );
}
