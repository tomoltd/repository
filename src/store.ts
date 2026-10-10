import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  Account,
  AccountKind,
  AssetType,
  Dividend,
  FxRate,
  Price,
  Security,
  Side,
  Snapshot,
  Trade,
} from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  broker TEXT
);
CREATE TABLE IF NOT EXISTS securities (
  symbol TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  currency TEXT NOT NULL,
  asset_type TEXT NOT NULL DEFAULT 'stock',
  sector TEXT,
  market TEXT,
  price_unit REAL NOT NULL DEFAULT 1,
  note TEXT
);
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  symbol TEXT NOT NULL REFERENCES securities(symbol),
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  quantity REAL NOT NULL CHECK (quantity > 0),
  price REAL NOT NULL CHECK (price >= 0),
  fee REAL NOT NULL DEFAULT 0 CHECK (fee >= 0),
  fx_rate REAL NOT NULL DEFAULT 1 CHECK (fx_rate > 0),
  trade_date TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS trades_by_date ON trades(trade_date, id);
CREATE TABLE IF NOT EXISTS dividends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  symbol TEXT NOT NULL REFERENCES securities(symbol),
  amount REAL NOT NULL CHECK (amount >= 0),
  tax REAL NOT NULL DEFAULT 0 CHECK (tax >= 0),
  fx_rate REAL NOT NULL DEFAULT 1 CHECK (fx_rate > 0),
  paid_date TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS prices (
  symbol TEXT PRIMARY KEY REFERENCES securities(symbol),
  price REAL NOT NULL CHECK (price >= 0),
  as_of TEXT NOT NULL,
  source TEXT
);
CREATE TABLE IF NOT EXISTS fx_rates (
  currency TEXT PRIMARY KEY,
  rate REAL NOT NULL CHECK (rate > 0),
  as_of TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  date TEXT PRIMARY KEY,
  market_value REAL NOT NULL,
  cost_basis REAL NOT NULL
);
`;

type Row = Record<string, unknown>;

const str = (value: unknown) => (value == null ? null : String(value));

const toAccount = (row: Row): Account => ({
  id: String(row.id),
  name: String(row.name),
  kind: row.kind as AccountKind,
  broker: str(row.broker),
});

const toSecurity = (row: Row): Security => ({
  symbol: String(row.symbol),
  name: String(row.name),
  currency: String(row.currency),
  assetType: row.asset_type as AssetType,
  sector: str(row.sector),
  market: str(row.market),
  priceUnit: Number(row.price_unit),
  note: str(row.note),
});

const toTrade = (row: Row): Trade => ({
  id: Number(row.id),
  accountId: String(row.account_id),
  symbol: String(row.symbol),
  side: row.side as Side,
  quantity: Number(row.quantity),
  price: Number(row.price),
  fee: Number(row.fee),
  fxRate: Number(row.fx_rate),
  tradeDate: String(row.trade_date),
  note: str(row.note),
});

const toDividend = (row: Row): Dividend => ({
  id: Number(row.id),
  accountId: String(row.account_id),
  symbol: String(row.symbol),
  amount: Number(row.amount),
  tax: Number(row.tax),
  fxRate: Number(row.fx_rate),
  paidDate: String(row.paid_date),
  note: str(row.note),
});

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    const { n } = this.db.prepare('SELECT count(*) AS n FROM accounts').get() as {
      n: number;
    };
    if (n === 0)
      this.upsertAccount({
        id: 'main',
        name: 'メイン（特定口座）',
        kind: 'tokutei',
        broker: null,
      });
  }

  close() {
    this.db.close();
  }

  /** Runs `fn` in a transaction; any thrown error rolls everything back. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // Accounts

  listAccounts(): Account[] {
    return (this.db.prepare('SELECT * FROM accounts ORDER BY id').all() as Row[]).map(
      toAccount,
    );
  }

  getAccount(id: string): Account | undefined {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as
      | Row
      | undefined;
    return row && toAccount(row);
  }

  upsertAccount(account: Account) {
    this.db
      .prepare(
        `INSERT INTO accounts (id, name, kind, broker) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, broker = excluded.broker`,
      )
      .run(account.id, account.name, account.kind, account.broker);
  }

  // Securities

  listSecurities(): Security[] {
    return (
      this.db.prepare('SELECT * FROM securities ORDER BY symbol').all() as Row[]
    ).map(toSecurity);
  }

  getSecurity(symbol: string): Security | undefined {
    const row = this.db
      .prepare('SELECT * FROM securities WHERE symbol = ?')
      .get(symbol) as Row | undefined;
    return row && toSecurity(row);
  }

  upsertSecurity(security: Security) {
    this.db
      .prepare(
        `INSERT INTO securities (symbol, name, currency, asset_type, sector, market, price_unit, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(symbol) DO UPDATE SET
           name = excluded.name, currency = excluded.currency, asset_type = excluded.asset_type,
           sector = excluded.sector, market = excluded.market, price_unit = excluded.price_unit,
           note = excluded.note`,
      )
      .run(
        security.symbol,
        security.name,
        security.currency,
        security.assetType,
        security.sector,
        security.market,
        security.priceUnit,
        security.note,
      );
  }

  // Trades

  listTrades(): Trade[] {
    return (
      this.db.prepare('SELECT * FROM trades ORDER BY trade_date, id').all() as Row[]
    ).map(toTrade);
  }

  getTrade(id: number): Trade | undefined {
    const row = this.db.prepare('SELECT * FROM trades WHERE id = ?').get(id) as
      | Row
      | undefined;
    return row && toTrade(row);
  }

  insertTrade(trade: Omit<Trade, 'id'>): number {
    const result = this.db
      .prepare(
        `INSERT INTO trades (account_id, symbol, side, quantity, price, fee, fx_rate, trade_date, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        trade.accountId,
        trade.symbol,
        trade.side,
        trade.quantity,
        trade.price,
        trade.fee,
        trade.fxRate,
        trade.tradeDate,
        trade.note,
      );
    return Number(result.lastInsertRowid);
  }

  deleteTrade(id: number): boolean {
    return this.db.prepare('DELETE FROM trades WHERE id = ?').run(id).changes > 0;
  }

  // Dividends

  listDividends(): Dividend[] {
    return (
      this.db.prepare('SELECT * FROM dividends ORDER BY paid_date, id').all() as Row[]
    ).map(toDividend);
  }

  insertDividend(dividend: Omit<Dividend, 'id'>): number {
    const result = this.db
      .prepare(
        `INSERT INTO dividends (account_id, symbol, amount, tax, fx_rate, paid_date, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        dividend.accountId,
        dividend.symbol,
        dividend.amount,
        dividend.tax,
        dividend.fxRate,
        dividend.paidDate,
        dividend.note,
      );
    return Number(result.lastInsertRowid);
  }

  deleteDividend(id: number): boolean {
    return this.db.prepare('DELETE FROM dividends WHERE id = ?').run(id).changes > 0;
  }

  // Prices and FX

  listPrices(): Price[] {
    return (this.db.prepare('SELECT * FROM prices').all() as Row[]).map((row) => ({
      symbol: String(row.symbol),
      price: Number(row.price),
      asOf: String(row.as_of),
      source: str(row.source),
    }));
  }

  setPrice(price: Price) {
    this.db
      .prepare(
        `INSERT INTO prices (symbol, price, as_of, source) VALUES (?, ?, ?, ?)
         ON CONFLICT(symbol) DO UPDATE SET price = excluded.price, as_of = excluded.as_of, source = excluded.source`,
      )
      .run(price.symbol, price.price, price.asOf, price.source);
  }

  listFxRates(): FxRate[] {
    return (this.db.prepare('SELECT * FROM fx_rates').all() as Row[]).map((row) => ({
      currency: String(row.currency),
      rate: Number(row.rate),
      asOf: String(row.as_of),
    }));
  }

  setFxRate(rate: FxRate) {
    this.db
      .prepare(
        `INSERT INTO fx_rates (currency, rate, as_of) VALUES (?, ?, ?)
         ON CONFLICT(currency) DO UPDATE SET rate = excluded.rate, as_of = excluded.as_of`,
      )
      .run(rate.currency, rate.rate, rate.asOf);
  }

  // Snapshots

  listSnapshots(from?: string, to?: string): Snapshot[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM snapshots WHERE date >= ? AND date <= ? ORDER BY date',
        )
        .all(from ?? '0000-00-00', to ?? '9999-99-99') as Row[]
    ).map((row) => ({
      date: String(row.date),
      marketValue: Number(row.market_value),
      costBasis: Number(row.cost_basis),
    }));
  }

  setSnapshot(snapshot: Snapshot) {
    this.db
      .prepare(
        `INSERT INTO snapshots (date, market_value, cost_basis) VALUES (?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET market_value = excluded.market_value, cost_basis = excluded.cost_basis`,
      )
      .run(snapshot.date, snapshot.marketValue, snapshot.costBasis);
  }
}
