import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import type { CabinetSnapshot, CabinetStatus } from '@coldtrace/shared';
import { api } from '../api';
import { StatusBadge } from '../components/StatusBadge';
import { formatAgo, formatTemp, formatTime } from '../lib/format';
import { useServerNow } from '../server-clock';
import { CabinetPanel } from './CabinetPanel';

export function DashboardPage() {
  const { data: branches, error } = useQuery({ queryKey: ['dashboard'], queryFn: api.dashboard });
  const { data: notifications } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.notifications(12),
  });
  const [params, setParams] = useSearchParams();
  const selected = params.get('cabinet');
  const { now } = useServerNow();

  if (error) return <p className="error">載入失敗：{error.message}</p>;
  if (!branches) return <p className="muted">載入中…</p>;

  const all = branches.flatMap((b) => b.cabinets);
  const count = (s: CabinetStatus) => all.filter((c) => c.status === s).length;
  const select = (id: string | null) => setParams(id ? { cabinet: id } : {});

  return (
    <div className={`dashboard ${selected ? 'with-panel' : ''}`}>
      <section className="summary" aria-label="狀態統計">
        <div className="stat stat-normal">
          <span>正常</span>
          <strong>{count('NORMAL')}</strong>
        </div>
        <div className="stat stat-alert">
          <span>異常</span>
          <strong>{count('ALERT')}</strong>
        </div>
        <div className="stat stat-offline">
          <span>斷線</span>
          <strong>{count('OFFLINE')}</strong>
        </div>
        <div className="stat">
          <span>冷藏櫃總數</span>
          <strong>{all.length}</strong>
        </div>
      </section>

      <section className="branches">
        {branches.map((branch) => (
          <article key={branch.branchId} className="branch">
            <h2>{branch.branchName}</h2>
            <div className="cabinets">
              {branch.cabinets.map((c) => (
                <CabinetTile
                  key={c.cabinetId}
                  cabinet={c}
                  now={now}
                  active={c.cabinetId === selected}
                  onSelect={() => select(c.cabinetId === selected ? null : c.cabinetId)}
                />
              ))}
            </div>
          </article>
        ))}
      </section>

      {selected && <CabinetPanel cabinetId={selected} onClose={() => select(null)} />}

      <aside className="feed">
        <h2>最新通知</h2>
        {notifications?.length === 0 && <p className="muted">尚無通知</p>}
        <ul>
          {notifications?.map((n) => (
            <li key={n.id} className={`feed-${n.kind.toLowerCase()}`}>
              <time>{formatTime(n.createdAt)}</time>
              <Link to={`/events/${n.eventId}`}>{n.message}</Link>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

function CabinetTile({
  cabinet,
  now,
  active,
  onSelect,
}: {
  cabinet: CabinetSnapshot;
  now: number;
  active: boolean;
  onSelect: () => void;
}) {
  const outOfRange =
    cabinet.currentTempX10 !== null && (cabinet.currentTempX10 < 20 || cabinet.currentTempX10 > 80);
  return (
    <button
      type="button"
      className={`tile tile-${cabinet.status.toLowerCase()} ${active ? 'active' : ''}`}
      onClick={onSelect}
      aria-pressed={active}
      data-cabinet={cabinet.cabinetId}
    >
      <div className="tile-head">
        <span className="tile-name">{cabinet.cabinetName.replace('疫苗冷藏櫃', '冷藏櫃')}</span>
        <StatusBadge status={cabinet.status} />
      </div>
      <div className={`tile-temp ${outOfRange ? 'out' : ''}`}>
        {formatTemp(cabinet.currentTempX10)}
      </div>
      <dl className="tile-meta">
        <dt>最後回報</dt>
        <dd title={formatTime(cabinet.lastReportedAt, true)}>
          {formatAgo(cabinet.lastReportedAt, now)}
        </dd>
        <dt>溫度計</dt>
        <dd>{cabinet.deviceId ?? '未綁定'}</dd>
        <dt>電量</dt>
        <dd>{cabinet.battery === null ? '—' : `${cabinet.battery}%`}</dd>
      </dl>
    </button>
  );
}
