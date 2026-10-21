# 第 04 章　技術選型：每個選擇都要說得出「為什麼不是另一個」

> 技術選型的品質不在於選了什麼，而在於**能不能說清楚放棄了什麼**。
> 本章用「決策紀錄」（Architecture Decision Record, ADR）的格式整理每個選擇：
> **背景 → 選項 → 決定 → 後果**。

## 4.1 選型的出發點

第 01 章的容量估算得出：**這不是規模問題，而是正確性問題**。因此選型原則是：

1. **符合題目限制**（TypeScript strict、Node 22+、SQLite、React 18+、Vite、Vitest）。
2. **`npm install` 一次就能跑**：評審或新同事的第一印象。
3. **可測試性優先**：能不開 port、不碰檔案系統就測完的工具優先。
4. **不引入沒有明確需求的東西**：每多一個套件，就多一個要升級、要學、要除錯的東西。

## 4.2 總覽

| 層             | 選擇                               | 主要理由                                      |
| -------------- | ---------------------------------- | --------------------------------------------- |
| 專案結構       | npm workspaces                     | 驗收寫明 `npm install`，不額外要求 pnpm／yarn |
| 後端框架       | Fastify 5 + `@fastify/websocket`   | `app.inject()` 免開 port 測 API               |
| 資料庫驅動     | `node:sqlite`（Node 內建）         | 零原生依賴，安裝不會失敗                      |
| Migration      | 自寫 runner（約 30 行）            | 需求很單純，不值得引入套件                    |
| 資料存取       | 手寫 SQL + 3 個 helper             | 判定邏輯需要精確控制 SQL；不需要 ORM          |
| 驗證／共用契約 | zod 4（`packages/shared`）         | 一份 schema 同時產生型別與執行期驗證          |
| 前端           | React 18 + Vite 8 + React Router 7 | 題目指定                                      |
| 伺服器狀態     | TanStack Query 5                   | WebSocket 訊息直接更新查詢快取                |
| 圖表           | Apache ECharts 6（按需引入）       | Canvas、參考帶、`null` 斷線都是內建功能       |
| 測試           | Vitest 4                           | 題目指定；與 Vite 共用設定與轉譯              |
| 品質           | ESLint 9（type-checked）+ Prettier | 型別感知的 lint 能抓到未處理的 Promise 等錯誤 |
| 開發執行       | tsx、concurrently                  | 不需建置即可執行 TS；一個指令起三個程式       |
| CI             | GitHub Actions，Node 22 與 24      | 同時驗證最低支援版本與目前版本                |

## 4.3 決策紀錄

### ADR-1：SQLite 驅動選 `node:sqlite`，不選 `better-sqlite3`

**背景**：題目指定 SQLite，可用 `better-sqlite3` 或 `node:sqlite`。開發環境是 Node 26。

**選項**：

|        | `better-sqlite3`                                                                                 | `node:sqlite`                                 |
| ------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| 成熟度 | 非常成熟，社群廣泛使用                                                                           | 較新（Node 22.5 加入，22.13 起不需 flag）     |
| 安裝   | **原生模組**；新版 Node 常無 prebuilt binary，會退回本機編譯（需 Xcode CLT／Python／C++ 工具鏈） | 內建，**零安裝**                              |
| API    | 同步；有 `db.transaction()` helper                                                               | 同步；transaction 要自己包（約 20 行）        |
| 型別   | 社群型別定義                                                                                     | 內建型別，但具名參數與位置參數是不同 overload |

**決定**：`node:sqlite`，`engines` 設 `>=22.13`。

**後果**：

- 正面：`npm install` 不會因為編譯失敗而卡住，這是「一個指令啟動」驗收最大的風險來源。
- 負面：要自己寫 SAVEPOINT 版的巢狀 transaction（`infra/db.ts`），以及統一參數 overload 的 helper。
- 同步 API 讓批次之間天然串行（第 03 章 3.4 節），這點兩者相同。

### ADR-2：後端框架選 Fastify，不選 Express

**決定性因素**：`app.inject()`。

```ts
// apps/server/src/http/app.test.ts 的寫法
const res = await app.inject({ method: 'POST', url: '/api/readings/batch', payload: {...} });
expect(res.statusCode).toBe(200);
```

不需要開 port、不需要 supertest，HTTP 層測試和單元測試一樣快。
另外 Fastify 的錯誤處理、plugin 封裝、型別支援也比 Express 更適合 TypeScript 專案。

**放棄的東西**：Express 的生態系與熟悉度。本專案用到的功能（路由、WebSocket、靜態檔案）兩者都有。

### ADR-3：不使用 ORM

**背景**：常見選擇有 Prisma、Drizzle、Kysely。

**決定**：手寫 SQL，只包三個 helper（`all`、`get`、`run`）與 `transaction`。

**理由**：

- 核心查詢是「某冷藏櫃某時間之前最近一筆正常讀值」「重疊的事件」「DISTINCT 分鐘數」這類 SQL，
  用 ORM 寫反而更難讀，最後還是要寫原生 SQL。
