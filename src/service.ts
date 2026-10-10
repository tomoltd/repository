import { parseDate, parseNumber, parseSide, readTradeRows } from './csv.js';
import {
  allocate,
  PortfolioError,
  replay,
  tradeAmount,
  value,
  type Holding,
  type Ledger,
} from './portfolio.js';
import type { Store } from './store.js';
import {
  ACCOUNT_KIND_LABELS,
  ASSET_TYPE_LABELS,
  type Account,
  type AccountKind,
  type AssetType,
  type Security,
  type Side,
  type Trade,
} from './types.js';

/** 上場株式等の譲渡益・配当にかかる税率（所得税 15.315% + 住民税 5%）。 */
export const CAPITAL_GAINS_TAX_RATE = 0.20315;

/** 2024 年からの新 NISA の非課税投資枠。 */
export const NISA_LIMITS = {
  growthAnnual: 2_400_000,
  tsumitateAnnual: 1_200_000,
  lifetime: 18_000_000,
  growthLifetime: 12_000_000,
};

const STALE_PRICE_DAYS = 7;

const NISA_KINDS: AccountKind[] = ['nisa_growth', 'nisa_tsumitate'];

export const normalizeSymbol = (symbol: string) => symbol.trim().toUpperCase();
export const normalizeCurrency = (currency: string) => currency.trim().toUpperCase();

export function isValidDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export interface TradeInput {
  account: string;
  symbol: string;
  side: Side;
  quantity: number;
  price: number;
  fee?: number;
  fxRate?: number;
  date?: string;
  note?: string;
  /** Used only when the security is not registered yet. */
  name?: string;
  currency?: string;
  assetType?: AssetType;
  priceUnit?: number;
}

export interface SecurityInput {
  symbol: string;
  name?: string;
  currency?: string;
  assetType?: AssetType;
  sector?: string | null;
  market?: string | null;
  priceUnit?: number;
  note?: string | null;
}

export interface ServiceOptions {
  baseCurrency?: string;
  timeZone?: string;
  /** Overrides the clock in tests. */
  today?: () => string;
}

export class PortfolioService {
  readonly baseCurrency: string;
  private readonly todayFn: () => string;

  constructor(
    readonly store: Store,
    options: ServiceOptions = {},
  ) {
    this.baseCurrency = normalizeCurrency(options.baseCurrency ?? 'JPY');
    const timeZone = options.timeZone ?? 'Asia/Tokyo';
    this.todayFn =
      options.today ?? (() => new Date().toLocaleDateString('sv-SE', { timeZone }));
  }

  today() {
    return this.todayFn();
  }

  private securities() {
    return new Map(this.store.listSecurities().map((s) => [s.symbol, s]));
  }

  private accounts() {
    return new Map(this.store.listAccounts().map((a) => [a.id, a]));
  }

  private requireAccount(id: string): Account {
    const account = this.store.getAccount(id.trim());
    if (!account) {
      const known = this.store
        .listAccounts()
        .map((a) => `${a.id}（${a.name}）`)
        .join(', ');
      throw new PortfolioError(
        `口座 "${id}" はありません。登録済みの口座: ${known || 'なし'}。新しい口座は upsert_account で作成してください。`,
      );
    }
    return account;
  }

  ledger(): Ledger {
    return replay(this.store.listTrades(), this.securities());
  }

  valuation(accountId?: string) {
    const ledger = this.ledger();
    const positions = accountId
      ? ledger.positions.filter((p) => p.accountId === accountId)
      : ledger.positions;
    return value(
      positions,
      this.securities(),
      new Map(this.store.listPrices().map((p) => [p.symbol, p])),
      new Map(this.store.listFxRates().map((r) => [r.currency, r])),
      this.baseCurrency,
    );
  }

  summary(accountId?: string) {
    if (accountId) this.requireAccount(accountId);
    const accounts = this.accounts();
    const valuation = this.valuation(accountId);
    const { holdings } = valuation;
    const today = this.today();
    const staleBefore = shiftDate(today, -STALE_PRICE_DAYS);
    const year = today.slice(0, 4);
    return {
      baseCurrency: this.baseCurrency,
      asOf: today,
      totals: valuation.totals,
      holdings,
      allocation: {
        account: allocate(holdings, (h) => accounts.get(h.accountId)?.name ?? h.accountId),
        assetType: allocate(holdings, (h) => ASSET_TYPE_LABELS[h.assetType]),
        sector: allocate(holdings, (h) => h.sector ?? '未分類'),
        currency: allocate(holdings, (h) => h.currency),
      },
      realizedThisYear: this.realizedGains(year, accountId).totals,
      dividendsThisYear: this.dividendReport(year, accountId).totals,
      missingPrices: valuation.missingPrices,
      missingFx: valuation.missingFx,
      stalePrices: holdings
        .filter((h) => h.priceAsOf !== null && h.priceAsOf < staleBefore)
        .map((h) => ({ symbol: h.symbol, asOf: h.priceAsOf! })),
    };
  }

