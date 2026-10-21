# ColdTrace 測試報告

| 項目     | 內容                                                             |
| -------- | ---------------------------------------------------------------- |
| 測試日期 | 2026-10-21                                                       |
| 測試版本 | `main`（含本報告的 commit）                                      |
| 結論     | **14 項驗收標準全數通過**；測試中發現 2 個缺陷，已修正並補上測試 |

---

## 1. 摘要

| 測試層級                 | 方法                                                                      | 結果                                          |
| ------------------------ | ------------------------------------------------------------------------- | --------------------------------------------- |
| 乾淨環境建置             | 全新 `git clone` → `npm ci` → lint / format / typecheck / build           | 全數通過                                      |
| 單元與整合測試           | Vitest，90 個測試、21 個檔案                                              | 90 / 90 通過                                  |
| 黑箱驗收                 | `scripts/acceptance.ts` 只透過 HTTP + WebSocket 操作執行中的伺服器（×60） | 12 / 12 通過（連續 2 次）                     |
| 模擬器端對端（加速）     | 16 台 × 150 模擬分鐘、四種情境、結束時自動比對                            | 16 / 16 符合情境，錯誤 0                      |
| 模擬器端對端（真實時間） | 16 台 × 30 分鐘、四種情境                                                 | 14 / 16 符合、2 / 16 依情境尚在斷線中，錯誤 0 |
| 瀏覽器                   | Playwright 操作正式建置的前端：狀態推播、圖表繪製時間                     | 通過                                          |
| Excel                    | 以 Microsoft Excel 實際開啟月報 CSV 並讀回儲存格                          | 中文正常；發現月份被轉成日期，已修正          |
| Code review              | 獨立 reviewer 檢查事件判定、接收、斷線、月報核心邏輯                      | 無高信心缺陷；1 個邊界不一致已修正            |

---

## 2. 測試環境

| 項目          | 版本                                        |
| ------------- | ------------------------------------------- |
| 作業系統      | macOS 27.0（arm64）                         |
| Node.js / npm | 26.9.0 / 11.19.1                            |
| 瀏覽器        | Chromium（Playwright）                      |
| 試算表        | Microsoft Excel for Mac                     |
| CI            | GitHub Actions，Node 22 與 24（推送後執行） |

伺服器時鐘：黑箱驗收、加速模擬與瀏覽器測試使用 `CLOCK_SPEED=60`（真實 1 秒 = 模擬 1 分鐘），
真實時間模擬使用 `CLOCK_SPEED=1`。每項測試使用獨立的 SQLite 資料庫與伺服器，互不干擾。

---

## 3. 測試結果

### 3.1 乾淨環境建置

從 git 將專案 clone 到全新目錄，確保結果不依賴開發機上的任何殘留狀態：

| 步驟                   | 結果                                                          |
| ---------------------- | ------------------------------------------------------------- |
| `npm ci`               | 331 個套件，1 秒完成；無原生模組需要編譯                      |
| `npm run lint`         | 0 error、0 warning（ESLint type-checked、`--max-warnings 0`） |
| `npm run format:check` | 所有檔案符合 Prettier                                         |
| `npm run typecheck`    | 0 error（TypeScript strict、`noUncheckedIndexedAccess`）      |
| `npm run build`        | 成功                                                          |
| `npm test`             | 21 個檔案、90 個測試全數通過                                  |

### 3.2 單元與整合測試（90 個）

