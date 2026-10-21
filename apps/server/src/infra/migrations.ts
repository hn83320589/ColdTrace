export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** 只能新增，不可修改已發布的 migration */
export const migrations: Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `
      CREATE TABLE branches (
        id   TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );

      CREATE TABLE cabinets (
        id        TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL REFERENCES branches(id),
        name      TEXT NOT NULL
      );

      CREATE TABLE devices (
        id         TEXT PRIMARY KEY,
        model      TEXT,
        created_at INTEGER NOT NULL
      );

      -- 綁定期間為半開區間 [bound_from, bound_to)，bound_to 為 NULL 表示仍在綁定中
      CREATE TABLE bindings (
        id         INTEGER PRIMARY KEY,
        device_id  TEXT NOT NULL REFERENCES devices(id),
        cabinet_id TEXT NOT NULL REFERENCES cabinets(id),
        bound_from INTEGER NOT NULL,
        bound_to   INTEGER,
        CHECK (bound_to IS NULL OR bound_to > bound_from)
      );
      CREATE INDEX idx_bindings_device ON bindings(device_id, bound_from);
      CREATE INDEX idx_bindings_cabinet ON bindings(cabinet_id, bound_from);

      -- 溫度以 0.1°C 為單位的整數儲存
      CREATE TABLE readings (
        device_id   TEXT    NOT NULL,
        seq         INTEGER NOT NULL,
        cabinet_id  TEXT    NOT NULL,
        measured_at INTEGER NOT NULL,
        temp_x10    INTEGER NOT NULL,
        battery     INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        PRIMARY KEY (device_id, seq)
      ) WITHOUT ROWID;
      CREATE INDEX idx_readings_cabinet_time ON readings(cabinet_id, measured_at);

      CREATE TABLE events (
        id          INTEGER PRIMARY KEY,
        cabinet_id  TEXT    NOT NULL REFERENCES cabinets(id),
        type        TEXT    NOT NULL CHECK (type IN ('EXCURSION', 'OFFLINE')),
        status      TEXT    NOT NULL,
        started_at  INTEGER NOT NULL,
        -- 斷線事件的 ended_at 為恢復即時回報的時間
        ended_at    INTEGER,
        detected_at INTEGER NOT NULL,
        -- 溫度異常事件專用（duration_ms = 最後一筆超標 + 1 分鐘 − 開始時間）
        duration_ms        INTEGER,
        max_temp_x10       INTEGER,
        min_temp_x10       INTEGER,
        degree_minutes_x10 INTEGER,
        backfilled         INTEGER NOT NULL DEFAULT 0,
        merged_into        INTEGER REFERENCES events(id)
      );
      CREATE INDEX idx_events_cabinet ON events(cabinet_id, type, started_at);
      CREATE INDEX idx_events_status ON events(type, status);

      CREATE TABLE event_links (
        offline_event_id   INTEGER NOT NULL REFERENCES events(id),
        excursion_event_id INTEGER NOT NULL REFERENCES events(id),
        PRIMARY KEY (offline_event_id, excursion_event_id)
      );

      CREATE TABLE notifications (
        id         INTEGER PRIMARY KEY,
        event_id   INTEGER NOT NULL REFERENCES events(id),
        kind       TEXT    NOT NULL,
        message    TEXT    NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (event_id, kind)
      );

      CREATE TABLE dispositions (
        id                INTEGER PRIMARY KEY,
        event_id          INTEGER NOT NULL REFERENCES events(id),
        handler           TEXT    NOT NULL,
        note              TEXT    NOT NULL,
        vaccine_discarded INTEGER NOT NULL,
        discarded_qty     INTEGER NOT NULL,
        created_at        INTEGER NOT NULL
      );
      CREATE INDEX idx_dispositions_event ON dispositions(event_id, created_at);
    `,
  },
];
