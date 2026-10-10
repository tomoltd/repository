/** Minimal RFC 4180 parser: quoted fields, escaped quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const input = text.replace(/^﻿/, '');
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

const HEADER_ALIASES: Record<string, string> = {
  date: 'date',
  trade_date: 'date',
  約定日: 'date',
  取引日: 'date',
  account: 'account',
  口座: 'account',
  symbol: 'symbol',
  code: 'symbol',
  ticker: 'symbol',
  銘柄コード: 'symbol',
  コード: 'symbol',
  side: 'side',
  売買: 'side',
  取引: 'side',
  quantity: 'quantity',
  qty: 'quantity',
  数量: 'quantity',
  株数: 'quantity',
  口数: 'quantity',
  price: 'price',
  単価: 'price',
  約定単価: 'price',
  fee: 'fee',
  手数料: 'fee',
  fx_rate: 'fx_rate',
  為替: 'fx_rate',
  為替レート: 'fx_rate',
  currency: 'currency',
  通貨: 'currency',
  name: 'name',
  銘柄名: 'name',
  銘柄: 'name',
  asset_type: 'asset_type',
  種別: 'asset_type',
  note: 'note',
  メモ: 'note',
  備考: 'note',
};

const SIDE_ALIASES: Record<string, 'buy' | 'sell'> = {
  buy: 'buy',
  b: 'buy',
  買: 'buy',
  買付: 'buy',
  買い: 'buy',
  購入: 'buy',
  sell: 'sell',
  s: 'sell',
  売: 'sell',
  売付: 'sell',
  売り: 'sell',
  売却: 'sell',
};

export interface CsvTradeRow {
  line: number;
  values: Record<string, string>;
}

export function readTradeRows(text: string): CsvTradeRow[] {
  const [header, ...body] = parseCsv(text);
  if (!header) throw new Error('CSV が空です。');
  const columns = header.map((cell) => {
    const key = cell.trim();
    return HEADER_ALIASES[key] ?? HEADER_ALIASES[key.toLowerCase()] ?? null;
  });
  for (const required of ['date', 'symbol', 'side', 'quantity', 'price'])
    if (!columns.includes(required))
      throw new Error(
        `CSV のヘッダーに ${required} 列がありません（ヘッダー: ${header.join(', ')}）。`,
      );
  return body.map((cells, index) => {
    const values: Record<string, string> = {};
    columns.forEach((column, i) => {
      if (column && cells[i] !== undefined) values[column] = cells[i]!.trim();
    });
    return { line: index + 2, values };
  });
}

export const parseSide = (value: string) => SIDE_ALIASES[value.trim().toLowerCase()];

/** Accepts 1,234.5 / ¥1,234 / 2026/1/5 style values from broker exports. */
export const parseNumber = (value: string | undefined) => {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value.replace(/[,¥$￥\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

export const parseDate = (value: string) => {
  const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(value.trim());
  if (!match) return undefined;
  const [, y, m, d] = match;
  return `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`;
};
