import { Link } from 'react-router';
import { useRealtime } from '../realtime';

export function Toasts() {
  const { toasts, dismiss } = useRealtime();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind === 'EXCURSION_ENDED' ? 'info' : 'warn'}`}>
          <Link to={`/events/${t.eventId}`} onClick={() => dismiss(t.id)}>
            {t.message}
          </Link>
          <button type="button" aria-label="關閉" onClick={() => dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
