/**
 * 手写笔输入诊断。
 *
 * 为什么要有：数位板的问题（压感没值、笔迹乱飞、一笔被切成几段）几乎都跟驱动上报方式有关，
 * 而这些行为在别的机器上复现不出来。与其靠猜，不如在真机上把这几个字段摆出来：
 *
 *   Ctrl + Shift + D   打开/关闭诊断面板
 *
 * 面板显示每个指针事件的 pointerType / pointerId / buttons / pressure，以及被规则丢弃的次数。
 * 用户截个图就能定位是哪条规则在误伤，或者驱动根本没给 pressure。
 */

export interface PenSample {
  /** 相对打开面板的时间，ms */
  t: number;
  phase: 'down' | 'move' | 'up';
  kind: string;
  id: number;
  button: number;
  buttons: number;
  pressure: number;
  x: number;
  y: number;
  /** 被某条规则丢弃时说明原因；正常接收的事件没有这个字段 */
  note?: string;
}

/** 被丢弃的原因计数，用来判断是哪条规则在起作用 */
export const DROP_LABELS: Record<string, string> = {
  mouseDuringPen: '笔活动期间的鼠标模拟',
  otherPointer: '非当前指针',
  touchPalm: '掌托触摸',
  notPrimary: '非主指针',
  busy: '已有指针在画',
  nonLeftButton: '非左键（侧键/右键）',
  hover: '悬停未按下',
};

const counters: Record<string, number> = {};
let enabled = false;
const sampleSubs = new Set<(s: PenSample) => void>();
const toggleSubs = new Set<(on: boolean) => void>();

export const penDebug = {
  get enabled(): boolean {
    return enabled;
  },

  toggle(): boolean {
    enabled = !enabled;
    for (const fn of toggleSubs) fn(enabled);
    return enabled;
  },

  onToggle(fn: (on: boolean) => void): () => void {
    toggleSubs.add(fn);
    return () => toggleSubs.delete(fn);
  },

  onSample(fn: (s: PenSample) => void): () => void {
    sampleSubs.add(fn);
    return () => sampleSubs.delete(fn);
  },

  push(s: PenSample): void {
    if (!enabled) return;
    for (const fn of sampleSubs) fn(s);
  },

  /** 记一次「因为某条规则被丢弃」，只在诊断面板打开时累计，零开销 */
  drop(rule: keyof typeof DROP_LABELS | string): void {
    if (!enabled) return;
    counters[rule] = (counters[rule] ?? 0) + 1;
  },

  counters(): Record<string, number> {
    return { ...counters };
  },

  resetCounters(): void {
    for (const k of Object.keys(counters)) delete counters[k];
  },
};
