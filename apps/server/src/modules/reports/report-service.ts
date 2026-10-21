import {
  MINUTE_MS,
  TEMP_MAX_X10,
  TEMP_MIN_X10,
  eventStatusLabel,
  EVENT_TYPE_LABEL,
  formatTaipei,
  taipeiMonthRange,
  type MonthlyCabinetReport,
  type MonthlyReport,
} from '@coldtrace/shared';
import { all, get, type Db } from '../../infra/db';
import type { EventQueryService } from '../events/event-query-service';
import { toCsv } from './csv';

interface CabinetRow {
  id: string;
  name: string;
  branch_name: string;
}

export interface MinuteCounts {
  expectedMinutes: number;
  recordedMinutes: number;
  inRangeMinutes: number;
}

/** 完整率 = 有資料分鐘 ÷ 應有分鐘；合規率 = 範圍內分鐘 ÷ 有資料分鐘 */
export function computeRates(c: MinuteCounts): {
  completenessRate: number | null;
  complianceRate: number | null;
} {
  return {
    completenessRate:
      c.expectedMinutes > 0 ? Math.min(1, c.recordedMinutes / c.expectedMinutes) : null,
    complianceRate: c.recordedMinutes > 0 ? c.inRangeMinutes / c.recordedMinutes : null,
  };
}

const round2 = (rate: number | null) => (rate === null ? null : Math.round(rate * 10000) / 100);

export class ReportService {
  constructor(
    private readonly db: Db,
    private readonly eventQueries: EventQueryService,
  ) {}

  monthly(month: string, now: number): MonthlyReport {
    const { from, to } = taipeiMonthRange(month);
    const until = Math.min(to, Math.floor(now / MINUTE_MS) * MINUTE_MS);
    const cabinets = all<CabinetRow>(
      this.db,
      `SELECT c.id, c.name, b.name AS branch_name
       FROM cabinets c JOIN branches b ON b.id = c.branch_id ORDER BY b.id, c.id`,
    );
    return {
      month,
      generatedAt: now,
      cabinets: cabinets.map((c) => this.cabinetReport(c, from, until, now)),
    };
  }

  private cabinetReport(
    c: CabinetRow,
    from: number,
    until: number,
    now: number,
  ): MonthlyCabinetReport {
    const counts = this.minuteCounts(c.id, from, until);
    return {
      cabinetId: c.id,
      cabinetName: c.name,
      branchName: c.branch_name,
      ...counts,
      ...computeRates(counts),
      events: this.eventQueries
        .list({ cabinetId: c.id, from, to: until - 1, limit: 2000 }, now)
        .sort((a, b) => a.startedAt - b.startedAt),
    };
  }

  minuteCounts(cabinetId: string, from: number, until: number): MinuteCounts {
    if (until <= from) return { expectedMinutes: 0, recordedMinutes: 0, inRangeMinutes: 0 };
    const bound =
      get<{ ms: number | null }>(
        this.db,
        `SELECT SUM(MIN(COALESCE(bound_to, ?1), ?1) - MAX(bound_from, ?2)) AS ms
         FROM bindings
         WHERE cabinet_id = ?3 AND bound_from < ?1 AND COALESCE(bound_to, ?1) > ?2`,
        [until, from, cabinetId],
      )?.ms ?? 0;
    const minutes = get<{ recorded: number; in_range: number }>(
      this.db,
      `SELECT COUNT(DISTINCT measured_at / ${MINUTE_MS}) AS recorded,
              COUNT(DISTINCT CASE WHEN temp_x10 BETWEEN ${TEMP_MIN_X10} AND ${TEMP_MAX_X10}
                                  THEN measured_at / ${MINUTE_MS} END) AS in_range
       FROM readings WHERE cabinet_id = ? AND measured_at >= ? AND measured_at < ?`,
      [cabinetId, from, until],
    );
    return {
      expectedMinutes: Math.floor(bound / MINUTE_MS),
      recordedMinutes: minutes?.recorded ?? 0,
      inRangeMinutes: minutes?.in_range ?? 0,
    };
  }

  summaryCsv(report: MonthlyReport): string {
    return toCsv(
      [
        '月份',
        '分院',
        '冷藏櫃',
        '冷藏櫃代碼',
        '應有分鐘數',
        '有資料分鐘數',
        '範圍內分鐘數',
        '資料完整率(%)',
        '溫度合規率(%)',
        '溫度異常事件數',
        '斷線事件數',
        '累積超標度分鐘',
      ],
      report.cabinets.map((c) => {
        const excursions = c.events.filter((e) => e.type === 'EXCURSION');
        const degreeMinutes =
          excursions.reduce((sum, e) => sum + (e.degreeMinutesX10 ?? 0), 0) / 10;
        return [
          report.month,
          c.branchName,
          c.cabinetName,
          c.cabinetId,
          c.expectedMinutes,
          c.recordedMinutes,
          c.inRangeMinutes,
          round2(c.completenessRate),
          round2(c.complianceRate),
          excursions.length,
          c.events.length - excursions.length,
          degreeMinutes.toFixed(1),
        ];
      }),
    );
  }

  eventsCsv(report: MonthlyReport): string {
    const temp = (x10: number | null) => (x10 === null ? null : (x10 / 10).toFixed(1));
    const time = (t: number | null) => (t === null ? null : formatTaipei(t));
    return toCsv(
      [
        '事件編號',
        '類型',
        '分院',
        '冷藏櫃',
        '開始時間',
        '結束時間',
        '持續分鐘',
        '最高溫(°C)',
        '最低溫(°C)',
        '累積超標度分鐘',
        '狀態',
        '依補傳資料判定',
        '關聯事件',
        '處置人',
        '處置說明',
        '疫苗報廢',
        '報廢數量',
      ],
      report.cabinets.flatMap((c) =>
        c.events.map((e) => {
          const d = e.latestDisposition;
          return [
            e.id,
            EVENT_TYPE_LABEL[e.type],
            c.branchName,
            c.cabinetName,
            time(e.startedAt),
            time(e.endedAt),
            e.durationMs === null ? null : Math.round(e.durationMs / MINUTE_MS),
            temp(e.maxTempX10),
            temp(e.minTempX10),
            e.degreeMinutesX10 === null ? null : (e.degreeMinutesX10 / 10).toFixed(1),
            eventStatusLabel(e),
            e.backfilled,
            e.linkedEventIds.map((id) => `#${id}`).join(' '),
            d?.handler,
            d?.note,
            d ? d.vaccineDiscarded : null,
            d?.discardedQty,
          ];
        }),
      ),
    );
  }
}
