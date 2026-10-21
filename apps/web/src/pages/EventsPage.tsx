import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { api } from '../api';
import { EventBadge } from '../components/StatusBadge';
import {
  EVENT_TYPE_LABEL,
  eventStatusLabel,
  formatDuration,
  formatTemp,
  formatTime,
} from '../lib/format';

export function EventsPage() {
  const [params, setParams] = useSearchParams();
  const type = params.get('type') ?? '';
  const cabinetId = params.get('cabinetId') ?? '';
  const { data: cabinets } = useQuery({ queryKey: ['cabinets'], queryFn: api.cabinets });
  const { data: events, isLoading } = useQuery({
    queryKey: ['events', { type, cabinetId }],
    queryFn: () => api.events({ type, cabinetId, limit: 300 }),
  });
  const cabinetLabel = new Map(cabinets?.map((c) => [c.id, `${c.branchName}／${c.name}`]));

  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
  };

  return (
    <section className="page">
      <header className="page-head">
        <h1>事件紀錄</h1>
        <div className="filters">
          <label>
            類型
            <select value={type} onChange={(e) => update('type', e.target.value)}>
              <option value="">全部</option>
              <option value="EXCURSION">溫度異常</option>
              <option value="OFFLINE">斷線</option>
            </select>
          </label>
          <label>
            冷藏櫃
            <select value={cabinetId} onChange={(e) => update('cabinetId', e.target.value)}>
              <option value="">全部</option>
              {cabinets?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.branchName}／{c.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      {isLoading && <p className="muted">載入中…</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>類型</th>
              <th>冷藏櫃</th>
              <th>開始</th>
              <th>結束</th>
              <th>持續</th>
              <th>最高 / 最低</th>
              <th>度分鐘</th>
              <th>狀態</th>
              <th>處置</th>
            </tr>
          </thead>
          <tbody>
            {events?.map((e) => (
              <tr key={e.id}>
                <td>
                  <EventBadge type={e.type} label={EVENT_TYPE_LABEL[e.type]} />
                </td>
                <td>{cabinetLabel.get(e.cabinetId) ?? e.cabinetId}</td>
                <td>
                  <Link to={`/events/${e.id}`}>{formatTime(e.startedAt)}</Link>
                </td>
                <td>{formatTime(e.endedAt)}</td>
                <td>{formatDuration(e.durationMs)}</td>
                <td>
                  {e.type === 'EXCURSION'
                    ? `${formatTemp(e.maxTempX10)} / ${formatTemp(e.minTempX10)}`
                    : '—'}
                </td>
                <td className="num">
                  {e.degreeMinutesX10 === null ? '—' : (e.degreeMinutesX10 / 10).toFixed(1)}
                </td>
                <td>
                  {eventStatusLabel(e)}
                  {e.backfilled && <span className="tag">補傳</span>}
                </td>
                <td>{e.latestDisposition ? '已處置' : <span className="pending">待處置</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
