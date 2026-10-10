import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { PortfolioService } from '../src/service.js';
import { Store } from '../src/store.js';

let service: PortfolioService;

beforeEach(() => {
  service = new PortfolioService(new Store(':memory:'), { today: () => '2026-10-10' });
});

const close = (actual: number, expected: number, digits = 6) =>
  assert.ok(Math.abs(actual - expected) < 10 ** -digits, `${actual} ≠ ${expected}`);

describe('trades and cost basis', () => {
  it('averages cost across buys and books realized gains on sells', () => {
    service.recordTrade({ account: 'main', symbol: '7203', side: 'buy', quantity: 100, price: 2000, fee: 100, date: '2026-01-05', name: 'トヨタ自動車', currency: 'JPY' });
    service.recordTrade({ account: 'main', symbol: '7203', side: 'buy', quantity: 100, price: 3000, fee: 100, date: '2026-02-05' });
    const [held] = service.holdings();
    assert.equal(held!.quantity, 200);
    close(held!.averageCost, 2501);

    const result = service.recordTrade({ account: 'main', symbol: '7203', side: 'sell', quantity: 50, price: 3500, fee: 50, date: '2026-03-01' });
    // proceeds 175000 - 50, cost 50 * 2501
    close(result.realizedGain!, 174_950 - 125_050);
    assert.equal(result.position!.quantity, 150);
    close(result.position!.averageCost, 2501);
  });

  it('rejects sells beyond the quantity held and leaves the database unchanged', () => {
    service.recordTrade({ account: 'main', symbol: '7203', side: 'buy', quantity: 100, price: 2000, date: '2026-01-05', currency: 'JPY' });
    assert.throws(
      () => service.recordTrade({ account: 'main', symbol: '7203', side: 'sell', quantity: 101, price: 2000, date: '2026-02-01' }),
      /超えています/,
    );
    // A sell dated before the buy is also an oversell.
    assert.throws(
      () => service.recordTrade({ account: 'main', symbol: '7203', side: 'sell', quantity: 10, price: 2000, date: '2026-01-01' }),
      /超えています/,
    );
    assert.equal(service.listTrades().total, 1);
  });

  it('refuses to delete a buy that a later sell depends on', () => {
    const buy = service.recordTrade({ account: 'main', symbol: '7203', side: 'buy', quantity: 100, price: 2000, date: '2026-01-05', currency: 'JPY' });
    service.recordTrade({ account: 'main', symbol: '7203', side: 'sell', quantity: 100, price: 2100, date: '2026-02-05' });
    assert.throws(() => service.deleteTrade(buy.trade.id), /超えています/);
    assert.equal(service.listTrades().total, 2);
  });

  it('requires a currency for a new security and an fx rate for foreign trades', () => {
    assert.throws(() => service.recordTrade({ account: 'main', symbol: 'AAPL', side: 'buy', quantity: 1, price: 200 }), /currency/);
    assert.throws(() => service.recordTrade({ account: 'main', symbol: 'AAPL', side: 'buy', quantity: 1, price: 200, currency: 'USD' }), /fx_rate/);
    // The failed attempt must not leave the security behind.
    assert.equal(service.store.getSecurity('AAPL'), undefined);
  });

  it('rejects unknown accounts and invalid dates', () => {
    assert.throws(() => service.recordTrade({ account: 'nope', symbol: '7203', side: 'buy', quantity: 1, price: 1, currency: 'JPY' }), /口座 "nope"/);
    assert.throws(() => service.recordTrade({ account: 'main', symbol: '7203', side: 'buy', quantity: 1, price: 1, currency: 'JPY', date: '2026-02-30' }), /日付/);
  });
});

describe('valuation', () => {
  it('values foreign holdings at current FX and funds per 10,000 units', () => {
    service.recordTrade({ account: 'main', symbol: 'aapl', side: 'buy', quantity: 10, price: 200, fxRate: 140, date: '2026-01-05', currency: 'usd', name: 'Apple' });
    service.recordTrade({ account: 'main', symbol: 'SLIM-ACWI', side: 'buy', quantity: 100_000, price: 25_000, date: '2026-01-05', currency: 'JPY', assetType: 'fund', name: 'eMAXIS Slim 全世界株式' });

    let summary = service.summary();
    // No quotes yet: valued at cost, and flagged.
    close(summary.totals.marketValue, 10 * 200 * 140 + 250_000);
    assert.deepEqual(summary.missingPrices, ['AAPL', 'SLIM-ACWI']);
    assert.deepEqual(summary.missingFx, ['USD']);

    service.updatePrices({
      prices: [{ symbol: 'AAPL', price: 250 }, { symbol: 'slim-acwi', price: 30_000 }],
      fx: [{ currency: 'USD', rate: 150 }],
    });
    summary = service.summary();
    const aapl = summary.holdings.find((h) => h.symbol === 'AAPL')!;
    close(aapl.marketValue, 10 * 250 * 150);
    close(aapl.costBasis, 10 * 200 * 140);
    const fund = summary.holdings.find((h) => h.symbol === 'SLIM-ACWI')!;
    close(fund.marketValue, 300_000);
    close(fund.averageCost, 25_000);
    assert.deepEqual(summary.missingPrices, []);
    close(summary.allocation.currency.reduce((s, r) => s + r.weight, 0), 1);
    assert.equal(service.valueHistory().length, 1);
  });

  it('flags stale prices and skips unknown symbols on update', () => {
    service.recordTrade({ account: 'main', symbol: '7203', side: 'buy', quantity: 100, price: 2000, date: '2026-01-05', currency: 'JPY' });
    const result = service.updatePrices({ prices: [{ symbol: '7203', price: 2100, asOf: '2026-09-01' }, { symbol: '9999', price: 1 }] });
    assert.deepEqual(result.unknownSymbols, ['9999']);
    assert.deepEqual(service.summary().stalePrices, [{ symbol: '7203', asOf: '2026-09-01' }]);
  });
});

