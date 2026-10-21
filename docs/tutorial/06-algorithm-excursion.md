# 第 06 章　核心演算法 I：溫度異常偵測與事件對帳

> 本章是整份教材的核心。兩個演算法分工明確：
>
> - **偵測**（`excursion-detector.ts`）：給一串讀值，找出所有超標連續段。純函數。
> - **對帳**（`excursion-reconciler.ts`）：把偵測結果與資料庫中既有的事件比對，決定新增、更新或合併。

## 6.1 問題形式化

**輸入**：一組讀值 `{ (t, temp) }`，t 為量測時間（整分鐘），temp 為 0.1°C 整數。順序任意。

**定義**：

- 讀值**超標** ⇔ `temp < 20` 或 `temp > 80`（即 < 2.0°C 或 > 8.0°C）
- 相鄰兩筆讀值**連續** ⇔ 時間差 ≤ 1 分鐘 + 2 分鐘容忍缺口 = 3 分鐘
- **超標連續段（run）**：依時間排序後，一串彼此連續、全部超標的讀值，前後由「正常讀值」或「不連續」切斷
- run 的**持續時間** = 最後一筆超標 + 1 分鐘 − 第一筆超標
- run **成立** ⇔ 持續時間 ≥ 10 分鐘
- **度分鐘** = Σ 每筆超標讀值的超出量（`temp − 80` 或 `20 − temp`，單位 0.1°C）× 1 分鐘

**輸出**：所有 run，每個 run 包含起點、最後一筆超標時間、結束時間、持續時間、極值、度分鐘、是否成立。

## 6.2 偵測演算法

完整程式碼（`apps/server/src/modules/events/excursion-detector.ts`）：

```ts
/** 相鄰兩筆讀值的間隔不超過此值，就視為連續 */
const MAX_STEP_MS = SAMPLE_INTERVAL_MS + MAX_CONTINUOUS_GAP_MS; // 1 + 2 = 3 分鐘

function finish(run: Building, end: number | null): ExcursionRun {
  const durationMs = run.lastOutAt + SAMPLE_INTERVAL_MS - run.start;
  return { ...run, end, durationMs, established: durationMs >= EXCURSION_MIN_DURATION_MS };
}

export function detectExcursionRuns(input: readonly Sample[]): ExcursionRun[] {
  const samples = [...input].sort((a, b) => a.t - b.t); // ❶ 不依賴輸入順序
  const runs: ExcursionRun[] = [];
  let current: Building | null = null;

  for (const { t, tempX10 } of samples) {
    const continuous = current !== null && t - current.lastOutAt <= MAX_STEP_MS;

    if (current && !continuous) {
      // ❷ 缺口太大：切斷
      runs.push(finish(current, current.lastOutAt + SAMPLE_INTERVAL_MS));
      current = null;
    }

    if (isInRange(tempX10)) {
      // ❸ 正常讀值：結束目前的 run
      if (current) {
        runs.push(finish(current, t));
        current = null;
      }
      continue;
    }

    if (current) {
      // ❹ 延續：更新極值與度分鐘
      current.lastOutAt = t;
      current.maxTempX10 = Math.max(current.maxTempX10, tempX10);
      current.minTempX10 = Math.min(current.minTempX10, tempX10);
      current.degreeMinutesX10 += exceedanceX10(tempX10);
    } else {
      // ❺ 開始新的 run
      current = {
        start: t,
        lastOutAt: t,
        maxTempX10: tempX10,
        minTempX10: tempX10,
        degreeMinutesX10: exceedanceX10(tempX10),
      };
    }
  }

  if (current) runs.push(finish(current, null)); // ❻ 資料結束時仍在超標：進行中
  return runs;
}
```

### 逐行重點

- **❶ 先排序**：這一行讓整個函數與資料抵達順序無關。補傳的資料不論怎麼送，排序後都一樣。
- **❷ 先檢查連續性，再看溫度**：順序很重要。如果一筆正常讀值與前一筆超標之間隔了 1 小時，
  run 的結束時間應該是「最後一筆超標 + 1 分鐘」（我們只知道它至少持續到那時），而不是 1 小時後那筆正常讀值的時間。
- **❸ 結束時間**：緊接著出現的正常讀值時間，即「回到範圍的時間」。
- **❻ `end = null`**：資料到此為止仍在超標，代表事件**進行中**。這是唯一會產生進行中事件的地方。
- 只比較 `lastOutAt`，不需要記住「上一筆讀值」：因為正常讀值會讓 `current` 變成 `null`，
  所以只要 `current` 存在，上一筆讀值一定就是 `lastOutAt`。

