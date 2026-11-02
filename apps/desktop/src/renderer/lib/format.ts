/** 秒级时长的 h:mm:ss / mm:ss */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 人读时长：1 小时 23 分 / 23 分 12 秒 / 8 秒 */
export function formatSpan(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

export function formatDate(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) return `今天 ${formatClock(ts)}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${formatClock(ts)}`;
}

const HUES = [214, 264, 342, 24, 152, 190, 288, 42];

/** 由昵称稳定推出一个头像色，同一个人每次进来颜色一致 */
export function colorForName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 997;
  const hue = HUES[h % HUES.length] as number;
  return `linear-gradient(140deg, hsl(${hue} 72% 60%), hsl(${hue + 18} 68% 48%))`;
}

export function initial(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || '?';
}

/** 6 位入会码的容错解析：允许带空格/短横线 */
export function normalizeCode(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, 6);
}
