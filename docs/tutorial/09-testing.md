# 第 09 章　測試策略：讓「等 2 小時」在 2 毫秒內測完

> 這個系統的業務規則幾乎都和時間有關：10 分鐘、15 分鐘、72 小時、2 小時斷線、一個月的報表。
> 如果時間不能控制，這些規則就幾乎不能測。本章說明本專案怎麼分層測試，以及可注入時鐘如何讓這一切變得可能。

## 9.1 測試分層

```text
                    ┌──────────────────────────┐
                    │ 瀏覽器實測（Playwright）    │  畫面更新、繪製時間、Excel 開 CSV
                  ┌─┴──────────────────────────┴─┐
                  │ 真實時間 30 分鐘、16 台模擬器    │  驗收 #13
                ┌─┴──────────────────────────────┴─┐
                │ 加速模擬：模擬器自動驗收（×60）      │  4 種情境，結束時自動比對事件
              ┌─┴──────────────────────────────────┴─┐
              │ 黑箱驗收 scripts/acceptance.ts（×60）    │  只用 HTTP + WebSocket 驗證 12 條
            ┌─┴──────────────────────────────────────┴─┐
            │ HTTP 測試：app.inject()，不開 port            │  驗證錯誤、推播內容、API 契約
          ┌─┴──────────────────────────────────────────┴─┐
          │ 整合測試：:memory: DB + FixedClock + 完整 pipeline │  對帳、斷線、補傳、月報
        ┌─┴──────────────────────────────────────────────┴─┐
        │ 單元測試：純函數                                      │  偵測、覆蓋率、缺口、CSV、時間
        └──────────────────────────────────────────────────┘
```

越下層越快、越多、越精確；越上層越接近真實使用、越少、越慢。103 個 Vitest 測試涵蓋下面三層，
整套執行約 3 秒；上面四層在交付前執行，結果記錄在[測試報告](../test-report.md)。

| 層       | 回答的問題                                       |
| -------- | ------------------------------------------------ |
| 單元     | 這個演算法對嗎？                                 |
| 整合     | 這些元件組合起來、經過資料庫之後還對嗎？         |
| HTTP     | API 的輸入輸出符合契約嗎？                       |
| 黑箱驗收 | 從外部看，驗收標準有被滿足嗎？（不知道內部實作） |
| 模擬器   | 在接近真實的負載與時序下，判定結果符合情境嗎？   |
| 真實時間 | 沒有加速時，有沒有只在真實時間才會出現的問題？   |
| 瀏覽器   | 使用者看到的是對的嗎？                           |

## 9.2 可注入時鐘：測試時間邏輯的關鍵

```ts
export class FixedClock implements Clock {
  readonly speed = 1;
  constructor(private current: number) {}
  now(): number {
    return this.current;
  }
  set(epochMs: number): void {
    this.current = epochMs;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}
```

有了 `FixedClock`，「剛好 15 分鐘不成立、多 30 秒就成立」可以精確到毫秒：

```ts
ctx.clock.set(at(9) + 15 * MINUTE_MS);
ctx.offline.scan(ctx.clock.now());
expect(eventsOf('OFFLINE')).toHaveLength(0);

ctx.clock.advance(30 * SECOND_MS);
ctx.offline.scan(ctx.clock.now());
expect(eventsOf('OFFLINE')).toHaveLength(1);
```

同一個介面的三種實作，分別服務三個場合：

| 實作          | 場合                   | 例子                                         |
| ------------- | ---------------------- | -------------------------------------------- |
| `FixedClock`  | 單元與整合測試         | 精確控制邊界                                 |
| `ScaledClock` | 黑箱驗收、展示         | `CLOCK_SPEED=60`，「斷線 2 小時」只要 2 分鐘 |
| `SystemClock` | 正式環境、真實時間測試 | 驗收 #13 的 30 分鐘測試                      |

> 前提是業務程式碼**完全不直接呼叫 `Date.now()`**。只要有一處漏掉，那個地方就無法測試，
> 加速展示時也會出現奇怪的行為。

## 9.3 測試輔助工具：讓測試讀起來像規格

