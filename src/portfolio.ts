import type { FxRate, Price, Security, Trade } from './types.js';

const EPSILON = 1e-9;

export class PortfolioError extends Error {}

export interface Position {
  accountId: string;
  symbol: string;
  quantity: number;
  /** Remaining cost basis in the security's currency, fees included. */
  costLocal: number;
  /** Remaining cost basis in the base currency, at trade-time FX rates. */
  costBase: number;
}

export interface RealizedGain {
  tradeId: number;
  date: string;
  accountId: string;
  symbol: string;
  quantity: number;
  proceedsBase: number;
  costBase: number;
  gainBase: number;
}

export interface Ledger {
  positions: Position[];
  realized: RealizedGain[];
}

const positionKey = (accountId: string, symbol: string) => `${accountId}\u0000${symbol}`;

export const tradeAmount = (trade: Pick<Trade, 'quantity' | 'price'>, security: Security) =>
  (trade.quantity * trade.price) / security.priceUnit;

export const sortTrades = (trades: Trade[]) =>
  [...trades].sort((a, b) =>
    a.tradeDate === b.tradeDate ? a.id - b.id : a.tradeDate < b.tradeDate ? -1 : 1,
  );

/**
 * Replays every trade in date order with the moving-average cost method
 * (移動平均法、国内の株式譲渡益計算で使われる総平均法に準ずる方法と同じ結果).
 * Throws when a sell exceeds the quantity held at that point in time.
 */
export function replay(trades: Trade[], securities: Map<string, Security>): Ledger {
  const positions = new Map<string, Position>();
  const realized: RealizedGain[] = [];
  for (const trade of sortTrades(trades)) {
    const security = securities.get(trade.symbol);
    if (!security) throw new PortfolioError(`銘柄 ${trade.symbol} が登録されていません。`);
    const key = positionKey(trade.accountId, trade.symbol);
    const position = positions.get(key) ?? {
      accountId: trade.accountId,
      symbol: trade.symbol,
      quantity: 0,
      costLocal: 0,
      costBase: 0,
    };
    positions.set(key, position);
    const gross = tradeAmount(trade, security);
    if (trade.side === 'buy') {
      position.quantity += trade.quantity;
      position.costLocal += gross + trade.fee;
      position.costBase += (gross + trade.fee) * trade.fxRate;
      continue;
    }
    if (trade.quantity > position.quantity + EPSILON)
      throw new PortfolioError(
        `${trade.tradeDate} の売却（取引 #${trade.id || '新規'}、${trade.accountId} / ${trade.symbol}、${trade.quantity}）が、その時点の保有数量 ${round(position.quantity, 6)} を超えています。`,
      );
    const ratio = Math.min(1, trade.quantity / position.quantity);
    const removedLocal = position.costLocal * ratio;
    const removedBase = position.costBase * ratio;
    const proceedsBase = (gross - trade.fee) * trade.fxRate;
    realized.push({
      tradeId: trade.id,
      date: trade.tradeDate,
      accountId: trade.accountId,
      symbol: trade.symbol,
      quantity: trade.quantity,
      proceedsBase,
      costBase: removedBase,
      gainBase: proceedsBase - removedBase,
    });
    position.quantity -= trade.quantity;
    position.costLocal -= removedLocal;
    position.costBase -= removedBase;
    if (position.quantity < EPSILON) {
      position.quantity = 0;
      position.costLocal = 0;
      position.costBase = 0;
    }
  }
  return {
    positions: [...positions.values()].filter((p) => p.quantity > 0),
    realized,
  };
}

export interface Holding {
  accountId: string;
  symbol: string;
  name: string;
  currency: string;
  assetType: Security['assetType'];
  sector: string | null;
  quantity: number;
  /** Average cost per quoted price unit, in the security's currency. */
  averageCost: number;
  price: number | null;
  priceAsOf: string | null;
  fxRate: number;
  /** True when no current FX rate is registered and the trade-time average is used. */
  fxEstimated: boolean;
  marketValue: number;
  costBasis: number;
  unrealized: number;
  unrealizedPct: number | null;
  weight: number;
}

export interface Totals {
  marketValue: number;
  costBasis: number;
  unrealized: number;
  unrealizedPct: number | null;
}

export interface Valuation {
  holdings: Holding[];
  totals: Totals;
  missingPrices: string[];
  missingFx: string[];
}

export function value(
  positions: Position[],
  securities: Map<string, Security>,
  prices: Map<string, Price>,
  fxRates: Map<string, FxRate>,
  baseCurrency: string,
): Valuation {
  const missingPrices = new Set<string>();
  const missingFx = new Set<string>();
  const holdings = positions.map((position): Holding => {
    const security = securities.get(position.symbol)!;
    const quote = prices.get(position.symbol);
    const averageCost = (position.costLocal / position.quantity) * security.priceUnit;
    const current = fxRates.get(security.currency);
    let fxRate = 1;
    let fxEstimated = false;
    if (security.currency !== baseCurrency) {
      if (current) fxRate = current.rate;
      else {
        fxRate = position.costLocal > 0 ? position.costBase / position.costLocal : 1;
        fxEstimated = true;
        missingFx.add(security.currency);
      }
    }
    if (!quote) missingPrices.add(position.symbol);
    // Without a quote, value the position at cost so totals stay meaningful.
    const marketValue = quote
      ? ((position.quantity * quote.price) / security.priceUnit) * fxRate
      : position.costBase;
    return {
      accountId: position.accountId,
      symbol: position.symbol,
      name: security.name,
      currency: security.currency,
      assetType: security.assetType,
      sector: security.sector,
      quantity: position.quantity,
      averageCost,
      price: quote?.price ?? null,
      priceAsOf: quote?.asOf ?? null,
      fxRate,
      fxEstimated,
      marketValue,
      costBasis: position.costBase,
      unrealized: marketValue - position.costBase,
      unrealizedPct:
        position.costBase > 0 ? (marketValue - position.costBase) / position.costBase : null,
      weight: 0,
    };
  });
  const totals = sumTotals(holdings);
  for (const holding of holdings)
    holding.weight = totals.marketValue > 0 ? holding.marketValue / totals.marketValue : 0;
  holdings.sort((a, b) => b.marketValue - a.marketValue);
  return {
    holdings,
    totals,
    missingPrices: [...missingPrices].sort(),
    missingFx: [...missingFx].sort(),
  };
}

export function sumTotals(holdings: Pick<Holding, 'marketValue' | 'costBasis'>[]): Totals {
  const marketValue = holdings.reduce((sum, h) => sum + h.marketValue, 0);
  const costBasis = holdings.reduce((sum, h) => sum + h.costBasis, 0);
  return {
    marketValue,
    costBasis,
    unrealized: marketValue - costBasis,
    unrealizedPct: costBasis > 0 ? (marketValue - costBasis) / costBasis : null,
  };
}

export interface AllocationRow {
  key: string;
  marketValue: number;
  weight: number;
}

export function allocate(
  holdings: Holding[],
  keyOf: (holding: Holding) => string,
): AllocationRow[] {
  const groups = new Map<string, number>();
  for (const holding of holdings) {
    const key = keyOf(holding);
    groups.set(key, (groups.get(key) ?? 0) + holding.marketValue);
  }
  const total = holdings.reduce((sum, h) => sum + h.marketValue, 0);
  return [...groups.entries()]
    .map(([key, marketValue]) => ({
      key,
      marketValue,
      weight: total > 0 ? marketValue / total : 0,
    }))
    .sort((a, b) => b.marketValue - a.marketValue);
}

export const round = (value: number, digits = 0) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
