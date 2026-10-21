import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  DAY_MS,
  type BranchDashboard,
  type NotificationDto,
  type WsMessage,
} from '@coldtrace/shared';
import type { ReadingsResponse } from './api';
import { mergePoints } from './lib/series';

interface RealtimeState {
  connected: boolean;
  toasts: NotificationDto[];
  dismiss: (id: number) => void;
}

const RealtimeContext = createContext<RealtimeState>({
  connected: false,
  toasts: [],
  dismiss: () => {},
});
export const useRealtime = () => useContext(RealtimeContext);

const TOAST_TTL_MS = 10_000;

/** 把 WebSocket 訊息套用到 React Query 快取，畫面不需重新整理即可更新 */
export function applyMessage(qc: QueryClient, m: WsMessage): void {
  switch (m.type) {
    case 'snapshot':
      qc.setQueryData(['dashboard'], m.branches);
      break;
    case 'cabinet.status':
      qc.setQueryData<BranchDashboard[]>(['dashboard'], (old) =>
        old?.map((b) => ({
          ...b,
          cabinets: b.cabinets.map((c) => (c.cabinetId === m.cabinet.cabinetId ? m.cabinet : c)),
        })),
      );
      break;
    case 'series.appended':
      qc.setQueryData<ReadingsResponse>(['readings', m.cabinetId], (old) => {
        if (!old) return old;
        const latest = Math.max(old.to, ...m.points.map((p) => p[0]));
        return {
          ...old,
          to: latest,
          from: latest - DAY_MS,
          points: mergePoints(old.points, m.points, latest - DAY_MS),
        };
      });
      break;
    case 'series.changed':
      void qc.invalidateQueries({ queryKey: ['readings', m.cabinetId] });
      break;
    case 'event.updated':
      void qc.invalidateQueries({ queryKey: ['events'] });
      void qc.invalidateQueries({ queryKey: ['event', m.event.id] });
      break;
    case 'notification.created':
      void qc.invalidateQueries({ queryKey: ['notifications'] });
      break;
  }
}

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [toasts, setToasts] = useState<NotificationDto[]>([]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry = 0;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${protocol}://${location.host}/ws`);
      socket.onopen = () => {
        retry = 0;
        setConnected(true);
        // 斷線期間可能漏掉訊息，重連後重新抓取
        void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'dashboard' });
      };
      socket.onmessage = (event: MessageEvent<string>) => {
        const message = JSON.parse(event.data) as WsMessage;
        applyMessage(qc, message);
        if (message.type === 'notification.created') {
          const n = message.notification;
          setToasts((list) => [n, ...list].slice(0, 5));
          setTimeout(() => setToasts((list) => list.filter((t) => t.id !== n.id)), TOAST_TTL_MS);
        }
      };
      socket.onclose = () => {
        setConnected(false);
        if (!stopped) timer = setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++));
      };
    };
    connect();

    return () => {
      stopped = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, [qc]);

  const dismiss = (id: number) => setToasts((list) => list.filter((t) => t.id !== id));
  return (
    <RealtimeContext.Provider value={{ connected, toasts, dismiss }}>
      {children}
    </RealtimeContext.Provider>
  );
}