describe('reports', () => {
  it('separates NISA gains from taxable gains and estimates tax', () => {
    service.upsertAccount({ id: 'nisa', name: 'NISA', kind: 'nisa_growth' });
    service.recordTrade({ account: 'main', symbol: '7203', side: 'buy', quantity: 100, price: 2000, date: '2026-01-05', currency: 'JPY' });
    service.recordTrade({ account: 'main', symbol: '7203', side: 'sell', quantity: 100, price: 3000, date: '2026-02-05' });
    service.recordTrade({ account: 'nisa', symbol: '7203', side: 'buy', quantity: 100, price: 2000, date: '2026-01-05' });
    service.recordTrade({ account: 'nisa', symbol: '7203', side: 'sell', quantity: 100, price: 2500, date: '2026-02-05' });
    const { totals } = service.realizedGains('2026');
    close(totals.taxableGain, 100_000);
    close(totals.nisaGain, 50_000);
    close(totals.estimatedTax, 20_315);
    assert.equal(service.realizedGains('2025').rows.length, 0);
  });

  it('tracks NISA annual and lifetime usage', () => {
    service.upsertAccount({ id: 'nisa_g', name: 'NISA 成長', kind: 'nisa_growth' });
    service.upsertAccount({ id: 'nisa_t', name: 'NISA つみたて', kind: 'nisa_tsumitate' });
    service.recordTrade({ account: 'nisa_g', symbol: '7203', side: 'buy', quantity: 100, price: 3000, date: '2026-03-01', currency: 'JPY' });
    service.recordTrade({ account: 'nisa_g', symbol: '7203', side: 'buy', quantity: 100, price: 3000, date: '2025-03-01' });
    service.recordTrade({ account: 'nisa_t', symbol: 'FUND', side: 'buy', quantity: 400_000, price: 25_000, date: '2026-04-01', currency: 'JPY', assetType: 'fund' });
    const usage = service.nisaUsage('2026');
    close(usage.annual.growth.used, 300_000);
    close(usage.annual.growth.remaining, 2_100_000);
    close(usage.annual.tsumitate.used, 1_000_000);
    close(usage.lifetime.used, 1_600_000);
    close(usage.lifetime.growthUsed, 600_000);
  });

  it('summarizes dividends in base currency', () => {
    service.recordTrade({ account: 'main', symbol: 'AAPL', side: 'buy', quantity: 10, price: 200, fxRate: 150, date: '2026-01-05', currency: 'USD' });
    service.recordDividend({ account: 'main', symbol: 'AAPL', amount: 10, tax: 1, fxRate: 150, date: '2026-05-15' });
    service.recordDividend({ account: 'main', symbol: 'AAPL', amount: 10, tax: 1, fxRate: 140, date: '2025-05-15' });
    const report = service.dividendReport('2026');
    close(report.totals.gross, 1500);
    close(report.totals.net, 1350);
    assert.deepEqual(report.byMonth, [{ month: '2026-05', net: 1350 }]);
  });
});

describe('CSV import', () => {
  const csv = [
    '約定日,口座,銘柄コード,銘柄名,売買,数量,単価,手数料,通貨',
    '2026/1/5,main,7203,トヨタ自動車,買付,100,"2,000",0,JPY',
    '2026/2/5,main,7203,,売付,50,2500,0,',
  ].join('\r\n');

  it('validates in dry run without writing, then imports', () => {
    assert.deepEqual(service.importTradesCsv(csv, { dryRun: true }), { imported: 0, validated: 2, dryRun: true });
    assert.equal(service.listTrades().total, 0);
    assert.equal(service.store.getSecurity('7203'), undefined);
    assert.equal(service.importTradesCsv(csv).imported, 2);
    assert.equal(service.holdings()[0]!.quantity, 50);
  });

  it('imports nothing when any row is invalid', () => {
    const bad = `${csv}\n2026/3/1,main,7203,,売付,999,2500,0,`;
    assert.throws(() => service.importTradesCsv(bad), /4 行目.*超えています/s);
    assert.equal(service.listTrades().total, 0);
    assert.throws(() => service.importTradesCsv(`${csv}\n2026/13/1,main,7203,,?,x,1,0,`), /4 行目/);
  });
});