  holdings(filter: { account?: string; symbol?: string } = {}): Holding[] {
    if (filter.account) this.requireAccount(filter.account);
    const symbol = filter.symbol && normalizeSymbol(filter.symbol);
    return this.valuation(filter.account).holdings.filter(
      (h) => !symbol || h.symbol === symbol,
    );
  }

  listTrades(
    filter: { account?: string; symbol?: string; from?: string; to?: string; limit?: number } = {},
  ) {
    const symbol = filter.symbol && normalizeSymbol(filter.symbol);
    const trades = this.store
      .listTrades()
      .filter(
        (t) =>
          (!filter.account || t.accountId === filter.account) &&
          (!symbol || t.symbol === symbol) &&
          (!filter.from || t.tradeDate >= filter.from) &&
          (!filter.to || t.tradeDate <= filter.to),
      );
    const limit = filter.limit ?? 100;
    // Newest first, so a limit keeps the most recent trades.
    return { total: trades.length, trades: trades.reverse().slice(0, limit) };
  }

  // Master data

  upsertAccount(input: { id: string; name: string; kind: AccountKind; broker?: string | null }) {
    const id = input.id.trim();
    if (!/^[a-z0-9_-]{1,32}$/i.test(id))
      throw new PortfolioError('口座 ID は英数字・_・- の 32 文字以内で指定してください。');
    const account: Account = {
      id,
      name: input.name.trim(),
      kind: input.kind,
      broker: input.broker?.trim() || null,
    };
    this.store.upsertAccount(account);
    return account;
  }

  upsertSecurity(input: SecurityInput): Security {
    const symbol = normalizeSymbol(input.symbol);
    const existing = this.store.getSecurity(symbol);
    const currency = input.currency
      ? normalizeCurrency(input.currency)
      : (existing?.currency ?? undefined);
    if (!currency)
      throw new PortfolioError(
        `新しい銘柄 ${symbol} には通貨（currency、例: JPY / USD）が必要です。`,
      );
    const assetType = input.assetType ?? existing?.assetType ?? 'stock';
    const security: Security = {
      symbol,
      name: input.name?.trim() || existing?.name || symbol,
      currency,
      assetType,
      sector: input.sector !== undefined ? input.sector?.trim() || null : (existing?.sector ?? null),
      market: input.market !== undefined ? input.market?.trim() || null : (existing?.market ?? null),
      priceUnit:
        input.priceUnit ??
        existing?.priceUnit ??
        (assetType === 'fund' && currency === 'JPY' ? 10_000 : 1),
      note: input.note !== undefined ? input.note?.trim() || null : (existing?.note ?? null),
    };
    if (!(security.priceUnit > 0)) throw new PortfolioError('price_unit は正の数にしてください。');
    if (
      existing &&
      existing.currency !== security.currency &&
      this.store.listTrades().some((t) => t.symbol === symbol)
    )
      throw new PortfolioError(
        `${symbol} には取引があるため通貨を ${existing.currency} から変更できません。`,
      );
    this.store.upsertSecurity(security);
    return security;
  }

  // Trades

  private prepareTrade(input: TradeInput): Omit<Trade, 'id'> {
    const account = this.requireAccount(input.account);
    const symbol = normalizeSymbol(input.symbol);
    let security = this.store.getSecurity(symbol);
    if (!security) {
      if (!input.currency)
        throw new PortfolioError(
          `銘柄 ${symbol} は未登録です。初回は currency（例: JPY / USD）と name を指定してください。`,
        );
      security = this.upsertSecurity({
        symbol,
        name: input.name,
        currency: input.currency,
        assetType: input.assetType,
        priceUnit: input.priceUnit,
      });
    }
    const tradeDate = input.date ?? this.today();
    if (!isValidDate(tradeDate))
      throw new PortfolioError(`日付 ${tradeDate} が不正です（YYYY-MM-DD）。`);
    if (!(input.quantity > 0)) throw new PortfolioError('数量は正の数にしてください。');
    if (!(input.price >= 0)) throw new PortfolioError('単価は 0 以上にしてください。');
    const fee = input.fee ?? 0;
    if (!(fee >= 0)) throw new PortfolioError('手数料は 0 以上にしてください。');
    let fxRate = 1;
    if (security.currency !== this.baseCurrency) {
      const current = this.store.listFxRates().find((r) => r.currency === security.currency);
      const rate = input.fxRate ?? current?.rate;
      if (!rate || !(rate > 0))
        throw new PortfolioError(
          `${security.currency} 建ての取引には約定時の為替レート fx_rate（1 ${security.currency} あたりの ${this.baseCurrency}）が必要です。`,
        );
      fxRate = rate;
    }
    return {
      accountId: account.id,
      symbol,
      side: input.side,
      quantity: input.quantity,
      price: input.price,
      fee,
      fxRate,
      tradeDate,
      note: input.note?.trim() || null,
    };
  }

