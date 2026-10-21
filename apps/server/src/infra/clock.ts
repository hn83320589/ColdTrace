/** 所有時間相關邏輯一律透過 Clock 取得現在時間，方便測試與展示加速 */
export interface Clock {
  now(): number;
  /** 時間流逝倍率：1 = 真實時間 */
  readonly speed: number;
}

export class SystemClock implements Clock {
  readonly speed = 1;
  now(): number {
    return Date.now();
  }
}

/** 測試用：時間只在呼叫 set / advance 時改變 */
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

/** 展示用：以 anchor 為起點，時間以 speed 倍速流逝 */
export class ScaledClock implements Clock {
  private readonly realAnchor: number;
  constructor(
    readonly speed: number,
    private readonly anchor: number = Date.now(),
    private readonly realNow: () => number = Date.now,
  ) {
    if (!(speed > 0)) throw new Error(`CLOCK_SPEED 必須大於 0：${speed}`);
    this.realAnchor = realNow();
  }
  now(): number {
    return Math.floor(this.anchor + (this.realNow() - this.realAnchor) * this.speed);
  }
}
