const integer = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 4 });

export const money = (value: number) => integer.format(Math.round(value));
export const signedMoney = (value: number) =>
  `${value > 0 ? '+' : ''}${integer.format(Math.round(value))}`;
export const num = (value: number) => decimal.format(value);
export const pct = (value: number | null, signed = false) =>
  value === null
    ? '—'
    : `${signed && value > 0 ? '+' : ''}${(value * 100).toFixed(2)}%`;

const cell = (value: string) => value.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function table(headers: string[], rows: string[][]) {
  if (rows.length === 0) return '（該当なし）';
  return [
    `| ${headers.map(cell).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n');
}

export const lines = (...parts: (string | false | null | undefined)[]) =>
  parts.filter((part): part is string => typeof part === 'string').join('\n');
