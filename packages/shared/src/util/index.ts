/** 通用小工具：UUID / 节流 / 防抖 / 断言。零依赖，双端可用。 */

export function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // 兜底（极老环境）：时间戳 + 随机
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function nowMs(): number {
  return Date.now();
}

/** 尾部节流：高频调用时最多每 ms 执行一次，且保证最后一次一定执行。 */
export function throttle<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): ((...args: A) => void) & { flush: () => void; cancel: () => void } {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;

  const run = (args: A) => {
    last = Date.now();
    pending = null;
    fn(...args);
  };

  const wrapped = (...args: A) => {
    pending = args;
    const delta = Date.now() - last;
    if (delta >= ms) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      run(args);
      return;
    }
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (pending) run(pending);
    }, ms - delta);
  };

  wrapped.flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending) run(pending);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
  };
  return wrapped;
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): ((...args: A) => void) & { flush: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;

  const wrapped = (...args: A) => {
    pending = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const p = pending;
      pending = null;
      if (p) fn(...p);
    }, ms);
  };
  wrapped.flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const p = pending;
    pending = null;
    if (p) fn(...p);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
  };
  return wrapped;
}

export function assertNever(x: never): never {
  throw new Error(`unexpected value: ${String(x)}`);
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** 把浮点坐标压到 2 位小数，减少白板消息体积并让双端渲染完全一致。 */
export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