### 走一遍：含缺口的例子

```text
分鐘  0    1    2    3    4    5    6    7    8    9   10   11   12   13   14
溫度 5.0  9.0  9.0  9.0  9.0  9.0  9.0  ---  9.0  9.0  9.0  9.0  9.0  9.0  5.0
                                       (缺)
```

| t    | 溫度 | continuous?       | 動作                       | current（start, lastOutAt, 度分鐘×10） |
| ---- | ---- | ----------------- | -------------------------- | -------------------------------------- |
| 0    | 5.0  | —                 | 正常，無 run               | null                                   |
| 1    | 9.0  | —                 | ❺ 開始                     | (1, 1, 10)                             |
| 2–6  | 9.0  | 是                | ❹ 延續                     | (1, 6, 60)                             |
| 8    | 9.0  | 8 − 6 = 2 ≤ 3，是 | ❹ 延續（缺口不累計度分鐘） | (1, 8, 70)                             |
| 9–13 | 9.0  | 是                | ❹ 延續                     | (1, 13, 120)                           |
| 14   | 5.0  | 是                | ❸ 結束，end = 14           | —                                      |

結果：持續時間 = 13 + 1 − 1 = **13 分鐘**（包含缺的那 1 分鐘），度分鐘 = **12.0**（只算有資料的 12 分鐘），成立。

> **設計討論**：缺口那 1 分鐘算進持續時間，但不算進度分鐘。理由是持續時間描述「事件多長」，
> 我們有理由相信缺口期間仍在超標；度分鐘則是累積暴露量，沒有量測就不應該猜測數值。
> 你可能會有不同的決定，重點是**兩者的定義要寫下來，並且有測試**。

### 複雜度

排序 O(n log n)，掃描 O(n)。對帳時 n 通常是幾十到幾百筆（見 6.4 節的視窗），最壞情況（72 小時補傳）是 4,320 筆，都是毫秒級。

### 為什麼用 0.1°C 整數？

```ts
(0.1 + 0.2 ===
  0.3 // false
  (1 + 2)) ===
  3; // true
```

度分鐘是加總，浮點誤差會累積。手算 10.3 的例子，用整數就是 `5+10+15+20+20+15+10+5+2+1 = 103`，
與手算**完全相等**，測試可以用 `toBe(103)` 而不是 `toBeCloseTo`。

## 6.3 純函數帶來的測試能力

因為偵測是純函數，驗收 #4、#5 和所有邊界情境都可以寫成最簡單的單元測試，不需要資料庫：

```ts
// apps/server/src/modules/events/excursion-detector.test.ts
/** 從第 0 分鐘起每分鐘一筆；null 代表該分鐘沒有資料 */
function samples(temps: (number | null)[]): Sample[] {
  return temps.flatMap((temp, i) => (temp === null ? [] : [{ t: at(i), tempX10: toX10(temp) }]));
}

it('超標 9 分鐘後回到範圍 → 不成立事件', () => {
  const [run] = detectExcursionRuns(samples([5, ...repeat(9, 9), 5]));
  expect(run).toMatchObject({ durationMs: 9 * MINUTE_MS, established: false });
});

it('累積超標度分鐘與手算一致', () => {
  // 超出量 0.5+1.0+1.5+2.0+2.0+1.5+1.0+0.5+0.2+0.1 = 10.3 度分鐘
  const temps = [8.5, 9.0, 9.5, 10.0, 10.0, 9.5, 9.0, 8.5, 8.2, 8.1];
  const [run] = detectExcursionRuns(samples([5, ...temps, 5]));
  expect(run?.degreeMinutesX10).toBe(103);
});

it('連續段中缺資料 ≤ 2 分鐘仍視為連續，但缺口不累計度分鐘', () => {
  const [run, ...rest] = detectExcursionRuns(
    samples([...repeat(9, 5), null, null, ...repeat(9, 5), 5]),
  );
  expect(rest).toEqual([]);
  expect(run).toMatchObject({
    durationMs: 12 * MINUTE_MS,
    degreeMinutesX10: 100,
    established: true,
  });
});
```

`samples()` 用 `null` 表示缺資料，讓測試資料看起來就像時間軸，一眼看出缺口在哪。

## 6.4 對帳：把判定結果寫進資料庫

偵測只回答「資料裡有哪些 run」。對帳要回答：「資料庫裡已經有哪些事件？要新增、更新、還是合併？」

### 步驟 1：決定重算視窗

新資料只落在 `[range.from, range.to]`，不需要重算整個歷史。但新資料可能讓**相鄰的** run 延長或連接，
所以視窗要往外延伸：

