# ColdTrace 系統分析與架構設計（草案 v0.1）

> 狀態：已確認（2026-10-21），§19 所有待確認事項皆採建議方案。

---

## 1. 問題本質

這個系統表面上是「收資料 → 畫圖」，真正難的是三件事：

1. **資料會亂序、會重送、會晚到 72 小時**：事件判定不能依賴「資料抵達的順序」，必須是「量測資料時間序列」的純函數，否則補傳一來，結果就會不一樣。
2. **事件要冪等**：同一段超標，不論資料怎麼重送、怎麼分批補傳，最後都只能有一個事件、一則「成立」通知。
3. **斷線與補傳要能互相解釋**：斷線事件在當下成立（我們不知道溫度），補傳之後要能回頭判定這段期間到底發生什麼事。

設計核心因此是：**「判定結果 = f(量測資料)」，資料庫只是把 f 的結果 reconcile（對帳）進去**。

---

## 2. 名詞定義（Ubiquitous Language）

| 名詞         | 英文 / 程式命名 | 說明                                             |
| ------------ | --------------- | ------------------------------------------------ |
| 分院         | `Branch`        | 8 間                                             |
| 冷藏櫃       | `Cabinet`       | 每間分院 2 台，事件與報表的歸屬主體              |
| 溫度計       | `Device`        | IoT 裝置，可更換                                 |
| 綁定         | `Binding`       | 裝置與冷藏櫃在 `[boundFrom, boundTo)` 期間的關係 |
| 量測         | `Reading`       | 一筆 = 一分鐘樣本，唯一鍵 `(deviceId, seq)`      |
| 溫度異常事件 | `Excursion`     | 連續超標 ≥ 10 分鐘                               |
| 斷線事件     | `Offline`       | 冷藏櫃 > 15 分鐘無資料                           |
| 處置紀錄     | `Disposition`   | 事件的人工處理紀錄                               |
| 通知         | `Notification`  | 唯一鍵 `(eventId, kind)`                         |

---

## 3. 系統架構

```
 ┌──────────────┐   POST /api/readings/batch    ┌────────────────────────── Server (Fastify) ──────────────────────────┐
 │  Simulator   │ ─────────────────────────────▶│                                                                        │
 │ (16 devices, │   (離線時本機緩衝，恢復後補傳)  │  ① Ingestion        ② Event Engine            ③ Notification          │
 │  4 scenarios)│                               │  ─ 驗證 / 72h 檢查    ─ ExcursionDetector(純函數)  ─ INSERT OR IGNORE     │
 └──────────────┘                               │  ─ 綁定解析→cabinet   ─ Reconciler(對帳寫入事件)   (eventId, kind)      │
                                                │  ─ INSERT OR IGNORE   ─ OfflineMonitor(排程)      ─ 新增成功才推播       │
                                                │        │                    ▲          │                  │            │
                                                │        └── 同一個 transaction ┘          │                  ▼            │
                                                │                                        └──────▶  ④ Domain Event Bus     │
                                                │   Clock (可注入: System / Fixed / Scaled)            │                  │
                                                │                                                       ▼                  │
                                                │   SQLite (WAL) + migrations             ⑤ WebSocket Hub (/ws)           │
                                                └───────────────────────────────────────────────────────┬──────────────────┘
                                                                                                        │ cabinet.status
                                                 REST: 查詢 / 事件處置 / 月報 / CSV                      │ series.changed
                                                        ▲                                               │ notification.created
                                                        │                                               ▼
                                                ┌──────────────── Web (React + Vite) ──────────────────────────┐
                                                │ 儀表板（依分院分組）│ 24h 圖表 │ 事件列表/處置 │ 月報 │ 設備管理 │
                                                └──────────────────────────────────────────────────────────────┘
```

**資料流（單一批次）**：

