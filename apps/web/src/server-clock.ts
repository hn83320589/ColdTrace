import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ClockInfo } from '@coldtrace/shared';
import { api } from './api';

/** 依取得伺服器時間當下的真實時間與倍率，推算現在的伺服器時間 */
export function estimateServerNow(info: ClockInfo, fetchedAt: number, realNow: number): number {
  return info.now + (realNow - fetchedAt) * info.speed;
}

/**
 * 伺服器時間（可能為加速時鐘），每秒更新。
 * 前端不能直接用瀏覽器時間，否則加速展示時「幾分鐘前」會算錯。
 */
export function useServerNow(): { now: number; speed: number } {
  const { data, dataUpdatedAt } = useQuery({
    queryKey: ['clock'],
    queryFn: api.clock,
    staleTime: 60_000,
  });
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const update = () =>
      setNow(data ? estimateServerNow(data, dataUpdatedAt, Date.now()) : Date.now());
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [data, dataUpdatedAt]);

  return { now, speed: data?.speed ?? 1 };
}