| 檔案                                        | 數量 | 涵蓋重點                                                                                          |
| ------------------------------------------- | ---: | ------------------------------------------------------------------------------------------------- |
| `events/excursion-detector.test.ts`         |   10 | 9 / 10 分鐘邊界、2.0 / 8.0 邊界、低溫、度分鐘手算 10.3、缺口 ≤ 2 分鐘、亂序輸入                   |
| `events/excursion-reconciler.test.ts`       |    7 | 即時成立與結束、重送與亂序分批只一則成立通知、補傳往前延長、兩事件合併、歷史事件補傳              |
| `events/offline-service.test.ts`            |    8 | 15 分鐘邊界、從未回報的冷藏櫃、重複掃描只一則通知、補齊正常 / 含超標並關聯 / 不完整、補傳順序無關 |
| `events/coverage.test.ts`                   |    4 | 斷線區間資料完整度                                                                                |
| `ingestion/ingestion.test.ts`               |    8 | 重送 3 次筆數不變、72h / 75h 邊界並列出流水號、未來時間、未知裝置、無綁定、內容衝突不覆寫         |
| `assets/assets.test.ts`                     |    6 | 綁定半開區間、更換溫度計、重疊拒絕、不可改寫歷史、失敗回滾                                        |
| `reports/report-service.test.ts`            |    5 | 手算完整率與合規率、台灣時間月份邊界、綁定期間、CSV 內容                                          |
| `reports/csv.test.ts`                       |    2 | UTF-8 BOM、CRLF、RFC 4180 跳脫                                                                    |
| `http/app.test.ts`                          |    5 | 驗證錯誤、推播內容、處置驗證、更換溫度計 API、404                                                 |
| 其他（infra、seed、web、simulator、shared） |   35 | 時鐘、migration、範例資料、缺口插入、伺服器時鐘推算、裝置緩衝重送、情境驗證、溫度模型、台灣時間   |