1. 驗證 payload → 逐筆檢查（72h、未來時間、未知裝置、無綁定）。
2. 依 `measuredAt` 找出當時的綁定 → 決定 `cabinetId`（寫入時就決定，之後查詢不必再 join 綁定表）。
3. `INSERT OR IGNORE` 寫入；記錄「實際新增」的筆數與各冷藏櫃受影響的時間範圍。
4. 對每個受影響冷藏櫃，重算該時段的異常事件並對帳（見 §5.3）。
5. 重新評估與該時段重疊的斷線事件（補傳判定，見 §6）。
6. 以上全部在**同一個 SQLite transaction** 內完成；commit 後才把 domain events 丟給 WebSocket。

> `better-sqlite3` / `node:sqlite` 都是同步 API，Node 單執行緒下每個批次天然串行，
> 不需要額外的鎖就能避免「兩個批次同時判定同一段超標」的 race condition。

---

## 4. 量測資料接收

### 4.1 API

```http
POST /api/readings/batch
{ "readings": [ { "deviceId": "TM-0001", "seq": 1024, "measuredAt": "2026-10-21T10:00:00+08:00",
                  "temperature": 4.3, "battery": 87 } ] }
```

回應一律 `200`（部分成功是正常情況），只有整包格式錯誤才 `400`：

```json
{
  "accepted": 58,
  "duplicated": 2,
  "rejected": [{ "seq": 17, "deviceId": "TM-0001", "reason": "TOO_OLD" }],
  "rejectedCount": 1
}
```

### 4.2 規則與邊界

| 情況                               | 處理                                                        |
| ---------------------------------- | ----------------------------------------------------------- |
| `(deviceId, seq)` 已存在且內容相同 | `duplicated`，不寫入                                        |
| `(deviceId, seq)` 已存在但內容不同 | `duplicated` 並記 warning log（不覆寫，原始紀錄具法遵意義） |
| `measuredAt < now − 72h`           | 拒收 `TOO_OLD`（剛好 72h 收；75h 拒收）                     |
| `measuredAt > now + 5min`          | 拒收 `FROM_FUTURE`（防止裝置時鐘異常污染資料）              |
| 未知 `deviceId`                    | 拒收 `UNKNOWN_DEVICE`                                       |
| 量測時間不在任何綁定期間           | 拒收 `UNBOUND`                                              |
| 溫度非小數一位                     | 拒收 `INVALID_TEMPERATURE`                                  |
| 單批上限                           | 1,000 筆（72h 補傳 = 4,320 筆，由裝置分批送）               |

### 4.3 溫度以「整數 0.1°C」儲存

`4.3°C` 存成 `43`。累積超標度分鐘也用整數（0.1 度分鐘）累加，避免 `0.1 + 0.2 ≠ 0.3` 造成驗收 #5 對不上手算結果。

---

## 5. 溫度異常事件判定

### 5.1 判定規則

- **超標讀值**：`temp < 2.0` 或 `temp > 8.0`（2.0、8.0 本身算正常）。
- **一筆讀值代表 1 分鐘**：`[measuredAt, measuredAt + 1min)`。
- **超標連續段（run）**：時間序上相鄰的超標讀值，中間沒有正常讀值。
- **持續時間** = 最後一筆超標讀值 + 1 分鐘 − 第一筆超標讀值。
- **事件成立**：持續時間 ≥ 10 分鐘 → 第 10 筆連續超標讀值進來時成立。
  - 9 筆超標後回到範圍 → 9 分鐘 → 不成立 ✅ 驗收 #4
  - 10 筆超標 → 10 分鐘 → 成立 ✅
- **開始時間** = 第一筆超標讀值時間；**結束時間** = 第一筆回到範圍的讀值時間。
- **最高溫 / 最低溫**：事件內超標讀值的極值。
- **累積超標度分鐘** = Σ 每筆超標讀值的超出量（`temp − 8.0` 或 `2.0 − temp`）× 1 分鐘。

**手算範例**（將寫成測試）：連續 10 分鐘讀值 `8.5, 9.0, 9.5, 10.0, 10.0, 9.5, 9.0, 8.5, 8.2, 8.1`
→ 超出量 `0.5+1.0+1.5+2.0+2.0+1.5+1.0+0.5+0.2+0.1 = 10.3` 度分鐘。

### 5.2 【待確認】連續段中間「缺資料」怎麼算？

