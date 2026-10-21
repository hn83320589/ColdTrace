export type CsvCell = string | number | boolean | null | undefined;

const UTF8_BOM = '﻿';

function escape(cell: CsvCell): string {
  if (cell === null || cell === undefined) return '';
  const text = typeof cell === 'boolean' ? (cell ? '是' : '否') : String(cell);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 CSV，加 UTF-8 BOM 與 CRLF，Excel 直接開啟中文不亂碼 */
export function toCsv(header: string[], rows: CsvCell[][]): string {
  return UTF8_BOM + [header, ...rows].map((row) => row.map(escape).join(',')).join('\r\n') + '\r\n';
}
