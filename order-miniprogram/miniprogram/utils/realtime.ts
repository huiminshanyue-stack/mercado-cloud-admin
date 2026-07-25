import { request } from './request';

export interface RealtimeState {
  version: number;
  lastTopic: 'orders_v2' | 'shipments' | 'messages' | 'claims' | '';
  lastOrderId: string;
  updatedAt?: string | null;
}

export function createRealtimeWatcher(intervalMs = 10000) {
  let timer: number | null = null;
  let initialized = false;
  let version = 0;
  let polling = false;

  async function poll(onChange: (state: RealtimeState) => void | Promise<void>) {
    if (polling) return;
    polling = true;
    try {
      const state = await request<RealtimeState>({ path:'/api/miniprogram/v1/realtime-state',timeout:10000 });
      const nextVersion = Number(state.version || 0);
      if (!initialized) {
        initialized = true;
        version = nextVersion;
      } else if (nextVersion > version) {
        version = nextVersion;
        await onChange(state);
      }
    } catch (_) {
      // Page-level manual refresh remains available during temporary network errors.
    } finally { polling = false; }
  }

  return {
    start(onChange: (state: RealtimeState) => void | Promise<void>) {
      if (timer !== null) return;
      void poll(onChange);
      timer = setInterval(() => { void poll(onChange); },intervalMs) as unknown as number;
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    }
  };
}