例：10:00–10:04 超標，10:05–10:07 無資料，10:08–10:12 超標。

| 方案          | 說明                                                                         | 優缺點                                               |
| ------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------- |
| **A（建議）** | 缺口 ≤ 2 分鐘視為連續（容忍偶發掉包），缺口內不累計度分鐘；缺口 > 2 分鐘切斷 | 偏保守、符合現場直覺；長缺口交給斷線事件處理         |
| B             | 任何缺口都切斷                                                               | 最簡單，但掉一筆就可能漏報                           |
| C             | 只有正常讀值能切斷，缺口一律視為連續                                         | 最保守，但跨越數小時斷線會把兩段無關超標黏成一個事件 |

### 5.3 重算與對帳（Reconciler）

補傳可能讓既有事件**往前延長、往後延長、或與另一段合併**。作法：

1. 新讀值落在 `[minT, maxT]`。重算視窗往前擴到 `minT` 之前**最近一筆正常讀值**、往後擴到 `maxT` 之後**最近一筆正常讀值**。
   → 只有這個視窗內的 run 可能改變，視窗外完全不受影響。
2. 對視窗內讀值跑純函數 `detectExcursions(readings) → Run[]`。
3. 對每個成立的 run，找資料庫中與它時間重疊的既有事件：
   - 無 → 新增事件，發「成立」通知。
   - 一個 → 更新起訖、極值、度分鐘。
   - 多個（補傳把兩段接起來）→ 保留最早成立的事件，其他標記 `MERGED`（不刪除，保留稽核軌跡）。
4. run 已結束且事件原本是進行中 → 寫入結束時間，發「結束」通知。
5. 補傳出來的「歷史事件」（成立時就已結束）→ 依序發「成立」與「結束」兩則通知，並標記 `backfilled: true`。

### 5.4 通知只發一次

`notifications` 表有 `UNIQUE(event_id, kind)`，`kind ∈ {EXCURSION_STARTED, EXCURSION_ENDED, OFFLINE_STARTED}`。
寫入用 `INSERT OR IGNORE`，**`changes === 1` 才推播**。冪等性由資料庫約束保證，而不是靠程式記憶狀態 → 驗收 #9。

---

## 6. 斷線偵測與補傳判定

### 6.1 偵測（OfflineMonitor）

- 每 30 秒（注入的 Clock）掃描所有「目前有綁定」的冷藏櫃。
- `now − 最新一筆 measuredAt > 15 分鐘` 且沒有進行中的斷線事件 → 建立斷線事件、發通知、推播狀態。
- `startedAt` = 最後一筆讀值時間 + 1 分鐘；`detectedAt` = now。

### 6.2 恢復與補傳

斷線事件狀態機：

```
 OPEN ──(最新讀值回到 15 分鐘內)──▶ RECOVERED ──(每次有讀值落入斷線區間就重新評估)──┐
                                                                                 ▼
                         ┌── 區間內資料完整、無異常事件  → BACKFILLED_NORMAL   「已補齊、溫度正常」
                         ├── 區間內有異常事件            → BACKFILLED_EXCURSION 並建立關聯
                         └── 區間內資料仍有缺口          → INCOMPLETE          「資料不完整」
```

- 斷線區間 = `[startedAt, recoveredAt)`。
- 「完整」定義：區間內每一分鐘都有讀值（容忍與 §5.2 相同的 2 分鐘缺口規則）。
- 關聯表 `event_links(offline_event_id, excursion_event_id)`，多對多（一次斷線可能含兩段超標，一段超標也可能跨兩次斷線）。
- 補傳順序不影響結果：裝置先送舊資料或先送新資料，最後收斂到同一狀態 → 驗收 #8。

---

## 7. 裝置更換

- `bindings(device_id, cabinet_id, bound_from, bound_to NULL)`，半開區間 `[from, to)`。
- 約束：同一冷藏櫃、同一裝置在任一時刻最多一筆有效綁定（應用層檢查 + 測試）。
- 更換操作：`POST /api/cabinets/:id/device-replacement { newDeviceId, at }` → 同一 transaction 內結束舊綁定、建立新綁定。
- 舊裝置在更換**之後**才補傳更換**之前**的資料 → 依量測時間解析到舊綁定 → 歸屬正確冷藏櫃 → 驗收 #6。
- 為了讓「寫入時決定 cabinet_id」永遠正確：**綁定只能往未來修改**（`at ≥ 最後一筆已收資料時間`），不提供改寫歷史綁定。