```text
// 簡化的虛擬碼：SQL 直接寫在行內，完整程式見原始檔
// 往前：range.from 之前最近一筆「正常」讀值
const windowFrom = SELECT MAX(measured_at) FROM readings
                   WHERE cabinet_id = ? AND measured_at < range.from AND 正常 ?? 0;
// 往後：range.to 之後最近一筆「正常」讀值
const windowTo   = SELECT MIN(measured_at) FROM readings
                   WHERE cabinet_id = ? AND measured_at > range.to AND 正常 ?? 無限大;
```

```text
         既有資料                        新資料              既有資料
... 5.0  9.0  9.0  9.0 │ 9.0  9.0  9.0  9.0 │ 9.0  9.0  5.0  ...
    ▲                  │◀── range ────────▶│            ▲
 windowFrom                                         windowTo
（前方最近的正常讀值）                           （後方最近的正常讀值）
```

**為什麼這樣就夠？** run 只會被正常讀值或大缺口切斷。視窗外的任何 run，與新資料之間至少隔著
一筆正常讀值（windowFrom 或 windowTo），所以新資料不可能改變它。這是一個**局部性**論證：
它讓每次對帳的成本與「新資料附近的超標長度」成正比，而不是與歷史長度成正比。

### 步驟 2：在視窗內偵測，只保留成立的 run

```ts
const runs = detectExcursionRuns(samples).filter((r) => r.established);
```

### 步驟 3：把每個 run 對應到既有事件

```ts
const existing = this.events.findExcursionsOverlapping(cabinetId, windowFrom, windowTo);
for (const run of runs) {
  // 既有事件的開始時間一定是一筆超標讀值，因此恰好屬於一個連續段
  const matches = existing.filter(
    (e) => e.started_at >= run.start && e.started_at <= run.lastOutAt,
  );
  this.apply(cabinetId, run, matches, now, out);
}
```

用「既有事件的開始時間落在哪個 run 裡」來對應，而不是「時間範圍是否重疊」。
因為事件的開始時間一定是某筆超標讀值的時間，而一筆讀值只屬於一個 run，所以對應是**唯一的**。
用重疊判斷的話，一個事件可能同時與兩個 run 重疊，就需要額外的規則來決定。

### 步驟 4：依對應數量決定動作

| 對應到幾個既有事件 | 意義               | 動作                                        |
| ------------------ | ------------------ | ------------------------------------------- |
| 0                  | 新的超標           | 新增事件，發「成立」通知                    |
| 1                  | 既有事件可能延長   | 更新起訖、極值、度分鐘                      |
| ≥ 2                | 補傳把兩段接起來了 | 保留最早的，其餘標記 `MERGED`，關聯轉移過去 |

```ts
private apply(cabinetId, run, matches, now, out) {
  const fields = fieldsOf(run);
  const [primary, ...merged] = matches;     // existing 依 started_at 排序，primary 是最早的

  if (!primary) {
    const establishedAt = run.start + EXCURSION_MIN_DURATION_MS - SAMPLE_INTERVAL_MS;
    const backfilled = now - establishedAt > OFFLINE_THRESHOLD_MS;
    eventId = this.events.insertExcursion(cabinetId, fields, now, backfilled);
    this.notify(eventId, 'EXCURSION_STARTED', ...);
  } else {
    eventId = primary.id;
    const changed = this.events.updateExcursion(eventId, fields);
    for (const m of merged) this.events.mergeExcursion(m.id, eventId);
    if (!changed && merged.length === 0) return;   // 什麼都沒變：不推播
  }

  if (run.end !== null) {
    this.notify(eventId, 'EXCURSION_ENDED', ...);   // 已發過的話 INSERT OR IGNORE 會忽略
  }
  // 推播 event.updated
}
```

兩個細節：

- **`backfilled` 的判斷**：「如果是即時資料，這個事件應該在什麼時候成立？」（第 10 筆超標進來時）。
  如果那個時間點已經比現在早超過 15 分鐘，代表這是補傳出來的歷史事件，訊息會加註「依補傳資料判定」。
- **結束通知不需要檢查狀態**：只要 run 已結束就呼叫 `notify`，通知表的唯一約束保證只發一次。
  這讓「補傳出已結束的歷史事件」自然地發出成立與結束兩則通知，不需要特別處理。

## 6.5 情境驗證