`apps/server/src/test/` 提供三個層次的輔助：

```ts
// helpers.ts：一個已套用 migration 的記憶體資料庫
export function createTestDb(): Db {
  /* openDb(':memory:') + migrate */
}

// fixtures.ts：標準測試資料與讀值產生器
export function seedBasicAssets(db: Db): AssetService {
  /* 一間分院、C01/C02、TM-01/TM-02 */
}
export function series(deviceId, start, temps: number[], firstSeq = 1): ReadingInput[] {
  /* 每分鐘一筆 */
}
export const repeat = (value: number, times: number) => Array(times).fill(value);

// context.ts：組裝好整條 pipeline，與 services.ts 相同的組裝方式
export function createTestContext() {
  /* db, clock, assets, pipeline, offline, notifications... */
}
```

於是一個整合測試可以這樣寫：

```ts
it('補傳更早的超標資料，事件往前延長而不是新增', () => {
  ctx.clock.set(at(25));
  ctx.pipeline.process(series('TM-01', at(5), repeat(9, 15), 6));
  const [before] = excursions();
  expect(before?.started_at).toBe(at(5));

  ctx.pipeline.process(series('TM-01', at(0), [5, ...repeat(9, 4)], 1));   // 補傳更早的資料
  expect(excursions()).toMatchObject([
    { id: before?.id, started_at: at(1), duration_ms: 19 * MINUTE_MS },
  ]);
});
});
```

- `repeat(9, 15)` 比 `[9,9,9,9,9,9,9,9,9,9,9,9,9,9,9]` 清楚得多，數錯一個 9 就是 9 分鐘與 10 分鐘的差別。
- `at(5)` 讓時間讀起來是「第 5 分鐘」，而不是 `1790783700000`。
- **測試名稱用中文寫成一句規格**，失敗時的訊息就直接說明了哪條規則被破壞。

## 9.4 HTTP 測試：不開 port

```ts
// apps/server/src/http/app.test.ts
const invalid = await app.inject({
  method: 'POST',
  url: `/api/events/${event!.id}/dispositions`,
  payload: { handler: '王護理師', note: '移櫃', vaccineDiscarded: true, discardedQty: 0 },
});
expect(invalid.statusCode).toBe(400); // 報廢時數量必須 > 0

const created = await app.inject({/* 同上，discardedQty: 5 */});
expect(created.statusCode).toBe(201);
```

`app.inject()` 走完整的 Fastify 處理流程（路由、驗證、錯誤處理），但不經過網路，和單元測試一樣快。

## 9.5 黑箱驗收：不看實作的測試

`scripts/acceptance.ts` 對一台**執行中的伺服器**，只透過公開的 HTTP API 與 WebSocket 逐條驗證驗收標準：

```text
✅ #1 範例資料：8 間分院、16 台冷藏櫃、≥ 7 天歷史
✅ #2 同一批資料重送 3 次，資料筆數不變
...
✅ #8 斷線 2 小時後補傳且含 30 分鐘超標：事件時間正確、相互關聯、圖表連續
...
結果：12/12 項通過
```

設計重點：

- **每次執行建立獨立的分院、冷藏櫃、溫度計**（名稱帶有隨機的執行代號），可以對同一台伺服器重複執行，互不干擾。
- 時間一律以**伺服器時間**計算（先呼叫 `/api/system/clock`），所以搭配 `CLOCK_SPEED=60`
  時，「停止送資料 15 分鐘」只需要約 15 秒。
- 它不 import 任何後端程式碼，只 import 共用的型別。如果後端重構了內部實作，這個腳本不需要改。

> **一次真實的誤用**：在撰寫第 10 章的修正時，曾經用 `CLOCK_SPEED=1` 跑這個腳本，
> #7、#8 因為要等真實的 15 分鐘而逾時。改用腳本開頭註明的 `CLOCK_SPEED=60` 後 12/12 通過。
> 測試失敗時，**先確認測試環境符合前提**，再懷疑程式。

## 9.6 模擬器：會自己驗收的負載產生器

模擬器不只是產生資料的工具。它在結束時查詢後端的事件，與每台裝置的情境比對：

