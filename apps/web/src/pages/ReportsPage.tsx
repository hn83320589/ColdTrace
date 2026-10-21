import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { isCountedExcursion, taipeiMonthOf } from '@coldtrace/shared';
import { api } from '../api';
import { EventBadge } from '../components/StatusBadge';
import {
  EVENT_TYPE_LABEL,
  eventStatusLabel,
  formatDuration,
  formatPercent,
  formatTime,
} from '../lib/format';
import { useServerNow } from '../server-clock';

export function ReportsPage() {
  const { now } = useServerNow();
  const [month, setMonth] = useState(() => taipeiMonthOf(now));
  const {
    data: report,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['report', month],
    queryFn: () => api.monthlyReport(month),
  });
  const csvUrl = (kind: 'summary' | 'events') =>
    `/api/reports/monthly.csv?month=${month}&kind=${kind}`;

  return (
    <section className="page">
      <header className="page-head">
        <h1>月報</h1>
        <div className="filters">
          <label>
            月份
            <input
              type="month"
              value={month}
              onChange={(e) => e.target.value && setMonth(e.target.value)}
            />
          </label>
          <a className="button" href={csvUrl('summary')} download>
            匯出摘要 CSV
          </a>
          <a className="button" href={csvUrl('events')} download>
            匯出事件清單 CSV
          </a>
        </div>
      </header>
      <p className="hint">
        資料完整率 = 有資料的分鐘數 ÷ 應有分鐘數（冷藏櫃有綁定溫度計的期間，當月未結束時算到現在）。
        溫度合規率 = 溫度在 2–8°C 的分鐘數 ÷ 有資料的分鐘數。
      </p>

      {error && <p className="error">{error.message}</p>}
      {isLoading && <p className="muted">計算中…</p>}
      {report && (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>分院</th>
                  <th>冷藏櫃</th>
                  <th className="num">應有分鐘</th>
                  <th className="num">有資料分鐘</th>
                  <th className="num">資料完整率</th>
                  <th className="num">溫度合規率</th>
                  <th className="num">溫度異常</th>
                  <th className="num">斷線</th>
                </tr>
              </thead>
              <tbody>
                {report.cabinets.map((c) => (
                  <tr key={c.cabinetId}>
                    <td>{c.branchName}</td>
                    <td>{c.cabinetName}</td>
                    <td className="num">{c.expectedMinutes.toLocaleString()}</td>
                    <td className="num">{c.recordedMinutes.toLocaleString()}</td>
                    <td className={`num ${(c.completenessRate ?? 1) < 0.99 ? 'warn' : ''}`}>
                      {formatPercent(c.completenessRate)}
                    </td>
                    <td className={`num ${(c.complianceRate ?? 1) < 0.99 ? 'warn' : ''}`}>
                      {formatPercent(c.complianceRate)}
                    </td>
                    <td className="num">{c.events.filter(isCountedExcursion).length}</td>
                    <td className="num">{c.events.filter((e) => e.type === 'OFFLINE').length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2>事件清單</h2>
          {report.cabinets.every((c) => c.events.length === 0) && (
            <p className="muted">本月無事件</p>
          )}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>類型</th>
                  <th>冷藏櫃</th>
                  <th>開始</th>
                  <th>持續</th>
                  <th>狀態</th>
                  <th>處置</th>
                </tr>
              </thead>
              <tbody>
                {report.cabinets.flatMap((c) =>
                  c.events.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <EventBadge type={e.type} label={EVENT_TYPE_LABEL[e.type]} />
                      </td>
                      <td>
                        {c.branchName}／{c.cabinetName}
                      </td>
                      <td>
                        <Link to={`/events/${e.id}`}>{formatTime(e.startedAt)}</Link>
                      </td>
                      <td>{formatDuration(e.durationMs)}</td>
                      <td>{eventStatusLabel(e)}</td>
                      <td>
                        {e.latestDisposition
                          ? `${e.latestDisposition.handler}${e.latestDisposition.vaccineDiscarded ? `（報廢 ${e.latestDisposition.discardedQty} 劑）` : ''}`
                          : '—'}
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
