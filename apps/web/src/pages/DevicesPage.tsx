import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { formatTime } from '../lib/format';

export function DevicesPage() {
  const qc = useQueryClient();
  const { data: cabinets } = useQuery({ queryKey: ['cabinets'], queryFn: api.cabinets });
  const { data: devices } = useQuery({ queryKey: ['devices'], queryFn: api.devices });
  const { data: bindings } = useQuery({ queryKey: ['bindings'], queryFn: api.bindings });

  const [cabinetId, setCabinetId] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const spareDevices = devices?.filter((d) => d.cabinetId === null) ?? [];
  const replace = useMutation({
    mutationFn: () => api.replaceDevice(cabinetId, deviceId),
    onSuccess: () => {
      setMessage({ ok: true, text: `已將 ${cabinetId} 的溫度計更換為 ${deviceId}` });
      setDeviceId('');
      for (const key of ['devices', 'bindings', 'dashboard'])
        void qc.invalidateQueries({ queryKey: [key] });
    },
    onError: (e) => setMessage({ ok: false, text: e.message }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!cabinetId || !deviceId) {
      setMessage({ ok: false, text: '請選擇冷藏櫃與新溫度計' });
      return;
    }
    replace.mutate();
  };

  return (
    <section className="page">
      <header className="page-head">
        <h1>設備管理</h1>
      </header>

      <form className="card form row" onSubmit={submit}>
        <h2>更換溫度計</h2>
        <label>
          冷藏櫃
          <select value={cabinetId} onChange={(e) => setCabinetId(e.target.value)}>
            <option value="">請選擇</option>
            {cabinets?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.branchName}／{c.name}（{c.id}）
              </option>
            ))}
          </select>
        </label>
        <label>
          新溫度計（未綁定）
          <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
            <option value="">請選擇</option>
            {spareDevices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.id}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={replace.isPending}>
          立即更換
        </button>
        <p className="hint">更換時間為現在；舊溫度計之後補傳的資料，仍依量測時間歸屬到本冷藏櫃。</p>
        {message && <p className={message.ok ? 'success' : 'error'}>{message.text}</p>}
      </form>

      <h2>冷藏櫃與綁定歷史</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>分院</th>
              <th>冷藏櫃</th>
              <th>溫度計</th>
              <th>綁定起</th>
              <th>綁定迄</th>
            </tr>
          </thead>
          <tbody>
            {cabinets?.flatMap((c) =>
              (bindings ?? [])
                .filter((b) => b.cabinetId === c.id)
                .map((b) => (
                  <tr key={b.id} className={b.boundTo === null ? '' : 'muted'}>
                    <td>{c.branchName}</td>
                    <td>
                      {c.name}（{c.id}）
                    </td>
                    <td>{b.deviceId}</td>
                    <td>{formatTime(b.boundFrom)}</td>
                    <td>{b.boundTo === null ? '使用中' : formatTime(b.boundTo)}</td>
                  </tr>
                )),
            )}
          </tbody>
        </table>
      </div>

      <h2>溫度計</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>裝置 ID</th>
              <th>型號</th>
              <th>目前綁定</th>
              <th>最後流水號</th>
            </tr>
          </thead>
          <tbody>
            {devices?.map((d) => (
              <tr key={d.id}>
                <td>{d.id}</td>
                <td>{d.model ?? '—'}</td>
                <td>{d.cabinetId ?? <span className="muted">備品</span>}</td>
                <td className="num">{d.lastSeq ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