---

## 8. 即時儀表板

### 8.1 狀態判定（優先序）

`斷線`（有進行中斷線事件）> `異常`（有進行中異常事件）> `正常`。
另外，若最新讀值超標但未滿 10 分鐘，狀態仍為「正常」，但溫度數字以警示色顯示。

### 8.2 WebSocket 訊息

| type                   | 時機                         | payload                                 |
| ---------------------- | ---------------------------- | --------------------------------------- |
| `snapshot`             | 連線建立                     | 所有冷藏櫃狀態                          |
| `cabinet.status`       | 狀態、溫度、最後回報時間變動 | 單台冷藏櫃                              |
| `series.appended`      | 即時新增讀值                 | `cabinetId, points[]` → 圖表直接 append |
| `series.changed`       | 補傳改變了歷史區段           | `cabinetId, from, to` → 圖表重抓該區段  |
| `notification.created` | 新通知                       | 通知內容（右上角 toast）                |

16 台 × 每分鐘 1 筆，量很小，全部廣播即可，不做訂閱分流。

### 8.3 24 小時圖表

- 【待確認】圖表套件建議 **Apache ECharts**（Canvas 渲染，1,440 點 < 100ms；`markArea` 畫 2–8°C 參考帶；資料點為 `null` 時自動斷線）。
  - 替代：uPlot（更快更小，但參考帶與 tooltip 要自己寫）；Recharts（SVG，1,440 點可行但較吃力）。
- 缺口處理：前端純函數 `insertGaps(points, maxGap = 2min)`，相鄰兩點間隔超過門檻就插入 `null` → 線條中斷。補傳後重抓資料，`null` 消失 → 自動連成連續的線。

---

## 9. 事件處置與月報

### 9.1 處置紀錄

- 適用兩種事件。欄位：處置人、處置說明、是否報廢、報廢數量（報廢為是時必填且 > 0）。
- **append-only**：可多次填寫，畫面顯示最新一筆與歷史；不提供刪改（法遵稽核需求）。

### 9.2 月報計算（台灣時間月份邊界，UTC+8，無日光節約時間）

- **期望分鐘數** = 該月中「冷藏櫃有有效綁定」的分鐘數（當月未結束則算到 now）。
- **資料完整率** = 有讀值的分鐘數 ÷ 期望分鐘數。
- **溫度合規率** = 在範圍內的讀值數 ÷ 有讀值的分鐘數（題目明定分母是「有量測資料的時間」）。
- **事件清單**：與該月重疊的異常與斷線事件，含處置摘要。

**手算範例**：某月期望 44,640 分鐘（31 天），有讀值 44,000 分鐘，其中 43,780 分鐘在範圍內
→ 完整率 98.57%，合規率 99.50%。

### 9.3 CSV

- UTF-8 **加 BOM**（`﻿`）、CRLF 換行 → Excel 開啟中文不亂碼 → 驗收 #12。
- 兩個檔案：`月報摘要.csv`（每台冷藏櫃一列）、`月報事件清單.csv`。

---

## 10. 裝置模擬器

```bash
npm run simulator -- --scenario normal                       # 16 台全部正常
npm run simulator -- --scenario normal \
  --override TM-0003=door-open --override TM-0005=compressor-failure \
  --override TM-0007=offline-backfill
npm run simulator -- --duration 30m --speed 60               # 見下方時間加速
```

| 情境                 | 行為                                                          |
| -------------------- | ------------------------------------------------------------- |
| `normal`             | 4–5°C 附近隨機微擾                                            |
| `door-open`          | 5 分鐘內升到約 9–10°C 再降回（不應產生事件）                  |
| `compressor-failure` | 每分鐘緩升，超過 8°C 後持續 70 分鐘以上                       |
| `offline-backfill`   | 停止上傳 2 小時（本機緩衝），其中 30 分鐘超標，恢復後分批補傳 |

