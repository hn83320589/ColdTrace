# 第 08 章　月報計算與前端演算法

> 本章收集幾個「看起來簡單、其實藏著陷阱」的計算：月報比率、月份邊界、CSV、圖表缺口、加速時鐘下的「現在」。

## 8.1 月報的兩個比率

```text
資料完整率 = 有資料的分鐘數 ÷ 應有資料的分鐘數
溫度合規率 = 在範圍內的分鐘數 ÷ 有資料的分鐘數
```

先手算一個例子，寫進設計文件，再寫成測試（`report-service.test.ts`）：

```text
10 月共 31 天 = 44,640 分鐘（應有）
有資料 44,000 分鐘，其中 43,780 分鐘在 2–8°C
完整率 = 44,000 / 44,640 = 98.57%
合規率 = 43,780 / 44,000 = 99.50%
```

```ts
export function computeRates(c: MinuteCounts) {
  return {
    completenessRate:
      c.expectedMinutes > 0 ? Math.min(1, c.recordedMinutes / c.expectedMinutes) : null,
    complianceRate: c.recordedMinutes > 0 ? c.inRangeMinutes / c.recordedMinutes : null,
  };
}
```

**分母為 0 時回傳 `null`，不是 0 也不是 100%**。一台這個月剛綁定、還沒有任何資料的冷藏櫃，
說它「合規率 0%」或「100%」都是錯的，正確答案是「無法計算」，畫面顯示「—」。

### 「應有分鐘數」：綁定區間與月份的交集

一台冷藏櫃 10 月 15 日才裝溫度計，10 月前半個月沒有資料不應該算「不完整」。
所以應有分鐘數 = Σ（每段綁定區間 ∩ 本月區間）的長度：

```sql
SELECT SUM(MIN(COALESCE(bound_to, ?1), ?1) - MAX(bound_from, ?2)) AS ms
FROM bindings
WHERE cabinet_id = ?3 AND bound_from < ?1 AND COALESCE(bound_to, ?1) > ?2
-- ?1 = 月底（或現在），?2 = 月初
```

兩個半開區間 `[a, b)` 與 `[c, d)` 的交集長度是 `min(b, d) − max(a, c)`（若為正）。
`WHERE` 條件先排除不相交的綁定，`SELECT` 計算交集長度並加總。
SQLite 的 `MIN(x, y)`／`MAX(x, y)` 在多個參數時是純量函數，不是聚合函數，這裡正好用得上。

**當月還沒結束**時，「月底」取 `min(月底, 現在)`，否則月中查看月報時完整率會被嚴重低估。

### 「有資料分鐘數」：用 DISTINCT 分鐘

```sql
SELECT COUNT(DISTINCT measured_at / 60000) AS recorded,
       COUNT(DISTINCT CASE WHEN temp_x10 BETWEEN 20 AND 80 THEN measured_at / 60000 END) AS in_range
FROM readings WHERE cabinet_id = ? AND measured_at >= ? AND measured_at < ?
```

用「分鐘編號」去重，而不是 `COUNT(*)`。即使同一分鐘因故有兩筆，也只算一分鐘，
比率不會超過 100%。（第 10 章的 migration v2 進一步在資料庫層防止同一分鐘有兩筆。）

## 8.2 月份邊界：時區陷阱

```ts
/** 回傳台灣時間該月份的 [from, to) epoch 毫秒 */
export function taipeiMonthRange(month: string): { from: number; to: number } {
  const { year, month: m } = parseMonth(month);
  const from = Date.UTC(year, m - 1, 1) - TAIPEI_OFFSET_MS;
  const to = Date.UTC(year, m, 1) - TAIPEI_OFFSET_MS;
  return { from, to };
}
```

- `Date.UTC(2026, 9, 1)` 是 UTC 的 10/1 00:00；減 8 小時，得到台灣時間 10/1 00:00 對應的 epoch。
- `Date.UTC(year, 12, 1)`（月份 12 = 第 13 個月）會自動進位到隔年 1 月，不需要特別處理 12 月。
- **不使用 `new Date(year, month, 1)`**：那會用**伺服器所在時區**，部署到 UTC 的雲端主機就錯了 8 小時。

測試用跨越邊界的資料驗證：9/30 23:50 到 10/1 00:09 共 20 筆，只有後 10 筆算進 10 月。

## 8.3 CSV：給 Excel 讀的 CSV

```ts
const UTF8_BOM = '\uFEFF'; // 原始碼中直接寫入這個不可見字元

function escape(cell: CsvCell): string {
  if (cell === null || cell === undefined) return '';
  const text = typeof cell === 'boolean' ? (cell ? '是' : '否') : String(cell);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: string[], rows: CsvCell[][]): string {
  return UTF8_BOM + [header, ...rows].map((row) => row.map(escape).join(',')).join('\r\n') + '\r\n';
}
```

| 細節                                         | 不做會怎樣                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| UTF-8 BOM                                    | Excel 用系統編碼（繁中 Windows 是 Big5）開啟，中文變亂碼                  |
| CRLF 換行                                    | RFC 4180 規定；部分工具只認 CRLF                                          |
| 含逗號、引號、換行的欄位加引號，引號重複一次 | 處置說明寫了「已通知廠商，明天到場」，欄位就被拆成兩欄                    |
| 月份寫成「2026年10月」                       | `2026-10` 被 Excel 自動轉成日期，顯示為「Oct-26」，容易誤讀為 10 月 26 日 |

