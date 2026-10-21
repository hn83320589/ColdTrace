import type { CabinetStatus } from '@coldtrace/shared';
import { CABINET_STATUS_LABEL } from '../lib/format';

export function StatusBadge({ status }: { status: CabinetStatus }) {
  return (
    <span className={`badge badge-${status.toLowerCase()}`}>{CABINET_STATUS_LABEL[status]}</span>
  );
}

export function EventBadge({ type, label }: { type: 'EXCURSION' | 'OFFLINE'; label: string }) {
  return (
    <span className={`badge ${type === 'EXCURSION' ? 'badge-alert' : 'badge-offline'}`}>
      {label}
    </span>
  );
}