模擬器模擬真實裝置行為：本機緩衝、分批上傳、上傳失敗重試（自然驗證冪等性）。
情境產生器是純函數 `(t) → temperature`，可單元測試。

### 10.1 【待確認】時間加速

「斷線 2 小時」與「壓縮機故障 1 小時以上」照實際時間跑要等 2 小時以上。建議：

- 伺服器支援 `CLOCK_SPEED=60` 環境變數 → 使用 `ScaledClock`（1 秒 = 1 分鐘）。
- 模擬器啟動時呼叫 `GET /api/system/clock` 同步時間與倍率。
- 預設 `CLOCK_SPEED=1`，驗收 #13（16 台 × 30 分鐘）用真實時間跑。

這正是「時間邏輯一律透過可注入時鐘」的實際收益：測試用 `FixedClock`、展示用 `ScaledClock`、正式用 `SystemClock`。

---

## 11. 資料模型（SQLite）

所有時間存 **UTC epoch 毫秒（INTEGER）**，只在顯示層轉台灣時間。

```sql
branches  (id TEXT PK, name TEXT NOT NULL)
cabinets  (id TEXT PK, branch_id TEXT FK, name TEXT NOT NULL)
devices   (id TEXT PK, model TEXT, created_at INTEGER)
bindings  (id INTEGER PK, device_id TEXT FK, cabinet_id TEXT FK,
           bound_from INTEGER NOT NULL, bound_to INTEGER NULL)

readings  (device_id TEXT, seq INTEGER, cabinet_id TEXT, measured_at INTEGER,
           temp_x10 INTEGER, battery INTEGER, received_at INTEGER,
           PRIMARY KEY (device_id, seq)) WITHOUT ROWID
  INDEX idx_readings_cabinet_time (cabinet_id, measured_at)

events    (id INTEGER PK, cabinet_id TEXT FK, type TEXT CHECK (type IN ('EXCURSION','OFFLINE')),
           status TEXT, started_at INTEGER, ended_at INTEGER NULL, detected_at INTEGER,
           -- excursion 專用
           max_temp_x10 INTEGER, min_temp_x10 INTEGER, degree_minutes_x10 INTEGER,
           backfilled INTEGER, merged_into INTEGER NULL,
           -- offline 專用
           recovered_at INTEGER NULL, backfill_status TEXT NULL)
  INDEX (cabinet_id, type, started_at)

event_links   (offline_event_id, excursion_event_id, PRIMARY KEY (both))
notifications (id PK, event_id FK, kind TEXT, created_at, payload JSON, UNIQUE(event_id, kind))
dispositions  (id PK, event_id FK, handler TEXT, note TEXT, vaccine_discarded INTEGER,
               discarded_qty INTEGER, created_at INTEGER)
schema_migrations (version INTEGER PK, applied_at INTEGER)
```

**容量估算**：16 台 × 1,440 × 730 天 ≈ **1,680 萬筆**，含索引約 1.5–2 GB，SQLite 可承受。
單台單日查詢走 `(cabinet_id, measured_at)` 索引，約 1,440 筆，毫秒級。
每日排程刪除 2 年前資料。

**Migration**：自寫極簡 runner（`migrations/001_init.sql`…），啟動時依序套用、各自包在 transaction 內，記錄於 `schema_migrations`。不引入額外套件。

---

## 12. API 一覽（初稿）