| 情境                 | 偵測結果                              | 對應                             | 動作                              |
| -------------------- | ------------------------------------- | -------------------------------- | --------------------------------- |
| 即時資料第 10 筆超標 | 1 個成立 run，end = null              | 0                                | 新增 OPEN 事件 + 成立通知         |
| 即時資料第 11 筆超標 | 同一 run 變長                         | 1                                | 更新（持續時間 +1）               |
| 出現正常讀值         | run 結束                              | 1                                | 更新為 CLOSED + 結束通知          |
| 同一批重送 3 次      | ingestion 判定全部重複，affected 為空 | —                                | 根本不會呼叫對帳                  |
| 補傳更早的超標       | run 往前延長                          | 1（舊事件的開始時間在新 run 內） | 更新開始時間                      |
| 補傳填滿兩段之間     | 兩個 run 變成一個                     | 2                                | 合併                              |
| 補傳出已結束的歷史段 | 1 個成立 run，end 有值                | 0                                | 新增 CLOSED 事件，成立 + 結束通知 |

## 6.6 正確性的關鍵：冪等

對帳是**收斂的**：同樣的資料跑第二次，偵測結果相同、對應相同，`updateExcursion` 回報沒有變化，
`notify` 被唯一約束忽略，什麼都不會發生。所以「重送」「亂序」「分批」最後都會收斂到同一個狀態。
測試 `excursion-reconciler.test.ts`「同一批資料不論重送幾次」就是驗證這個性質：

```ts
for (let i = 0; i < 3; i++) ctx.pipeline.process(batch);
ctx.pipeline.process([...batch].reverse().slice(0, 8)); // 亂序分批再送一次
ctx.pipeline.process(batch.slice(8));

expect(excursions()).toHaveLength(1);
expect(ctx.notifications.countFor(event.id, 'EXCURSION_STARTED')).toBe(1);
```

## 6.7 一個在寫這份教材時才發現的漏洞

對帳的步驟 3 是「把每個**成立的 run** 對應到既有事件」。反過來想：**有沒有既有事件對應不到任何成立的 run？**

run 通常只會因為新資料而變長或合併。但有一種情況會讓 run **變短**：

```text
分鐘  0    1  …  6    7    8  …  13   14
原本 5.0  9.0 … 9.0  ---  9.0 … 9.0  5.0     第 7 分鐘缺資料（≤ 2 分鐘，視為連續）
                                              → 一個 13 分鐘的 run，成立事件 #1
補傳                 5.0                       第 7 分鐘補傳，是正常讀值
之後 5.0  9.0 … 9.0  5.0  9.0 … 9.0  5.0     → 兩個 6 分鐘的 run，都不成立
```

依照「判定結果 = f(資料)」的原則，現在的資料**不應該有任何事件**。但對帳只處理成立的 run，
事件 #1 對應不到任何 run，於是**維持原狀**：仍是一個 13 分鐘、已結束的事件。

用一個暫時的測試確認了這個行為（`before` 與 `after` 都是 `duration_ms: 780000` 的 CLOSED 事件）。

這是一個很好的教學案例：

1. **對帳要雙向檢查**：「每個結果都有對應的紀錄」之外，還要檢查「每個紀錄都還有對應的結果」。
   只做一個方向的對帳，就只能處理「變多、變長」，處理不了「變少、變短」。
2. **為什麼一般測試沒抓到？** 所有測試情境都是「補傳讓事件變長或合併」。
   要抓到這類問題，需要有人刻意問：「這個操作的**反方向**是什麼？」
3. **修正不只是程式問題，還是需求問題**：事件已經發過通知、可能已經有人填了處置紀錄。
   被資料推翻的事件應該刪除？標記為「撤銷」？處置紀錄怎麼辦？要不要發「撤銷」通知？
   這些都需要需求方決定。

> 目前程式碼**尚未修正**這個問題。它被列為第 10 章的練習題之一。

## 6.8 本章練習

1. 手算：讀值 `1.5, 1.8, 2.0, 1.9, 1.0, 0.5, 1.0, 1.5, 1.8, 1.9, 1.95` 這樣的序列有一個問題，找出來。
   （提示：系統接受的溫度精度是多少？）修正後計算度分鐘與持續時間。
2. 把容忍缺口從 2 分鐘改成 0（任何缺口都切斷），哪些既有測試會失敗？為什麼？
3. 證明（或舉反例）：對帳的視窗只延伸到「最近一筆正常讀值」是足夠的。如果 run 也會被「大缺口」切斷，
   視窗是否需要延伸到最近的大缺口？
4. 設計 6.7 節漏洞的修正：寫出你的需求假設、新的事件狀態（如果需要）、對帳的修改方式，並寫出失敗測試。
