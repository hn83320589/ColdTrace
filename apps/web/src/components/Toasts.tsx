import { Link } from 'react-router';
import type { NotificationKind } from '@coldtrace/shared';
import { useRealtime } from '../realtime';

/** 狀態解除類的通知以資訊色顯示，其餘為警示 */
const INFO_KINDS = new Set<NotificationKind>(['EXCURSION_ENDED', 'EXCURSION_RETRACTED']);

export function Toasts() {
  const { toasts, dismiss } = useRealtime();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${INFO_KINDS.has(t.kind) ? 'info' : 'warn'}`}>
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