最後一列是**實際用 Excel 打開才發現**的（測試報告缺陷 #2）。單元測試確認了 CSV 格式正確，
但「格式正確」不等於「使用者看到的是對的」。**交付物要在使用者的工具裡驗證**。

## 8.4 圖表缺口：讓線條在斷線處中斷

ECharts 遇到 `null` 會中斷折線。問題是要在**哪裡**插入 `null`：

```ts
/** 相鄰兩點間隔超過可容忍缺口時插入 null，讓折線在斷線處中斷 */
export function insertGaps(
  points: readonly ReadingPoint[],
  maxStepMs = SAMPLE_INTERVAL_MS + MAX_CONTINUOUS_GAP_MS,
) {
  const result: ChartPoint[] = [];
  let previous: number | null = null;
  for (const [t, v] of points) {
    if (previous !== null && t - previous > maxStepMs)
      result.push([previous + SAMPLE_INTERVAL_MS, null]);
    result.push([t, v / 10]);
    previous = t;
  }
  return result;
}
```

- 使用與異常偵測**相同的連續規則**（3 分鐘）：圖上連成一條線的地方，判定邏輯也認為是連續的。
  如果圖表用 1 分鐘、判定用 3 分鐘，使用者會看到「線斷了但事件沒斷」的矛盾畫面。
- 補傳後前端重抓資料，缺口被填滿，`null` 自然消失，線條自動接起來。不需要任何「補傳模式」的特殊處理。
- 溫度在這裡才從 0.1°C 整數轉回攝氏度（`v / 10`），**只在顯示層轉換**。

### 驗收 #11：1,440 點 1 秒內繪製

量測方式寫在元件裡：每次 `setOption` 前記錄時間，ECharts 觸發 `finished` 事件時計算耗時，
透過 `onRendered` 回報，面板上直接顯示。實測 4–28 毫秒。

```ts
const started = performance.now();
instance.on('finished', () => {
  instance.off('finished');
  onRendered?.(performance.now() - started);
});
instance.setOption({ animation: false /* ... */ });
```

`animation: false` 很重要：動畫會讓 `finished` 延後數百毫秒，而且每分鐘更新一次時動畫只是干擾。

## 8.5 即時資料合併

```ts
/** 即時新增的點合併進既有序列：去重、排序，並丟掉視窗之外的舊資料 */
export function mergePoints(existing, incoming, windowFrom) {
  const byTime = new Map<number, ReadingPoint>();
  for (const p of existing) if (p[0] >= windowFrom) byTime.set(p[0], p);
  for (const p of incoming) if (p[0] >= windowFrom) byTime.set(p[0], p);
  return [...byTime.values()].sort((a, b) => a[0] - b[0]);
}
```

用 `Map` 以時間為鍵去重，讓這個函數也是**冪等**的：同一則 WebSocket 訊息收到兩次（例如重連後），結果不變。
從後端到前端，「重複是常態」的假設一路貫徹。

## 8.6 加速時鐘下的「現在」

儀表板顯示「最後回報：3 分鐘前」。如果用瀏覽器的 `Date.now()` 計算，在 `CLOCK_SPEED=60` 展示時，
伺服器時間每秒前進 1 分鐘，畫面上卻顯示「3 秒前」，完全錯誤。

```ts
/** 依取得伺服器時間當下的真實時間與倍率，推算現在的伺服器時間 */
export function estimateServerNow(info: ClockInfo, fetchedAt: number, realNow: number): number {
  return info.now + (realNow - fetchedAt) * info.speed;
}
```

前端啟動時呼叫 `GET /api/system/clock` 取得 `{ now, speed }`，之後每秒用這個公式推算，不需要每秒問伺服器。
這是「時鐘可注入」原則在前端的延伸：**時間的來源只有一個，就是伺服器的 Clock**。

## 8.7 首屏載入：按需載入

ECharts 即使按需引入元件，加上 zrender 仍約 540 kB。外部 review 指出整個前端打包成單一 883 kB 檔案。
修正方式是讓圖表與非首頁的頁面**延後載入**：

```tsx
// apps/web/src/components/LazyTemperatureChart.tsx
const load = () => import('./TemperatureChart');
const Chart = lazy(() => load().then((m) => ({ default: m.TemperatureChart })));

/** 儀表板載入後先在背景下載圖表程式，點開冷藏櫃時不必再等 */
export const preloadTemperatureChart = (): void => void load();
```

`load` 被 `lazy` 與 `preload` 共用：瀏覽器對同一個 `import()` 只會下載一次，
所以儀表板一顯示就在背景預載，使用者點開冷藏櫃時通常已經下載完成。首屏從 883 kB 降到約 315 kB。

> **教學重點**：優化前先量測。這次用 sourcemap 把打包內容逐一對應回套件，才發現 ECharts 早就是按需引入，
> 「改成按需引入」這個建議其實沒有空間。有效的方向是「**延後載入**」，而不是「**少載入**」。

## 8.8 本章練習

1. 一台冷藏櫃 10 月有兩段綁定：`[10/1, 10/10)` 與 `[10/12, ∞)`。手算 10 月的應有分鐘數，並寫成測試。
2. 如果合規率的分母改成「應有分鐘數」（缺資料視為不合規），對斷線頻繁的冷藏櫃有什麼影響？哪一種定義對疫苗安全比較保守？
3. `insertGaps` 在兩點之間只插入一個 `null`。如果要讓滑鼠移到缺口上時 tooltip 顯示「斷線 2 小時」，你會怎麼改？
4. 寫一個 `estimateServerNow` 的測試：伺服器時間 10:00、倍率 60、取得後經過真實 2 秒，現在應該是幾點？