| Method   | Path                                                          | 說明                             |
| -------- | ------------------------------------------------------------- | -------------------------------- |
| POST     | `/api/readings/batch`                                         | 批次上傳量測                     |
| GET      | `/api/dashboard`                                              | 分院 → 冷藏櫃 → 目前狀態         |
| GET      | `/api/cabinets/:id/readings?from&to`                          | 圖表資料                         |
| GET/POST | `/api/branches`, `/api/cabinets`, `/api/devices`              | 主檔維護                         |
| GET      | `/api/cabinets/:id/bindings`                                  | 綁定歷史                         |
| POST     | `/api/cabinets/:id/device-replacement`                        | 更換溫度計                       |
| GET      | `/api/events?type&status&cabinetId&from&to`                   | 事件列表                         |
| GET      | `/api/events/:id`                                             | 事件詳情（含關聯事件、處置歷史） |
| POST     | `/api/events/:id/dispositions`                                | 新增處置紀錄                     |
| GET      | `/api/notifications?limit`                                    | 通知紀錄                         |
| GET      | `/api/reports/monthly?month=2026-10`                          | 月報 JSON                        |
| GET      | `/api/reports/monthly.csv?month=2026-10&kind=summary\|events` | 月報 CSV                         |
| GET      | `/api/system/clock`                                           | 伺服器時間與倍率                 |
| WS       | `/ws`                                                         | 即時推播                         |

---

## 13. 技術選型

| 層              | 選擇                                                        | 理由                                                  |
| --------------- | ----------------------------------------------------------- | ----------------------------------------------------- |
| Monorepo        | npm workspaces                                              | 驗收寫明 `npm install`，不額外要求 pnpm               |
| 後端            | **Fastify** + `@fastify/websocket`                          | `app.inject()` 免開 port 即可測 API；內建 schema 驗證 |
| 驗證 / 共用型別 | **zod**（`packages/shared`）                                | 前後端共用 API 契約                                   |
| DB              | 【待確認】**`node:sqlite`**（建議）或 `better-sqlite3`      | 見下方說明                                            |
| 前端            | React 18 + Vite + React Router + TanStack Query             | Query 處理快取與 WS 觸發的 invalidate                 |
| 圖表            | 【待確認】ECharts                                           | 見 §8.3                                               |
| 執行            | `tsx`（開發）、`concurrently`（一個指令起前後端）           |                                                       |
| 品質            | ESLint (typescript-eslint, flat config) + Prettier + Vitest |                                                       |
| CI              | GitHub Actions：lint → typecheck → test → build             | 加分項                                                |

**SQLite driver 抉擇**：你的環境是 **Node 26.9**。

- `better-sqlite3`：最成熟、有 transaction helper；但它是原生模組，**新版 Node 常常還沒有 prebuilt binary**，會退回本機編譯（需要 Xcode CLT / Python），是「`npm install` 一次就起來」的最大風險。
- `node:sqlite`：Node 內建，零原生依賴，API 同樣是同步的；缺點是 Node 22 上會印 ExperimentalWarning、transaction 要自己包一層（約 10 行）。
- 建議 **`node:sqlite`**，`engines` 設 `>=22.13`（免 flag 的最低版本）。

---

## 14. 專案結構

```
coldtrace/
├─ package.json                 # workspaces + 根指令 (dev / test / lint / seed / simulator)
├─ packages/shared/             # zod schema、API 型別、常數（2.0/8.0/10min/15min/72h）、台灣時間工具
├─ apps/server/
│  └─ src/
│     ├─ app.ts                 # buildApp(deps) — 依賴注入，測試用 :memory: DB + FixedClock
│     ├─ main.ts
│     ├─ infra/                 # db、migrate、clock、logger
│     ├─ modules/
│     │  ├─ assets/             # 分院、冷藏櫃、裝置、綁定
│     │  ├─ ingestion/
│     │  ├─ events/             # excursion-detector.ts(純函數)、reconciler.ts、offline-monitor.ts
│     │  ├─ notifications/
│     │  └─ reports/            # monthly-report.ts(純函數)、csv.ts
│     ├─ realtime/              # event bus、ws hub
│     └─ seed/                  # 範例資料產生（確定性亂數）
├─ apps/simulator/              # CLI、裝置模型（緩衝/補傳/重試）、情境產生器
├─ apps/web/                    # 儀表板、圖表、事件處置、月報、設備管理
└─ .github/workflows/ci.yml
```

---

## 15. 範例資料

