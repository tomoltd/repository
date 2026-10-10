export const ACCOUNT_KINDS = [
  'tokutei',
  'ippan',
  'nisa_growth',
  'nisa_tsumitate',
  'other',
] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const ACCOUNT_KIND_LABELS: Record<AccountKind, string> = {
  tokutei: '特定口座',
  ippan: '一般口座',
  nisa_growth: 'NISA 成長投資枠',
  nisa_tsumitate: 'NISA つみたて投資枠',
  other: 'その他',
};

export const ASSET_TYPES = [
  'stock',
  'etf',
  'fund',
  'reit',
  'bond',
  'cash',
  'other',
] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  stock: '個別株',
  etf: 'ETF',
  fund: '投資信託',
  reit: 'REIT',
  bond: '債券',
  cash: '現金等',
  other: 'その他',
};

export interface Account {
  id: string;
  name: string;
  kind: AccountKind;
  broker: string | null;
}

export interface Security {
  symbol: string;
  name: string;
  currency: string;
  assetType: AssetType;
  sector: string | null;
  market: string | null;
  /** Number of units one quoted price refers to (投資信託の基準価額は 10000 口). */
  priceUnit: number;
  note: string | null;
}

export type Side = 'buy' | 'sell';

export interface Trade {
  id: number;
  accountId: string;
  symbol: string;
  side: Side;
  quantity: number;
  /** Price per `priceUnit` units, in the security's currency. */
  price: number;
  /** Fee in the security's currency. */
  fee: number;
  /** Base currency per one unit of the security's currency at trade time. */
  fxRate: number;
  tradeDate: string;
  note: string | null;
}

export interface Dividend {
  id: number;
  accountId: string;
  symbol: string;
  /** Gross amount in the security's currency. */
  amount: number;
  /** Tax withheld in the security's currency. */
  tax: number;
  fxRate: number;
  paidDate: string;
  note: string | null;
}

export interface Price {
  symbol: string;
  price: number;
  asOf: string;
  source: string | null;
}

export interface FxRate {
  currency: string;
  rate: number;
  asOf: string;
}

export interface Snapshot {
  date: string;
  marketValue: number;
  costBasis: number;
}
