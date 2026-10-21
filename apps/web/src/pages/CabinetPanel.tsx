import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { DAY_MS } from '@coldtrace/shared';
import { api } from '../api';
import { EventBadge } from '../components/StatusBadge';
import { TemperatureChart } from '../components/LazyTemperatureChart';
import { EVENT_TYPE_LABEL, eventStatusLabel, formatDuration, formatTime } from '../lib/format';
import { useServerNow } from '../server-clock';

export function CabinetPanel({ cabinetId, onClose }: { cabinetId: string; onClose: () => void }) {
  const { data: readings, isLoading } = useQuery({
    queryKey: ['readings', cabinetId],
    queryFn: () => api.readings(cabinetId),
    staleTime: Infinity, // 由 WebSocket 推播負責更新
  });
  const { now } = useServerNow();
  const { data: events } = useQuery({
    queryKey: ['events', { cabinetId, recent: true }],
    queryFn: () => api.events({ cabinetId, from: now - 7 * DAY_MS, limit: 20 }),
  });
  const [renderMs, setRenderMs] = useState<number | null>(null);
  const onRendered = useCallback((ms: number) => setRenderMs(ms), []);

  const cabinetName = useQuery({ queryKey: ['dashboard'], queryFn: api.dashboard })
    .data?.flatMap((b) => b.cabinets.map((c) => ({ ...c, branchName: b.branchName })))
    .find((c) => c.cabinetId === cabinetId);

  return (
    <section className="panel" aria-label="冷藏櫃詳情">
      <header className="panel-head">
        <div>
          <h2>
            {cabinetName ? `${cabinetName.branchName}／${cabinetName.cabinetName}` : cabinetId}
          </h2>
          <p className="muted">
            近 24 小時溫度（{readings?.points.length ?? 0} 筆）
            {renderMs !== null && (
              <span className="render-ms"> · 繪製 {renderMs.toFixed(0)} ms</span>
            )}
          </p>
        </div>
        <button type="button" className="ghost" onClick={onClose} aria-label="關閉">
          ✕
        </button>
      </header>

      {isLoading || !readings ? (
        <div className="chart chart-loading">載入中…</div>
      ) : (
        <TemperatureChart
          points={readings.points}
          from={readings.to - DAY_MS}
          to={readings.to}
          onRendered={onRendered}
        />
      )}
      <p className="legend">
        <span className="legend-band" /> 2–8°C 合規範圍
        <span className="legend-sep">線條中斷處為斷線且尚未補傳的時段</span>
      </p>

      <h3>近 7 天事件</h3>
      {events?.length === 0 && <p className="muted">無事件</p>}
      <ul className="event-list">
        {events?.map((e) => (
          <li key={e.id}>
            <EventBadge type={e.type} label={EVENT_TYPE_LABEL[e.type]} />
            <Link to={`/events/${e.id}`}>
              {formatTime(e.startedAt)} 起 · {formatDuration(e.durationMs)} · {eventStatusLabel(e)}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