- 8 間分院（台北、新北、桃園、新竹、台中、嘉義、台南、高雄）× 2 台冷藏櫃 × 1 支溫度計。
- 過去 7 天、每分鐘一筆（約 16.1 萬筆），確定性亂數（每次 seed 結果相同）。
- 刻意埋入：數次開門升溫（不成事件）、1 次壓縮機異常、1 次斷線已補齊正常、1 次斷線補傳含超標、1 次溫度計更換。
- **走與正式 API 相同的 ingestion + 事件判定流程**產生事件，確保範例資料的事件與規則一致，而非手寫假事件。

---

## 16. 測試策略（目標 > 30 個單元測試）

| 模組               | 重點案例                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------- |
| excursion-detector | 9 分鐘不成立 / 10 分鐘成立 / 2.0、8.0 邊界 / 低溫超標 / 度分鐘手算 / 缺口規則 / 亂序輸入 |
| reconciler         | 重送 3 次不變 / 補傳往前延長 / 兩段合併 / 歷史事件發兩則通知 / 成立通知只一則            |
| ingestion          | 重送筆數不變 / 72h 邊界 / 75h 拒收並列出流水號 / 未來時間 / 未知裝置 / 無綁定            |
| bindings           | 更換前後歸屬 / 舊裝置延遲補傳 / 重疊綁定被拒                                             |
| offline-monitor    | 14 分 59 秒不觸發、15 分鐘後觸發 / 補齊正常 / 補傳含超標並建立關聯 / 資料不完整          |
| monthly-report     | 合規率、完整率手算 / 月份邊界（台灣時間）/ 綁定期間 / CSV BOM                            |
| web utils          | `insertGaps` / 狀態判定                                                                  |
| simulator          | 各情境溫度曲線符合預期                                                                   |

---

## 17. 開發里程碑（每個都是可編譯、可測試的 commit 單位）

| #   | 內容                                         | 對應驗收 |
| --- | -------------------------------------------- | -------- |
| M0  | Monorepo 骨架、TS strict、ESLint、Vitest、CI | 14       |
| M1  | DB + migration、主檔與綁定                   | 6        |
| M2  | Ingestion（冪等、72h）                       | 2, 3     |
| M3  | 異常事件判定 + 對帳 + 通知                   | 4, 5, 9  |
| M4  | 斷線偵測 + 補傳判定 + 事件關聯               | 7, 8     |
| M5  | WebSocket + 儀表板                           | 7, 10    |
| M6  | 24h 圖表                                     | 8, 11    |
| M7  | 事件處置 + 月報 + CSV                        | 12       |
| M8  | 模擬器                                       | 8, 13    |
| M9  | Seed、一鍵啟動、README、截圖                 | 1        |

---

## 18. 已知限制（預先列出）

- 伺服器本身停機期間，所有冷藏櫃都會在重啟後被判定為斷線（從伺服器角度確實沒收到資料）；裝置補傳後會自動標記為「已補齊」。
- 單機 SQLite，無水平擴充；以 16 台規模而言綽綽有餘。
- 無登入（題目假設內網使用），處置人為自由輸入文字。
- 歷史綁定不可修改（只能往未來更換），以保證已寫入資料的歸屬不變。

---

## 19. 待確認事項彙總

1. **§5.2 缺口規則**：建議方案 A（≤ 2 分鐘缺口視為連續）。
2. **§13 SQLite driver**：建議 `node:sqlite`。
3. **§8.3 圖表套件**：建議 ECharts。
4. **§10.1 時間加速**：是否實作 `CLOCK_SPEED` / `ScaledClock`。
5. **啟動指令**：`npm run dev` 是否同時啟動「正常情境」模擬器？
   若不啟動，範例資料停在 seed 當下，15 分鐘後儀表板全部顯示「斷線」。建議 `npm run dev` 一併啟動。
6. **設備管理 UI 範圍**：建議「分院/冷藏櫃/裝置列表 + 更換溫度計表單」，新增/刪除主檔只提供 API（題目沒有要求完整 CRUD 畫面）。
7. **新增套件清單**（依你的規範需先告知）：fastify、@fastify/websocket、@fastify/static、zod、react、react-dom、react-router、@tanstack/react-query、echarts、vite、tsx、concurrently、vitest、eslint、typescript-eslint、prettier。
