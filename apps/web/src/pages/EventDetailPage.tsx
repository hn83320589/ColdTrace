import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { HOUR_MS } from '@coldtrace/shared';
import { dispositionInputSchema, type EventDetailDto } from '@coldtrace/shared';
import { api } from '../api';
import { EventBadge } from '../components/StatusBadge';
import { TemperatureChart } from '../components/TemperatureChart';
import {
  EVENT_TYPE_LABEL,
  eventStatusLabel,
  formatDuration,
  formatTemp,
  formatTime,
} from '../lib/format';

export function EventDetailPage() {
  const id = Number(useParams().id);
  const { data: event, error } = useQuery({
    queryKey: ['event', id],
    queryFn: () => api.event(id),
  });
  const { data: cabinets } = useQuery({ queryKey: ['cabinets'], queryFn: api.cabinets });

  if (error) return <p className="error">{error.message}</p>;
  if (!event) return <p className="muted">載入中…</p>;
  const cabinet = cabinets?.find((c) => c.id === event.cabinetId);

  return (
    <section className="page narrow">
      <p>
        <Link to="/events">← 事件紀錄</Link>
      </p>
      <header className="page-head">
        <h1>
          <EventBadge type={event.type} label={EVENT_TYPE_LABEL[event.type]} /> 事件 #{event.id}
        </h1>
        <Link to={`/?cabinet=${event.cabinetId}`}>查看溫度圖表</Link>
      </header>

      <dl className="facts">
        <dt>冷藏櫃</dt>
        <dd>{cabinet ? `${cabinet.branchName}／${cabinet.name}` : event.cabinetId}</dd>
        <dt>狀態</dt>
        <dd>
          {eventStatusLabel(event)}
          {event.backfilled && <span className="tag">依補傳資料判定</span>}
        </dd>
        <dt>開始時間</dt>
        <dd>{formatTime(event.startedAt)}</dd>
        <dt>結束時間</dt>
        <dd>{formatTime(event.endedAt)}</dd>
        <dt>持續時間</dt>
        <dd>{formatDuration(event.durationMs)}</dd>
        {event.type === 'EXCURSION' && (
          <>
            <dt>最高溫 / 最低溫</dt>
            <dd>
              {formatTemp(event.maxTempX10)} / {formatTemp(event.minTempX10)}
            </dd>
            <dt>累積超標度分鐘</dt>
            <dd>
              {event.degreeMinutesX10 === null ? '—' : (event.degreeMinutesX10 / 10).toFixed(1)}
            </dd>
          </>
        )}
        <dt>偵測時間</dt>
        <dd>{formatTime(event.detectedAt)}</dd>
        {event.linkedEventIds.length > 0 && (
          <>
            <dt>{event.type === 'OFFLINE' ? '期間的溫度異常' : '關聯的斷線事件'}</dt>
            <dd>
              {event.linkedEventIds.map((linked) => (
                <Link key={linked} to={`/events/${linked}`} className="chip">
                  #{linked}
                </Link>
              ))}
            </dd>
          </>
        )}
      </dl>

      <EventChart event={event} />

      <DispositionForm event={event} />

      <h2>處置歷程</h2>
      {event.dispositions.length === 0 && <p className="muted">尚無處置紀錄</p>}
      <ol className="timeline">
        {event.dispositions.map((d) => (
          <li key={d.id}>
            <header>
              <strong>{d.handler}</strong> <time>{formatTime(d.createdAt)}</time>
            </header>
            <p>{d.note}</p>
            <p className={d.vaccineDiscarded ? 'discarded' : 'muted'}>
              {d.vaccineDiscarded ? `疫苗報廢 ${d.discardedQty} 劑` : '疫苗未報廢'}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** 事件前後各 1 小時的溫度曲線 */
function EventChart({ event }: { event: EventDetailDto }) {
  const from = event.startedAt - HOUR_MS;
  const to = (event.endedAt ?? event.startedAt + (event.durationMs ?? 0)) + HOUR_MS;
  const { data } = useQuery({
    queryKey: ['readings', event.cabinetId, { from, to }],
    queryFn: () => api.readings(event.cabinetId, { from, to }),
  });
  if (!data) return <div className="chart chart-loading">載入中…</div>;
  return <TemperatureChart points={data.points} from={from} to={to} />;
}

function DispositionForm({ event }: { event: EventDetailDto }) {
  const qc = useQueryClient();
  const [handler, setHandler] = useState('');
  const [note, setNote] = useState('');
  const [discarded, setDiscarded] = useState(false);
  const [qty, setQty] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (input: Parameters<typeof api.addDisposition>[1]) =>
      api.addDisposition(event.id, input),
    onSuccess: (detail) => {
      qc.setQueryData(['event', event.id], detail);
      void qc.invalidateQueries({ queryKey: ['events'] });
      setNote('');
      setDiscarded(false);
      setQty(0);
    },
    onError: (e) => setFormError(e.message),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = dispositionInputSchema.safeParse({
      handler,
      note,
      vaccineDiscarded: discarded,
      discardedQty: discarded ? qty : 0,
    });
    if (!parsed.success) {
      setFormError(parsed.error.issues.map((i) => i.message).join('；'));
      return;
    }
    setFormError(null);
    mutation.mutate(parsed.data);
  };

  return (
    <form className="card form" onSubmit={submit}>
      <h2>新增處置紀錄</h2>
      <label>
        處置人
        <input
          value={handler}
          onChange={(e) => setHandler(e.target.value)}
          placeholder="例如：王護理師"
        />
      </label>
      <label>
        處置說明
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
      </label>
      <label className="inline">
        <input
          type="checkbox"
          checked={discarded}
          onChange={(e) => setDiscarded(e.target.checked)}
        />
        疫苗報廢
      </label>
      {discarded && (
        <label>
          報廢數量（劑）
          <input
            type="number"
            min={1}
            value={qty}
            onChange={(e) => setQty(Number(e.target.value))}
          />
        </label>
      )}
      {formError && <p className="error">{formError}</p>}
      <button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? '儲存中…' : '儲存處置紀錄'}
      </button>
    </form>
  );
}