  /** Validates the whole history after `mutate`; rolls back if any sell becomes impossible. */
  private mutateTrades<T>(mutate: () => T): T {
    return this.store.transaction(() => {
      const result = mutate();
      this.ledger();
      return result;
    });
  }

  recordTrade(input: TradeInput) {
    const { id, trade } = this.mutateTrades(() => {
      const trade = this.prepareTrade(input);
      return { id: this.store.insertTrade(trade), trade };
    });
    const security = this.store.getSecurity(trade.symbol)!;
    const realized = this.ledger().realized.find((r) => r.tradeId === id);
    return {
      trade: { id, ...trade },
      amount: tradeAmount(trade, security),
      position: this.holdings({ account: trade.accountId, symbol: trade.symbol })[0] ?? null,
      realizedGain: realized?.gainBase ?? null,
    };
  }

  deleteTrade(id: number) {
    const trade = this.store.getTrade(id);
    if (!trade) throw new PortfolioError(`取引 #${id} はありません。`);
    this.mutateTrades(() => this.store.deleteTrade(id));
    return trade;
  }

  importTradesCsv(csv: string, options: { defaultAccount?: string; dryRun?: boolean } = {}) {
    const rows = readTradeRows(csv);
    if (rows.length === 0) throw new PortfolioError('CSV にデータ行がありません。');
    if (rows.length > 2000) throw new PortfolioError('一度に取り込めるのは 2000 行までです。');
    const errors: string[] = [];
    const inputs: TradeInput[] = [];
    for (const { line, values } of rows) {
      const side = parseSide(values.side ?? '');
      const date = parseDate(values.date ?? '');
      const quantity = parseNumber(values.quantity);
      const price = parseNumber(values.price);
      const fee = parseNumber(values.fee);
      const fxRate = parseNumber(values.fx_rate);
      const account = values.account || options.defaultAccount || 'main';
      const problems = [
        !side && `売買区分 "${values.side ?? ''}" を解釈できません`,
        (!date || !isValidDate(date)) && `日付 "${values.date ?? ''}" が不正です`,
        !(quantity! > 0) && `数量 "${values.quantity ?? ''}" が不正です`,
        !(price! >= 0) && `単価 "${values.price ?? ''}" が不正です`,
        Number.isNaN(fee) && `手数料 "${values.fee}" が不正です`,
        Number.isNaN(fxRate) && `為替 "${values.fx_rate}" が不正です`,
        !values.symbol && '銘柄コードが空です',
      ].filter(Boolean);
      if (problems.length) {
        errors.push(`${line} 行目: ${problems.join('、')}`);
        continue;
      }
      inputs.push({
        account,
        symbol: values.symbol!,
        side: side!,
        quantity: quantity!,
        price: price!,
        fee,
        fxRate,
        date,
        note: values.note,
        name: values.name,
        currency: values.currency,
        assetType: parseAssetType(values.asset_type),
      });
    }
    if (errors.length) throw new PortfolioError(`取り込みを中止しました。\n${errors.join('\n')}`);
    const apply = () =>
      inputs.map((input, index) => {
        try {
          return this.store.insertTrade(this.prepareTrade(input));
        } catch (error) {
          throw new PortfolioError(
            `${rows[index]!.line} 行目: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
    if (options.dryRun) {
      // Run the import inside a transaction that always rolls back.
      try {
        this.store.transaction(() => {
          apply();
          this.ledger();
          throw new DryRun();
        });
      } catch (error) {
        if (!(error instanceof DryRun)) throw error;
      }
      return { imported: 0, validated: inputs.length, dryRun: true };
    }
    const ids = this.mutateTrades(apply);
    return { imported: ids.length, validated: inputs.length, dryRun: false };
  }

  // Dividends

  recordDividend(input: {
    account: string;
    symbol: string;
    amount: number;
    tax?: number;
    fxRate?: number;
    date?: string;
    note?: string;
  }) {
    const account = this.requireAccount(input.account);
    const symbol = normalizeSymbol(input.symbol);
    const security = this.store.getSecurity(symbol);
    if (!security) throw new PortfolioError(`銘柄 ${symbol} は未登録です。`);
    const paidDate = input.date ?? this.today();
    if (!isValidDate(paidDate)) throw new PortfolioError(`日付 ${paidDate} が不正です。`);
    if (!(input.amount >= 0)) throw new PortfolioError('金額は 0 以上にしてください。');
    const tax = input.tax ?? 0;
    if (!(tax >= 0) || tax > input.amount)
      throw new PortfolioError('源泉徴収税額は 0 以上、配当金額以下にしてください。');
    let fxRate = 1;
    if (security.currency !== this.baseCurrency) {
      const rate =
        input.fxRate ??
        this.store.listFxRates().find((r) => r.currency === security.currency)?.rate;
      if (!rate || !(rate > 0))
        throw new PortfolioError(`${security.currency} 建ての配当には fx_rate が必要です。`);
      fxRate = rate;
    }
    const dividend = {
      accountId: account.id,
      symbol,
      amount: input.amount,
      tax,
      fxRate,
      paidDate,
      note: input.note?.trim() || null,
    };
    return { id: this.store.insertDividend(dividend), ...dividend };
  }

  deleteDividend(id: number) {
    if (!this.store.deleteDividend(id)) throw new PortfolioError(`配当 #${id} はありません。`);
  }

  // Prices

  updatePrices(input: {
    prices?: { symbol: string; price: number; asOf?: string }[];
    fx?: { currency: string; rate: number; asOf?: string }[];
    source?: string;
  }) {
    const today = this.today();
    const unknown: string[] = [];
    const updated = this.store.transaction(() => {
      let count = 0;
      for (const item of input.fx ?? []) {
        const currency = normalizeCurrency(item.currency);
        if (currency === this.baseCurrency) continue;
        if (!(item.rate > 0)) throw new PortfolioError(`${currency} のレートが不正です。`);
        const asOf = item.asOf ?? today;
        if (!isValidDate(asOf)) throw new PortfolioError(`日付 ${asOf} が不正です。`);
        this.store.setFxRate({ currency, rate: item.rate, asOf });
        count++;
      }
      for (const item of input.prices ?? []) {
        const symbol = normalizeSymbol(item.symbol);
        if (!this.store.getSecurity(symbol)) {
          unknown.push(symbol);
          continue;
        }
        if (!(item.price >= 0)) throw new PortfolioError(`${symbol} の価格が不正です。`);
        const asOf = item.asOf ?? today;
        if (!isValidDate(asOf)) throw new PortfolioError(`日付 ${asOf} が不正です。`);
        this.store.setPrice({ symbol, price: item.price, asOf, source: input.source ?? null });
        count++;
      }
      return count;
    });
    const { totals, missingPrices } = this.valuation();
    this.store.setSnapshot({
      date: today,
      marketValue: totals.marketValue,
      costBasis: totals.costBasis,
    });
    return { updated, unknownSymbols: unknown, totals, missingPrices };
  }

  /** Symbols currently held, with the quote currency and last price date, for price lookups. */
  priceTargets() {
    const prices = new Map(this.store.listPrices().map((p) => [p.symbol, p]));
    const held = new Set(this.ledger().positions.map((p) => p.symbol));
    const securities = this.store.listSecurities().filter((s) => held.has(s.symbol));
    const currencies = [
      ...new Set(securities.map((s) => s.currency).filter((c) => c !== this.baseCurrency)),
    ];
    const fx = new Map(this.store.listFxRates().map((r) => [r.currency, r]));
    return {
      securities: securities.map((s) => ({
        symbol: s.symbol,
        name: s.name,
        currency: s.currency,
        market: s.market,
        assetType: s.assetType,
        priceUnit: s.priceUnit,
        lastPrice: prices.get(s.symbol)?.price ?? null,
        lastAsOf: prices.get(s.symbol)?.asOf ?? null,
      })),
      currencies: currencies.map((c) => ({
        currency: c,
        lastRate: fx.get(c)?.rate ?? null,
        lastAsOf: fx.get(c)?.asOf ?? null,
      })),
    };
  }

  // Reports

  realizedGains(year?: string, accountId?: string) {
    const accounts = this.accounts();
    const rows = this.ledger().realized.filter(
      (r) => (!year || r.date.startsWith(year)) && (!accountId || r.accountId === accountId),
    );
    const isNisa = (id: string) => NISA_KINDS.includes(accounts.get(id)?.kind ?? 'other');
    const taxable = rows.filter((r) => !isNisa(r.accountId)).reduce((s, r) => s + r.gainBase, 0);
    const nisa = rows.filter((r) => isNisa(r.accountId)).reduce((s, r) => s + r.gainBase, 0);
    return {
      year: year ?? null,
      rows,
      totals: {
        gain: taxable + nisa,
        taxableGain: taxable,
        nisaGain: nisa,
        estimatedTax: Math.max(0, taxable) * CAPITAL_GAINS_TAX_RATE,
      },
    };
  }

  dividendReport(year?: string, accountId?: string) {
    const securities = this.securities();
    const rows = this.store
      .listDividends()
      .filter(
        (d) => (!year || d.paidDate.startsWith(year)) && (!accountId || d.accountId === accountId),
      )
      .map((d) => ({
        ...d,
        name: securities.get(d.symbol)?.name ?? d.symbol,
        grossBase: d.amount * d.fxRate,
        taxBase: d.tax * d.fxRate,
        netBase: (d.amount - d.tax) * d.fxRate,
      }));
    const bySymbol = new Map<string, { symbol: string; name: string; gross: number; net: number }>();
    const byMonth = new Map<string, number>();
    for (const row of rows) {
      const entry = bySymbol.get(row.symbol) ?? { symbol: row.symbol, name: row.name, gross: 0, net: 0 };
      entry.gross += row.grossBase;
      entry.net += row.netBase;
      bySymbol.set(row.symbol, entry);
      const month = row.paidDate.slice(0, 7);
      byMonth.set(month, (byMonth.get(month) ?? 0) + row.netBase);
    }
    return {
      year: year ?? null,
      rows,
      bySymbol: [...bySymbol.values()].sort((a, b) => b.net - a.net),
      byMonth: [...byMonth.entries()].sort().map(([month, net]) => ({ month, net })),
      totals: {
        gross: rows.reduce((s, r) => s + r.grossBase, 0),
        tax: rows.reduce((s, r) => s + r.taxBase, 0),
        net: rows.reduce((s, r) => s + r.netBase, 0),
      },
    };
  }

  nisaUsage(year?: string) {
    const target = year ?? this.today().slice(0, 4);
    const accounts = this.accounts();
    const securities = this.securities();
    const kindOf = (id: string) => accounts.get(id)?.kind;
    const purchases = { nisa_growth: 0, nisa_tsumitate: 0 };
    for (const trade of this.store.listTrades()) {
      const kind = kindOf(trade.accountId);
      if (trade.side !== 'buy' || !trade.tradeDate.startsWith(target)) continue;
      if (kind === 'nisa_growth' || kind === 'nisa_tsumitate')
        purchases[kind] += tradeAmount(trade, securities.get(trade.symbol)!) * trade.fxRate;
    }
    const book = { nisa_growth: 0, nisa_tsumitate: 0 };
    for (const position of this.ledger().positions) {
      const kind = kindOf(position.accountId);
      if (kind === 'nisa_growth' || kind === 'nisa_tsumitate') book[kind] += position.costBase;
    }
    const lifetimeUsed = book.nisa_growth + book.nisa_tsumitate;
    return {
      year: target,
      annual: {
        growth: {
          used: purchases.nisa_growth,
          limit: NISA_LIMITS.growthAnnual,
          remaining: Math.max(0, NISA_LIMITS.growthAnnual - purchases.nisa_growth),
        },
        tsumitate: {
          used: purchases.nisa_tsumitate,
          limit: NISA_LIMITS.tsumitateAnnual,
          remaining: Math.max(0, NISA_LIMITS.tsumitateAnnual - purchases.nisa_tsumitate),
        },
      },
      lifetime: {
        used: lifetimeUsed,
        limit: NISA_LIMITS.lifetime,
        remaining: Math.max(0, NISA_LIMITS.lifetime - lifetimeUsed),
        growthUsed: book.nisa_growth,
        growthLimit: NISA_LIMITS.growthLifetime,
      },
    };
  }

  valueHistory(from?: string, to?: string) {
    return this.store.listSnapshots(from, to);
  }
}

class DryRun extends Error {}

const parseAssetType = (value: string | undefined): AssetType | undefined => {
  if (!value) return undefined;
  const key = value.trim().toLowerCase();
  const match = Object.entries(ASSET_TYPE_LABELS).find(
    ([type, label]) => type === key || label.toLowerCase() === key,
  );
  return match?.[0] as AssetType | undefined;
};

export function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export const accountKindLabel = (kind: AccountKind) => ACCOUNT_KIND_LABELS[kind];
