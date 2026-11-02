import { create } from 'zustand';
import { getApi } from '../lib/api';

interface NotifyState {
  unread: number;
  refresh(): Promise<void>;
  setUnread(n: number): void;
}

export const useNotify = create<NotifyState>((set) => ({
  unread: 0,
  async refresh() {
    try {
      const r = await getApi().get<{ unread: number }>('/api/v1/notifications/unread_count');
      set({ unread: r.unread });
    } catch {
      /* 网络抖动不影响主界面 */
    }
  },
  setUnread(n) {
    set({ unread: Math.max(0, n) });
  },
}));
