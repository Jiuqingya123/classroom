/** 简单的令牌桶限流。用于 socket 事件：超速直接丢弃，不排队（排队只会累积延迟）。 */
export interface Bucket {
  take(n?: number): boolean;
}

export function createBucket(ratePerSecond: number, burst = ratePerSecond): Bucket {
  let tokens = burst;
  let last = Date.now();

  return {
    take(n = 1) {
      const now = Date.now();
      const elapsed = (now - last) / 1000;
      if (elapsed > 0) {
        tokens = Math.min(burst, tokens + elapsed * ratePerSecond);
        last = now;
      }
      if (tokens < n) return false;
      tokens -= n;
      return true;
    },
  };
}