- 整個專案只有 8 張表。
- Prisma 需要額外的產生步驟與引擎；與 `node:sqlite` 的整合也不成熟。

**後果**：查詢結果的型別要手動標註（`get<{ t: number | null }>(...)`），是可接受的代價。

### ADR-4：用 zod 定義前後端共用契約

```ts
// packages/shared/src/api.ts
export const readingInputSchema = z.object({
  deviceId: z.string().min(1),
  seq: z.number().int().positive(),
  measuredAt: z.iso.datetime({ offset: true }),
  temperature: z.number().finite(),
  battery: z.number().int().min(0).max(100),
});
export type ReadingInput = z.infer<typeof readingInputSchema>;

export const ingestRequestSchema = z.object({
  readings: z.array(readingInputSchema).min(1).max(MAX_BATCH_SIZE),
});
```

一份 schema 同時是：後端的執行期驗證、前端的表單驗證（處置表單）、雙方的 TypeScript 型別。
改一個欄位，所有使用的地方都會編譯失敗，而不是在執行期才發現。

**事後學到的代價**：前端只有處置表單用到 zod，但因為 `@coldtrace/shared` 只有一個入口，
zod（約 80 kB）被打包進首屏。解法是改成 subpath exports（`@coldtrace/shared/api`），列為已知限制。

### ADR-5：前端狀態用 TanStack Query，不用 Redux／Zustand

這個前端的狀態幾乎全部是**伺服器狀態**（儀表板、讀值、事件），真正的客戶端狀態只有「選了哪台冷藏櫃」（放在 URL query string）。
TanStack Query 處理快取、重抓、載入狀態；WebSocket 訊息直接寫入它的快取（第 08 章）：

```ts
case 'cabinet.status':
  qc.setQueryData<BranchDashboard[]>(['dashboard'], (old) => /* 替換其中一台 */);
```

不需要另一個狀態管理工具。

### ADR-6：圖表選 ECharts

|              | ECharts                     | uPlot            | Recharts        |
| ------------ | --------------------------- | ---------------- | --------------- |
| 渲染         | Canvas                      | Canvas           | SVG             |
| 1,440 點     | 毫秒級                      | 最快             | 可行但較吃力    |
| 2–8°C 參考帶 | `markArea` 內建             | 要自己畫         | `ReferenceArea` |
| 斷線處中斷   | 資料點為 `null` 自動中斷    | 支援             | 支援            |
| 體積         | 大（按需引入後仍約 540 kB） | 極小（約 50 kB） | 中              |

**決定**：ECharts，因為參考帶、tooltip、時間軸都是內建功能，開發最快。

**後果與修正**：體積大。外部 review 指出前端打包 883 kB，最後用 **route-level code splitting**
把圖表拆成獨立 chunk、在背景預載，首屏降到約 315 kB（第 10 章）。
如果重新選擇，uPlot 是值得認真考慮的選項，代價是參考帶與 tooltip 要自己寫。

> **教學重點**：選型時的「後果」欄位，要在專案後期回頭驗證。
> 預期「內網使用，體積不重要」，實際上被 review 指出問題。

### ADR-7：版本鎖定的兩個坑

這兩個問題在開發初期就遇到，值得記錄：

1. **TypeScript 固定在 5.9**：TypeScript 7（Go 重寫版）已發布，但 typescript-eslint 還不支援。
   選新版本前要確認**整個工具鏈**都支援，而不只是主角本身。
2. **Vite 與 Vitest 版本要對齊**：Vitest 4 內含 Vite 8，若前端用 Vite 7，
   兩份 Vite 的型別定義會衝突，`vite.config.ts` 型別檢查失敗。最後前端也升到 Vite 8。

## 4.4 刻意沒有選的東西

| 沒選                                | 為什麼                                                               |
| ----------------------------------- | -------------------------------------------------------------------- |
| 時序資料庫（InfluxDB、TimescaleDB） | 2 年 1,680 萬筆，SQLite 加一個複合索引就足夠；題目也指定 SQLite      |
| 訊息佇列（Redis、RabbitMQ）         | 單一行程內的 `EventBus`（不到 20 行）就能把業務邏輯與 WebSocket 解耦 |
| 排程套件（node-cron）               | 只有兩個固定間隔的排程，`setInterval` 搭配可注入時鐘即可             |
| 日期套件（dayjs、date-fns）         | 只需要「台灣時間」一個固定偏移的轉換，`time.ts` 約 35 行             |
| UI 元件庫                           | 頁面數量少，手寫 CSS 約 650 行                                       |
| 登入與權限                          | 題目假設內網使用，列為已知限制                                       |

## 4.5 本章練習

1. 為「改用 PostgreSQL」寫一份 ADR，包含背景、選項、決定與後果。在什麼條件下你會做這個決定？
2. ADR-6 中，如果改用 uPlot，列出需要自己實作的功能，並估計工作量。
3. 挑一個你最近用過的套件，回答：如果不用它，要寫多少程式碼？它帶來了哪些你沒用到的東西？