完整清單見[附錄](#附錄單元測試清單)。

### 3.3 黑箱驗收（`scripts/acceptance.ts`）

腳本只透過公開的 HTTP API 與 WebSocket 操作一台執行中的伺服器，每次執行都建立獨立的分院、冷藏櫃與溫度計。
同一台伺服器連續執行 2 次，皆為 12 / 12 通過，伺服器錯誤 log 0 筆。

| #   | 項目                          | 證據（第 1 次執行）                                                                                                                     |
| --- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 範例資料                      | 8 間分院、16 台冷藏櫃；C01 歷史 10,081 筆，跨度 7.00 天                                                                                 |
| 2   | 重送 3 次筆數不變             | 首次接受 60；重送 3 次皆 `accepted=0, duplicated=60`；資料庫仍為 60 筆                                                                  |
| 3   | 75 小時前拒收                 | `rejectedCount=3`，明細列出流水號 101、102、103 與原因 `TOO_OLD`；同批新資料正常接受                                                    |
| 4   | 9 分鐘 / 10 分鐘              | 9 分鐘 0 個事件；10 分鐘 1 個事件，持續 10 分鐘，起訖時間正確                                                                           |
| 5   | 累積超標度分鐘                | 手算 0.5+1.0+1.5+2.0+2.0+1.5+1.0+0.5+0.2+0.1 = 10.3；系統 10.3                                                                          |
| 6   | 更換溫度計                    | 舊溫度計 31 筆（含更換後才補傳的 1 筆）＋ 新溫度計 20 筆 = 51 筆，皆歸屬同一冷藏櫃；舊溫度計在更換後時段的資料以 `UNBOUND` 拒收         |
| 7   | 斷線                          | 最後一筆資料後 15.42 模擬分鐘偵測到斷線；儀表板 `status=OFFLINE`；WebSocket 已推播                                                      |
| 8   | 斷線 2 小時補傳含 30 分鐘超標 | 斷線事件 → `BACKFILLED_EXCURSION`；異常事件恰為斷線後第 40–70 分鐘、持續 30 分鐘；雙向關聯；補傳後序列相鄰點間隔皆為 1 分鐘（圖表連續） |
| 9   | 成立通知只一則                | 重送 3 次 + 亂序分批重送後：事件 1 個，成立通知 1 則、結束通知 1 則                                                                     |
| 10  | 狀態推播                      | WebSocket 推播序列 `NORMAL → ALERT → NORMAL`                                                                                            |
| 11  | 24 小時資料量                 | C02 最後 24 小時恰為 1,440 點                                                                                                           |
| 12  | 月報與 CSV                    | 有資料 12、範圍內 2 → 合規率 16.67%、完整率 12 / 196，與手算一致；CSV 以 `EF BB BF` 開頭、CRLF、可嚴格 UTF-8 解碼、`charset=utf-8`      |

### 3.4 模擬器端對端

四種情境同時執行：`door-open`（TM-0001、TM-0002）、`compressor-failure`（TM-0003、TM-0004）、
`offline-backfill`（TM-0007、TM-0010），其餘 10 支為 `normal`。模擬器結束時查詢後端事件，逐台比對情境預期。

**加速（×60，150 模擬分鐘）**

```
上傳 2656 筆：接受 2656、重複 0、拒收 0；上傳錯誤 0 次
情境開始後經過 149 分鐘（模擬時間），事件判定結果：
  ✅ TM-0001（C01，door-open）：無事件（符合預期）
  ✅ TM-0002（C02，door-open）：無事件（符合預期）
  ✅ TM-0003（C03，compressor-failure）：溫度異常事件 #25
  ✅ TM-0004（C04，compressor-failure）：溫度異常事件 #26
  ✅ TM-0007（C07，offline-backfill）：斷線 #23 補傳後產生 30 分鐘異常 #27 並互相關聯
  ✅ TM-0010（C10，offline-backfill）：斷線 #24 補傳後產生 30 分鐘異常 #28 並互相關聯
  ✅ 其餘 10 支 normal：無事件（符合預期）
伺服器錯誤 log：0 筆
```

**真實時間（×1，30 分鐘，20:12:34 – 20:42:00）**

```
上傳 422 筆：接受 422、重複 0、拒收 0；上傳錯誤 0 次
情境開始後經過 28 分鐘（模擬時間），事件判定結果：
  ✅ TM-0001（C01，door-open）：無事件（符合預期）
  ✅ TM-0002（C02，door-open）：無事件（符合預期）
  ✅ TM-0003（C03，compressor-failure）：溫度異常事件 #9
  ✅ TM-0004（C04，compressor-failure）：溫度異常事件 #10
  ⏳ TM-0007（C07，offline-backfill）：斷線中（事件 #7），等待 2 小時後補傳
  ⏳ TM-0010（C10，offline-backfill）：斷線中（事件 #8），等待 2 小時後補傳
  ✅ 其餘 10 支 normal：無事件（符合預期）
伺服器錯誤 log：0 筆
```

`offline-backfill` 情境在第 2 小時才補傳，30 分鐘內的正確狀態就是「斷線中」，模擬器判定為待定（⏳）而非失敗；
補傳之後的判定已由加速測試與黑箱 #8 驗證。驗收 #13 要求的「16 台 30 分鐘後端無錯誤、事件判定與情境相符」成立。

### 3.5 瀏覽器

使用正式建置（`npm run build`）並由後端提供的前端頁面。

**驗收 #10：不重新整理頁面看到狀態變化**

開啟儀表板後注入 `MutationObserver` 記錄冷藏櫃狀態標籤的每一次變化，並記錄一個隨機 `loadId`。
測試結束時 `loadId` 不變，證明頁面從未重新載入。

| 冷藏櫃 | 情境              | 畫面狀態變化                           |
| ------ | ----------------- | -------------------------------------- |
| C03    | 壓縮機故障        | 正常 → 斷線 → 正常 → **異常 → 正常**   |
| C10    | 斷線 2 小時後補傳 | 正常 → 斷線 → 正常 → **斷線 → 正常**   |
| C01    | 開門              | 正常 → 斷線 → 正常（從未出現「異常」） |

三台開頭短暫的「斷線」是測試程序造成：伺服器啟動後約 20 秒（×60 即 20 模擬分鐘）才啟動模擬器，
期間確實沒有資料；模擬器啟動後補傳，1 秒內恢復。這也驗證了斷線 → 補傳 → 恢復的畫面流程。

**驗收 #11：24 小時圖表 1 秒內完成繪製**

逐一點選 16 台冷藏櫃（每台約 1,415 點）量測兩種時間：

| 量測                                         |  平均 |  最慢 |     標準 |
| -------------------------------------------- | ----: | ----: | -------: |
| 圖表繪製（ECharts `setOption` → `finished`） |  7 ms | 28 ms |        — |
| 點擊到完成繪製（含 API 取資料）              | 21 ms | 47 ms | 1,000 ms |

最慢的一次為第一台，包含 ECharts 初始化。

### 3.6 Excel 開啟月報 CSV

以 AppleScript 驅動 Microsoft Excel 開啟兩個 CSV 檔，讀回儲存格的**顯示文字**（`string value`）：

| 檔案     | 儲存格  | Excel 顯示                                                                                |
| -------- | ------- | ----------------------------------------------------------------------------------------- |
| 摘要     | 第 1 列 | 月份、分院、資料完整率(%)、溫度合規率(%)                                                  |
| 摘要     | 第 2 列 | 2026年10月、台北分院、疫苗冷藏櫃 A、100、99.81                                            |
| 事件清單 | 第 1 列 | 類型、狀態、處置人、處置說明                                                              |
| 事件清單 | 第 2 列 | 溫度異常、新北分院、已結束、王護理師、壓縮機故障，疫苗已移至備用冷藏櫃，已聯絡廠商維修。… |

中文欄名與內容（含全形標點）皆正確顯示，無亂碼。時間欄被 Excel 正確辨識為日期時間
（預設欄寬不足時顯示 `##########`，調寬欄位即可）。

修正前，月份欄的 `2026-10` 被 Excel 自動轉成日期並**顯示為「Oct-26」**（見第 5 節缺陷 #2）。
另測試四種寫法的顯示結果後，改為「2026年10月」：

| CSV 內容     | Excel 顯示 |
| ------------ | ---------- |
| `2026-10`    | Oct-26     |
| `2026年10月` | 2026年10月 |

---

## 4. 驗收標準逐項對照

| #   | 驗收標準                                                                          | 驗證方式                                                                            | 結果 |
| --- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---- |
| 1   | `npm install` + 一個啟動指令，前後端開啟，範例資料（8 分院、16 櫃、≥ 7 天）已載入 | 乾淨 clone `npm ci`；空資料庫 `npm run dev` 自動產生範例資料並啟動三個程序；黑箱 #1 | ✅   |
| 2   | 同一批資料重送 3 次，資料筆數不變，並有測試                                       | `ingestion.test.ts`；黑箱 #2                                                        | ✅   |
| 3   | 75 小時前資料拒收，回應列出筆數與流水號                                           | `ingestion.test.ts`；黑箱 #3                                                        | ✅   |
| 4   | 超標 9 分鐘不產生、10 分鐘產生事件，需有測試                                      | `excursion-detector.test.ts`、`excursion-reconciler.test.ts`；黑箱 #4               | ✅   |
| 5   | 累積超標度分鐘與手算一致                                                          | `excursion-detector.test.ts`；黑箱 #5                                               | ✅   |
| 6   | 更換溫度計後資料歸屬正確，並有測試                                                | `assets.test.ts`、`app.test.ts`；黑箱 #6                                            | ✅   |
| 7   | 停止送資料 15 分鐘產生斷線事件，儀表板顯示斷線                                    | `offline-service.test.ts`；黑箱 #7；瀏覽器 3.5                                      | ✅   |
| 8   | 斷線 2 小時補傳含 30 分鐘超標：時間正確、相互關聯、圖表連續                       | `offline-service.test.ts`；黑箱 #8；模擬器 3.4                                      | ✅   |
| 9   | 「事件成立」通知只有一則，並有測試                                                | `excursion-reconciler.test.ts`；黑箱 #9；模擬器資料庫檢查                           | ✅   |
| 10  | 不重新整理看到 正常 → 異常 → 正常                                                 | 黑箱 #10（WebSocket）；瀏覽器 3.5（畫面）                                           | ✅   |
| 11  | 1,440 點 1 秒內完成繪製                                                           | 黑箱 #11（點數）；瀏覽器 3.5（最慢 47 ms）                                          | ✅   |
| 12  | 合規率、完整率與手算一致；CSV 用 Excel 開啟中文不亂碼                             | `report-service.test.ts`、`csv.test.ts`；黑箱 #12；Excel 3.6                        | ✅   |
| 13  | 16 台 30 分鐘後端無錯誤，事件判定與情境相符                                       | 模擬器 3.4（加速 150 分鐘與真實 30 分鐘）                                           | ✅   |
| 14  | 單元測試 ≥ 30 個，`npm test` 全數通過，lint 無錯誤                                | 90 個測試；乾淨環境 3.1                                                             | ✅   |

---

## 5. 測試中發現的缺陷

| #   | 缺陷                                                                                      | 發現方式       | 處置                                                   |
| --- | ----------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------ |
| 1   | 從未回報過的冷藏櫃在綁定後第 14 分鐘就判定斷線，與「超過 15 分鐘」的規則不一致            | Code review    | 先寫失敗測試，改以綁定時間起算（commit `0947ac4`）     |
| 2   | 月報 CSV 的月份 `2026-10` 被 Excel 自動轉成日期，顯示為「Oct-26」，容易誤讀成 10 月 26 日 | Excel 實際開啟 | 先改測試，月份改寫為「2026年10月」（commit `5de55e7`） |

開發過程中另以畫面與資料庫檢查發現並修正：範例資料的斷線長度因批次送出而多算 4 分鐘、
範例資料綁定起點早於資料起點導致完整率失真（87%）。這兩項都是範例資料產生方式的問題，不是判定邏輯的錯誤。

---

## 6. 未涵蓋與限制

- **程式碼覆蓋率**：未量測（需額外引入 `@vitest/coverage-v8`）。
- **Node 22 / 24**：本機僅以 Node 26 測試；Node 22 與 24 由推送後的 GitHub Actions CI 驗證。
- **瀏覽器自動化**：Playwright 測試以互動方式執行，未寫成可重複執行的 E2E 測試檔（題目列為選做）。
- **長時間負載**：未做 2 年資料量（約 1,680 萬筆）的效能測試；容量依設計文件估算。
- 系統本身的已知限制見 [README「已知限制」](../README.md#已知限制)。

---

## 7. 重現方式

```bash
# 靜態檢查與單元測試
npm ci && npm run lint && npm run format:check && npm run typecheck && npm test

# 黑箱驗收（終端機 1 啟動 ×60 伺服器，終端機 2 執行）
CLOCK_SPEED=60 COLDTRACE_DB=/tmp/acceptance.db PORT=3200 npm start -w @coldtrace/server
npm run acceptance -- http://localhost:3200

# 模擬器端對端（加速）
CLOCK_SPEED=60 COLDTRACE_DB=/tmp/sim.db PORT=3100 npm start -w @coldtrace/server
npm run simulator -- --api http://localhost:3100 --duration 150m --incident-after 1m \
  --override TM-0001=door-open --override TM-0002=door-open \
  --override TM-0003=compressor-failure --override TM-0004=compressor-failure \
  --override TM-0007=offline-backfill --override TM-0010=offline-backfill

# 模擬器端對端（真實時間 30 分鐘）：同上，伺服器不設 CLOCK_SPEED，模擬器改為 --duration 30m
```

---

## 附錄：單元測試清單

**`apps/server/src/http/app.test.ts`**（5）

- HTTP API 批次上傳回傳接收結果，格式錯誤回 400
- HTTP API 更換溫度計 API：新舊裝置資料歸屬同一冷藏櫃
- HTTP API 未知路徑與不存在的事件回 404
- HTTP API 異常成立後推播通知與冷藏櫃狀態，儀表板顯示異常
- HTTP API 處置紀錄：驗證報廢數量，成功後可在事件詳情看到

**`apps/server/src/infra/clock.test.ts`**（3）

- Clock FixedClock 只在 advance 時前進
- Clock ScaledClock 以倍率流逝
- Clock ScaledClock 拒絕非正數倍率

**`apps/server/src/infra/migrate.test.ts`**（2）

- migrate 依序套用且重複執行不會重套
- migrate 失敗的 migration 整筆回滾

**`apps/server/src/modules/assets/assets.test.ts`**（6）

- AssetService 依量測時間解析到綁定中的冷藏櫃
- AssetService 同一台冷藏櫃不可同時綁定兩支裝置
- AssetService 同一支裝置不可同時綁定兩台冷藏櫃
- AssetService 更換失敗時不留下半套綁定
- AssetService 更換時間不可早於已收到的最後一筆資料（不改寫歷史歸屬）
- AssetService 更換溫度計後，新舊裝置依量測時間各自歸屬（半開區間）

**`apps/server/src/modules/events/coverage.test.ts`**（4）

- isFullyCovered 中間缺 3 分鐘 → 不完整
- isFullyCovered 容忍 2 分鐘以內的缺口
- isFullyCovered 尾端缺資料同樣不完整
- isFullyCovered 每分鐘都有資料 → 完整

**`apps/server/src/modules/events/excursion-detector.test.ts`**（10）

- detectExcursionRuns 低溫超標同樣成立事件，並記錄最高與最低溫
- detectExcursionRuns 全部在範圍內時沒有任何連續段
- detectExcursionRuns 剛好 2.0 與 8.0 不算超標
- detectExcursionRuns 累積超標度分鐘與手算一致
- detectExcursionRuns 缺資料 2 分鐘就切斷為兩段
- detectExcursionRuns 資料到此仍在超標中 → end 為 null
- detectExcursionRuns 超標 10 分鐘 → 成立事件，記錄起訖時間
- detectExcursionRuns 超標 9 分鐘後回到範圍 → 不成立事件
- detectExcursionRuns 輸入順序不影響結果（補傳亂序）
- detectExcursionRuns 連續段中缺資料 ≤ 2 分鐘仍視為連續，但缺口不累計度分鐘

**`apps/server/src/modules/events/excursion-reconciler.test.ts`**（7）

- ExcursionReconciler（經由 ReadingPipeline） 其他冷藏櫃的資料不影響本櫃事件
- ExcursionReconciler（經由 ReadingPipeline） 即時資料：第 10 分鐘成立、回到範圍時結束，各一則通知
- ExcursionReconciler（經由 ReadingPipeline） 同一批資料不論重送幾次，「事件成立」通知只有一則
- ExcursionReconciler（經由 ReadingPipeline） 補傳出已結束的歷史事件：標記為補傳，成立與結束通知各一則
- ExcursionReconciler（經由 ReadingPipeline） 補傳填滿兩段之間的缺口，兩個事件合併為一個
- ExcursionReconciler（經由 ReadingPipeline） 補傳更早的超標資料，事件往前延長而不是新增
- ExcursionReconciler（經由 ReadingPipeline） 超標 9 分鐘後回到範圍，不產生事件也不發通知

**`apps/server/src/modules/events/offline-service.test.ts`**（8）

- OfflineService 從未回報的冷藏櫃，自綁定起超過 15 分鐘才判斷線
- OfflineService 恢復連線後的補傳判定（斷線 2 小時） 只送即時資料 → 資料不完整；之後補傳完成 → 已補齊
- OfflineService 恢復連線後的補傳判定（斷線 2 小時） 補傳資料全部正常 → 已補齊、溫度正常
- OfflineService 恢復連線後的補傳判定（斷線 2 小時） 補傳資料含 30 分鐘超標 → 產生時間正確的異常事件並互相關聯
- OfflineService 恢復連線後的補傳判定（斷線 2 小時） 補傳順序（新到舊、分批）不影響最終結果
- OfflineService 最後一筆資料後滿 15 分鐘不觸發，超過 15 分鐘才成立斷線事件
- OfflineService 沒有綁定中裝置的冷藏櫃不判斷線
- OfflineService 重複掃描只會有一個斷線事件與一則通知

**`apps/server/src/modules/ingestion/ingestion.test.ts`**（8）

- IngestionService 75 小時前的資料被拒收，並列出筆數與流水號
- IngestionService 剛好 72 小時前的資料仍接受
- IngestionService 同一批資料重送 3 次，資料筆數不變
- IngestionService 同流水號但內容不同時，不覆寫原始紀錄並回報衝突
- IngestionService 回報各冷藏櫃實際新增資料的時間範圍
- IngestionService 未知裝置與無綁定期間的資料分別拒收
- IngestionService 溫度不是小數一位時拒收
- IngestionService 超前伺服器 5 分鐘以上的資料視為時鐘異常拒收

**`apps/server/src/modules/reports/csv.test.ts`**（2）

- toCsv 以 UTF-8 BOM 開頭、CRLF 換行（Excel 開啟中文不亂碼）
- toCsv 含逗號、引號、換行的欄位加引號並跳脫

**`apps/server/src/modules/reports/report-service.test.ts`**（5）

- 月報 CSV 列出摘要與事件清單
- 月報 computeRates：手算範例（設計文件 §9.2）
- 月報 整月：44,640 應有分鐘、44,000 有資料、其中 220 分鐘超標
- 月報 月份邊界以台灣時間切分，月外資料不計入
- 月報 當月未結束只算到現在；綁定前的時間不列入應有分鐘

**`apps/server/src/realtime/retention.test.ts`**（1）

- purgeExpiredReadings 只刪除超過兩年的量測資料

**`apps/server/src/seed/seed.test.ts`**（1）

- seedSampleData 產生 8 間分院、16 台冷藏櫃、7 天資料，並包含預埋事件

**`apps/simulator/src/device.test.ts`**（4）

- SimulatedDevice 上傳失敗時保留資料，下次重送
- SimulatedDevice 壓縮機故障情境在 30 分鐘內超標達 10 分鐘以上
- SimulatedDevice 斷線期間緩衝，恢復後依序補傳
- SimulatedDevice 流水號延續既有值、每分鐘一筆

**`apps/simulator/src/verify.test.ts`**（3）

- verifyScenario 壓縮機故障：時間未到時為待定，時間到仍無事件則失敗
- verifyScenario 斷線補傳：檢查狀態、異常時間、持續時間與關聯
- verifyScenario 開門情境不應產生事件

**`apps/web/src/lib/format.test.ts`**（4）

- format 持續時間
- format 斷線事件狀態標籤
- format 溫度顯示小數一位
- format 相對時間

**`apps/web/src/lib/series.test.ts`**（3）

- insertGaps 連續資料不插入缺口，溫度轉回 °C
- insertGaps 間隔超過 3 分鐘時插入 null 讓線條中斷
- mergePoints 去重、排序並修剪視窗外資料

**`apps/web/src/server-clock.test.ts`**（1）

- estimateServerNow 依倍率推算伺服器時間

**`packages/shared/src/constants.test.ts`**（3）

- 溫度範圍 2.0 與 8.0 本身算在範圍內
- 溫度範圍 toX10 消除浮點誤差
- 溫度範圍 超出量分別計算高溫與低溫

**`packages/shared/src/temperature-model.test.ts`**（6）

- TemperatureModel plateau 精準控制超標分鐘數
- TemperatureModel 壓縮機故障 120 分鐘：超標超過 1 小時
- TemperatureModel 情境開始前不影響溫度
- TemperatureModel 正常情境維持在 2–8°C 且為小數一位
- TemperatureModel 相同 seed 產生相同序列
- TemperatureModel 開門 5 分鐘：短暫超標但少於 10 分鐘

**`packages/shared/src/time.test.ts`**（4）

- formatTaipei 以台灣時間顯示
- parseMonth 拒絕格式錯誤的月份
- taipeiMonthRange 以台灣時間 (UTC+8) 切月份邊界
- taipeiMonthRange 跨年的 12 月
