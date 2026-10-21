import { describe, expect, it } from 'vitest';
import { toCsv } from './csv';

describe('toCsv', () => {
  it('以 UTF-8 BOM 開頭、CRLF 換行（Excel 開啟中文不亂碼）', () => {
    const csv = toCsv(['分院', '合規率'], [['台北分院', 99.5]]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe('分院,合規率\r\n台北分院,99.5\r\n');
  });

  it('含逗號、引號、換行的欄位加引號並跳脫', () => {
    const csv = toCsv(['說明'], [['移櫃,並"報廢"\n完成'], [null], [true]]);
    expect(csv.slice(1)).toBe('說明\r\n"移櫃,並""報廢""\n完成"\r\n\r\n是\r\n');
  });
});