```text
上傳 2656 筆：接受 2656、重複 0、拒收 0；上傳錯誤 0 次
情境開始後經過 149 分鐘（模擬時間），事件判定結果：
  ✅ TM-0001（C01，door-open）：無事件（符合預期）
  ✅ TM-0003（C03，compressor-failure）：溫度異常事件 #25
  ✅ TM-0007（C07，offline-backfill）：斷線 #23 補傳後產生 30 分鐘異常 #27 並互相關聯
  ...
```

`verify.ts` 的判定是純函數 `verifyScenario(情境, 事件, 經過分鐘數)`，有自己的單元測試。
時間還不夠判定時回傳 `pending`（⏳），例如斷線補傳情境在 2 小時內只能看到「斷線中」。

情境的溫度曲線也是純函數（`temperature-model.ts`），使用**確定性亂數**（mulberry32，固定種子），
每次執行產生相同的資料，失敗時可以重現。

## 9.7 TDD 實例：修正外部 review 找到的 bug

第 10 章的兩個 bug 都依照「先寫失敗測試，再修正」的流程處理。以「同一時間點換流水號重送」為例：

**Red**：把 review 描述的情境寫成測試，確認它真的失敗，而且失敗的方式符合描述：

```ts
it('同一時間點換流水號重送，累積超標度分鐘與持續時間不變', () => {
  ctx.clock.set(at(20));
  const temps = [5, ...repeat(9, 12), 5];
  ctx.pipeline.process(series('TM-01', at(0), temps, 1));
  const [before] = excursions();
  expect(before).toMatchObject({ degree_minutes_x10: 120, duration_ms: 12 * MINUTE_MS });

  const result = ctx.pipeline.process(series('TM-01', at(0), temps, 1001)); // 新流水號
  expect(result.response).toMatchObject({ accepted: 0, duplicated: 14 });
  // ...
});
```

```text
× 同一時間點換流水號重送，累積超標度分鐘與持續時間不變
AssertionError: expected { accepted: 14, duplicated: +0, … } to match object { accepted: +0, duplicated: 14 }
```

**Green**：新增 migration v2（唯一索引）與接收時的重複判斷，測試通過。

**全套確認**：跑完全部測試、lint、typecheck，再跑一次黑箱驗收，確認沒有破壞其他驗收標準。

> 為什麼先寫測試？因為「我覺得修好了」和「我證明了修好了」是兩回事。
> 先看到測試失敗，才能確定這個測試**真的有在檢查這個 bug**，而不是一個永遠會通過的測試。

## 9.8 CI

`.github/workflows/ci.yml` 在 Node 22 與 24 上執行：lint → format check → typecheck → test → build。
Node 22 是 `engines` 宣告的最低版本，24 是目前的 LTS。只在開發機的 Node 26 上測試，
就無法保證「Node 22 以上」這個承諾。

## 9.9 本章練習

1. 找出 `apps/server/src` 中所有直接呼叫 `Date.now()` 的地方（`grep -rn "Date.now" apps/server/src`）。
   你會找到 `clock.ts`（`SystemClock` 本身）與 `seed/cli.ts`（命令列工具的進入點）。
   為什麼這兩處可以接受？如果在 `modules/` 底下找到一處，會造成什麼問題？
2. 第 06 章 6.7 節的修正附了一個「事件結束後繼續送正常資料」的回歸測試。暫時拿掉「開始時間落在視窗內」的條件，
   觀察哪個測試失敗。這種「故意改壞程式、確認測試會抓到」的做法叫做 **mutation testing**。
3. 黑箱驗收腳本如果要驗證 #10（畫面上看到 正常 → 異常 → 正常），只用 WebSocket 夠嗎？還缺什麼？
4. 設計一個「屬性測試」（property-based test）：隨機產生讀值序列與隨機的分批、亂序方式，
   驗證最終事件與「一次送完」的結果相同。在第 06 章 6.7 節修正之前，這個測試能抓到那個漏洞嗎？
   （提示：隨機產生器要多常產生「缺口 ≤ 2 分鐘、之後補上正常讀值」的情況？）
