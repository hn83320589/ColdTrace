import { NavLink, Outlet } from 'react-router';
import { formatTaipei } from '@coldtrace/shared';
import { useRealtime } from '../realtime';
import { useServerNow } from '../server-clock';
import { Toasts } from './Toasts';

const NAV = [
  ['/', '儀表板'],
  ['/events', '事件紀錄'],
  ['/devices', '設備管理'],
] as const;

export function Layout() {
  const { connected } = useRealtime();
  const { now, speed } = useServerNow();
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            ❄
          </span>
          ColdTrace <small>疫苗冷藏櫃監測</small>
        </div>
        <nav>
          {NAV.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === '/'}>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="topbar-meta">
          <span className="clock">
            {formatTaipei(now, true)}
            {speed !== 1 && <em className="speed">×{speed}</em>}
          </span>
          <span className={`conn ${connected ? 'conn-on' : 'conn-off'}`}>
            {connected ? '即時連線' : '重新連線中…'}
          </span>
        </div>
      </header>
      <main>
        <Outlet />
      </main>
      <Toasts />
    </div>
  );
}
