/** 单条 RTCStats 的松散形态 —— 规范字段随浏览器版本变动，用宽松类型读更稳 */
type LooseStat = Record<string, unknown> & { id?: string; type?: string };

export interface StatsSample {
  ts: number;
  outBytes: number;
  inBytes: number;
}

export interface PeerStatsResult {
  localCandidateType: string | null;
  remoteCandidateType: string | null;
  rttMs: number | null;
  outboundKbps: number | null;
  inboundKbps: number | null;
  availableOutgoingBitrate: number | null;
  sample: StatsSample;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * 读一次 PeerConnection 的 stats。
 *
 * 这里唯一「有诊断价值」的字段是 selected candidate pair 的 local/remote candidateType：
 * 它是区分「P2P 打洞成功」与「被 TURN 中继」的唯一直接证据。
 * 传 prev 是为了算码率 —— getStats 给的是累计字节数，必须两次采样差分。
 */
export async function readPeerStats(
  pc: RTCPeerConnection,
  prev?: StatsSample,
): Promise<PeerStatsResult> {
  let report: RTCStatsReport;
  try {
    report = await pc.getStats();
  } catch {
    return {
      localCandidateType: null,
      remoteCandidateType: null,
      rttMs: null,
      outboundKbps: null,
      inboundKbps: null,
      availableOutgoingBitrate: null,
      sample: prev ?? { ts: Date.now(), outBytes: 0, inBytes: 0 },
    };
  }

  const byId = new Map<string, LooseStat>();
  let outBytes = 0;
  let inBytes = 0;
  let transportPairId: string | null = null;
  let fallbackPair: LooseStat | null = null;

  report.forEach((raw) => {
    const s = raw as unknown as LooseStat;
    if (s.id) byId.set(s.id, s);

    if (s.type === 'transport' && typeof s.selectedCandidatePairId === 'string') {
      transportPairId = s.selectedCandidatePairId;
    }
    if (s.type === 'candidate-pair') {
      if ((s.nominated === true || s.selected === true) && s.state === 'succeeded') {
        fallbackPair = s;
      }
    }
    if (s.type === 'outbound-rtp') {
      const v = num(s.bytesSent);
      if (v !== null) outBytes += v;
    }
    if (s.type === 'inbound-rtp') {
      const v = num(s.bytesReceived);
      if (v !== null) inBytes += v;
    }
  });

  const pair = (transportPairId ? (byId.get(transportPairId) ?? null) : null) ?? fallbackPair;

  const localType = pair && typeof pair.localCandidateId === 'string'
    ? str(byId.get(pair.localCandidateId)?.candidateType)
    : null;
  const remoteType = pair && typeof pair.remoteCandidateId === 'string'
    ? str(byId.get(pair.remoteCandidateId)?.candidateType)
    : null;

  const rttRaw = pair ? num(pair.currentRoundTripTime) : null;

  const sample: StatsSample = { ts: Date.now(), outBytes, inBytes };
  let outboundKbps: number | null = null;
  let inboundKbps: number | null = null;
  // 采样间隔太短时差分会得到 0 或噪声值，宁可显示「—」也不要给假数字
  const MIN_DELTA_MS = 1500;
  if (prev && sample.ts - prev.ts >= MIN_DELTA_MS) {
    const dt = (sample.ts - prev.ts) / 1000;
    outboundKbps = Math.round(((outBytes - prev.outBytes) * 8) / 1000 / dt);
    inboundKbps = Math.round(((inBytes - prev.inBytes) * 8) / 1000 / dt);
  }

  return {
    localCandidateType: localType,
    remoteCandidateType: remoteType,
    rttMs: rttRaw === null ? null : Math.round(rttRaw * 1000),
    outboundKbps,
    inboundKbps,
    availableOutgoingBitrate: pair ? num(pair.availableOutgoingBitrate) : null,
    sample,
  };
}
