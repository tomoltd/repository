import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { lines, money, num, pct, signedMoney, table } from './format.js';
import { PortfolioError } from './portfolio.js';
import { accountKindLabel, PortfolioService } from './service.js';
import { ACCOUNT_KINDS, ASSET_TYPE_LABELS, ASSET_TYPES } from './types.js';

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('YYYY-MM-DD');
const year = z
  .string()
  .regex(/^\d{4}$/)
  .describe('西暦 4 桁（例: 2026）');
const account = z.string().min(1).max(32).describe('口座 ID（list_accounts で確認）');
const symbol = z
  .string()
  .min(1)
  .max(32)
  .describe('銘柄コード。日本株は 7203 のような 4 桁コード、米国株は AAPL などのティッカー');

const READ = { readOnlyHint: true, openWorldHint: false } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

const ok = (text: string, data?: unknown): CallToolResult => ({
  content: [{ type: 'text', text }],
  ...(data !== undefined ? { structuredContent: { result: data } } : {}),
});

const guard =
  <A>(fn: (args: A) => CallToolResult) =>
  (args: A): CallToolResult => {
    try {
      return fn(args);
    } catch (error) {
      if (error instanceof PortfolioError || error instanceof z.ZodError)
        return { isError: true, content: [{ type: 'text', text: error.message }] };
      if (error instanceof Error && /constraint/i.test(error.message))
        return { isError: true, content: [{ type: 'text', text: `入力が不正です: ${error.message}` }] };
      throw error;
    }
  };

export function createMcpServer(service: PortfolioService) {
  const server = new McpServer(
    { name: 'opendots-portfolio', version: '0.1.0' },
    {
      instructions: `保有銘柄（ポートフォリオ）を管理するツール群です。基準通貨は ${service.baseCurrency}。取引は移動平均法で取得単価を計算します。価格は自動取得しないため、最新価格を調べたら update_prices で登録してください。`,
    },
  );
  const base = service.baseCurrency;

  // ---- Read-only ----

  server.registerTool(
    'portfolio_summary',
    {
      title: 'ポートフォリオ概要',
      description: `評価額・取得額・含み損益の合計、保有銘柄一覧、口座/資産クラス/セクター/通貨別の配分、今年の実現損益と配当を返します。価格未登録や 7 日以上古い価格があれば警告します。金額は ${base}。`,
      inputSchema: { account: account.optional() },
      annotations: READ,
    },
    guard(({ account }) => {
      const s = service.summary(account);
      const allocation = (title: string, rows: { key: string; marketValue: number; weight: number }[]) =>
        lines(`### ${title}`, table(['区分', '評価額', '比率'], rows.map((r) => [r.key, money(r.marketValue), pct(r.weight)])));
      const text = lines(
        `## ポートフォリオ概要（${s.asOf} 時点、${base}）`,
        `- 評価額: ${money(s.totals.marketValue)}`,
        `- 取得額: ${money(s.totals.costBasis)}`,
        `- 含み損益: ${signedMoney(s.totals.unrealized)}（${pct(s.totals.unrealizedPct, true)}）`,
        `- 今年の実現損益: ${signedMoney(s.realizedThisYear.gain)}（課税口座 ${signedMoney(s.realizedThisYear.taxableGain)} / NISA ${signedMoney(s.realizedThisYear.nisaGain)}）`,
        `- 今年の受取配当（税引後）: ${money(s.dividendsThisYear.net)}`,
        '',
        '### 保有銘柄',
        table(
          ['口座', '銘柄', '名称', '数量', '平均取得単価', '現在値', '評価額', '含み損益', '損益率', '比率'],
          s.holdings.map((h) => [
            h.accountId,
            h.symbol,
            h.name,
            num(h.quantity),
            `${num(h.averageCost)} ${h.currency}`,
            h.price === null ? '未登録' : `${num(h.price)} ${h.currency}`,
            money(h.marketValue),
            signedMoney(h.unrealized),
            pct(h.unrealizedPct, true),
            pct(h.weight),
          ]),
        ),
        '',
        allocation('口座別', s.allocation.account),
        '',
        allocation('資産クラス別', s.allocation.assetType),
        '',
        allocation('セクター別', s.allocation.sector),
        '',
        allocation('通貨別', s.allocation.currency),
        s.missingPrices.length > 0 &&
          `\n⚠ 価格未登録（取得額で評価）: ${s.missingPrices.join(', ')}`,
        s.missingFx.length > 0 &&
          `⚠ 為替レート未登録（取得時平均レートで評価）: ${s.missingFx.join(', ')}`,
        s.stalePrices.length > 0 &&
          `⚠ 価格が 7 日以上古い: ${s.stalePrices.map((p) => `${p.symbol}(${p.asOf})`).join(', ')}`,
      );
      return ok(text, s);
    }),
  );

  server.registerTool(
    'list_holdings',
    {
      title: '保有銘柄一覧',
      description: '現在の保有銘柄を口座・銘柄で絞り込んで返します（数量、平均取得単価、評価額、含み損益）。',
      inputSchema: { account: account.optional(), symbol: symbol.optional() },
      annotations: READ,
    },
    guard(({ account, symbol }) => {
      const holdings = service.holdings({ account, symbol });
      return ok(
        table(
          ['口座', '銘柄', '名称', '種別', 'セクター', '数量', '平均取得単価', '現在値(日付)', `評価額(${base})`, `取得額(${base})`, '含み損益', '損益率'],
          holdings.map((h) => [
            h.accountId,
            h.symbol,
            h.name,
            ASSET_TYPE_LABELS[h.assetType],
            h.sector ?? '',
            num(h.quantity),
            `${num(h.averageCost)} ${h.currency}`,
            h.price === null ? '未登録' : `${num(h.price)} (${h.priceAsOf})`,
            money(h.marketValue),
            money(h.costBasis),
            signedMoney(h.unrealized),
            pct(h.unrealizedPct, true),
          ]),
        ),
        holdings,
      );
    }),
  );

  server.registerTool(
    'list_trades',
    {
      title: '取引履歴',
      description: '売買履歴を新しい順に返します。取引の削除や修正の前に ID を確認するのに使います。',
      inputSchema: {
        account: account.optional(),
        symbol: symbol.optional(),
        from: date.optional(),
        to: date.optional(),
        limit: z.number().int().min(1).max(500).optional().describe('既定 100'),
      },
      annotations: READ,
    },
    guard((args) => {
      const { total, trades } = service.listTrades(args);
      return ok(
        lines(
          `${total} 件中 ${trades.length} 件`,
          table(
            ['ID', '約定日', '口座', '銘柄', '売買', '数量', '単価', '手数料', '為替', 'メモ'],
            trades.map((t) => [
              String(t.id),
              t.tradeDate,
              t.accountId,
              t.symbol,
              t.side === 'buy' ? '買' : '売',
              num(t.quantity),
              num(t.price),
              num(t.fee),
              num(t.fxRate),
              t.note ?? '',
            ]),
          ),
        ),
        { total, trades },
      );
    }),
  );

  server.registerTool(
    'realized_gains',
    {
      title: '実現損益',
      description: `売却による実現損益を年・口座で集計します。課税口座（特定・一般）と NISA を分け、課税分の概算税額（20.315%）も出します。確定申告の参考値であり、正式な計算は証券会社の年間取引報告書で確認してください。`,
      inputSchema: { year: year.optional(), account: account.optional() },
      annotations: READ,
    },
    guard(({ year, account }) => {
      const r = service.realizedGains(year, account);
      return ok(
        lines(
          `## 実現損益${year ? `（${year} 年）` : '（全期間）'}`,
          `- 合計: ${signedMoney(r.totals.gain)} ${base}`,
          `- 課税口座: ${signedMoney(r.totals.taxableGain)}（概算税額 ${money(r.totals.estimatedTax)}）`,
          `- NISA（非課税）: ${signedMoney(r.totals.nisaGain)}`,
          '',
          table(
            ['取引ID', '売却日', '口座', '銘柄', '数量', '売却額', '取得費', '損益'],
            r.rows.map((row) => [
              String(row.tradeId),
              row.date,
              row.accountId,
              row.symbol,
              num(row.quantity),
              money(row.proceedsBase),
              money(row.costBase),
              signedMoney(row.gainBase),
            ]),
          ),
        ),
        r,
      );
    }),
  );

  server.registerTool(
    'dividend_report',
    {
      title: '配当レポート',
      description: '受取配当を銘柄別・月別に集計します（税引前・源泉税・税引後）。',
      inputSchema: { year: year.optional(), account: account.optional() },
      annotations: READ,
    },
    guard(({ year, account }) => {
      const r = service.dividendReport(year, account);
      return ok(
        lines(
          `## 配当${year ? `（${year} 年）` : '（全期間）'}`,
          `- 税引前: ${money(r.totals.gross)} / 源泉税: ${money(r.totals.tax)} / 税引後: ${money(r.totals.net)} ${base}`,
          '',
          '### 銘柄別',
          table(['銘柄', '名称', '税引前', '税引後'], r.bySymbol.map((s) => [s.symbol, s.name, money(s.gross), money(s.net)])),
          '',
          '### 月別（税引後）',
          table(['月', '金額'], r.byMonth.map((m) => [m.month, money(m.net)])),
          '',
          '### 明細',
          table(
            ['ID', '受取日', '口座', '銘柄', '税引前', '源泉税', '税引後'],
            r.rows.map((d) => [String(d.id), d.paidDate, d.accountId, d.symbol, money(d.grossBase), money(d.taxBase), money(d.netBase)]),
          ),
        ),
        r,
      );
    }),
  );

  server.registerTool(
    'nisa_usage',
    {
      title: 'NISA 枠の利用状況',
      description: '新 NISA の年間投資枠（成長 240 万円・つみたて 120 万円）と生涯枠（1,800 万円、うち成長 1,200 万円）の利用額と残りを概算します。生涯枠は現在保有分の簿価で計算します。',
      inputSchema: { year: year.optional() },
      annotations: READ,
    },
    guard(({ year }) => {
      const n = service.nisaUsage(year);
      return ok(
        lines(
          `## NISA 枠（${n.year} 年）`,
          table(
            ['枠', '利用額', '上限', '残り'],
            [
              ['成長投資枠（年間）', money(n.annual.growth.used), money(n.annual.growth.limit), money(n.annual.growth.remaining)],
              ['つみたて投資枠（年間）', money(n.annual.tsumitate.used), money(n.annual.tsumitate.limit), money(n.annual.tsumitate.remaining)],
              ['生涯枠（簿価）', money(n.lifetime.used), money(n.lifetime.limit), money(n.lifetime.remaining)],
              ['うち成長投資枠（簿価）', money(n.lifetime.growthUsed), money(n.lifetime.growthLimit), money(Math.max(0, n.lifetime.growthLimit - n.lifetime.growthUsed))],
            ],
          ),
        ),
        n,
      );
    }),
  );

  server.registerTool(
    'value_history',
    {
      title: '評価額の推移',
      description: '価格更新（update_prices）のたびに保存される日次スナップショットから、評価額と取得額の推移を返します。',
      inputSchema: { from: date.optional(), to: date.optional() },
      annotations: READ,
    },
    guard(({ from, to }) => {
      const rows = service.valueHistory(from, to);
      return ok(
        table(
          ['日付', `評価額(${base})`, '取得額', '含み損益'],
          rows.map((r) => [r.date, money(r.marketValue), money(r.costBasis), signedMoney(r.marketValue - r.costBasis)]),
        ),
        rows,
      );
    }),
  );

  server.registerTool(
    'list_accounts',
    {
      title: '口座・銘柄マスタ',
      description: '登録済みの口座と銘柄（通貨、種別、セクター、価格単位）を返します。',
      inputSchema: {},
      annotations: READ,
    },
    guard(() => {
      const accounts = service.store.listAccounts();
      const securities = service.store.listSecurities();
      return ok(
        lines(
          '### 口座',
          table(['ID', '名称', '区分', '証券会社'], accounts.map((a) => [a.id, a.name, accountKindLabel(a.kind), a.broker ?? ''])),
          '',
          '### 銘柄',
          table(
            ['銘柄', '名称', '通貨', '種別', 'セクター', '市場', '価格単位'],
            securities.map((s) => [s.symbol, s.name, s.currency, ASSET_TYPE_LABELS[s.assetType], s.sector ?? '', s.market ?? '', num(s.priceUnit)]),
          ),
        ),
        { accounts, securities },
      );
    }),
  );

  server.registerTool(
    'price_targets',
    {
      title: '価格更新が必要な銘柄',
      description: '保有中の銘柄と外貨について、前回の価格・日付を返します。Web で最新価格を調べて update_prices に渡す前に使います。',
      inputSchema: {},
      annotations: READ,
    },
    guard(() => {
      const t = service.priceTargets();
      return ok(
        lines(
          table(
            ['銘柄', '名称', '市場', '通貨', '価格単位', '前回価格', '前回日付'],
            t.securities.map((s) => [s.symbol, s.name, s.market ?? '', s.currency, num(s.priceUnit), s.lastPrice === null ? '—' : num(s.lastPrice), s.lastAsOf ?? '—']),
          ),
          t.currencies.length > 0 &&
            `\n為替: ${t.currencies.map((c) => `${c.currency}/${base} 前回 ${c.lastRate ?? '—'}（${c.lastAsOf ?? '—'}）`).join(', ')}`,
          '\n投資信託は「価格単位」口あたりの基準価額（通常 1 万口あたり）を登録してください。',
        ),
        t,
      );
    }),
  );

  // ---- Writes ----

  server.registerTool(
    'record_trade',
    {
      title: '売買を記録',
      description: `買付・売却を 1 件記録します。売却は保有数量を超えると拒否されます。未登録銘柄の初回は name と currency が必須です（投資信託は asset_type=fund、price は 1 万口あたりの基準価額、quantity は口数）。${base} 以外の通貨では約定時の fx_rate（1 外貨あたりの ${base}）を指定してください（省略時は登録済みの最新レート）。`,
      inputSchema: {
        account,
        symbol,
        side: z.enum(['buy', 'sell']),
        quantity: z.number().positive().describe('株数・口数'),
        price: z.number().nonnegative().describe('約定単価（銘柄の通貨建て、price_unit あたり）'),
        fee: z.number().nonnegative().optional().describe('手数料（税込、銘柄の通貨建て）'),
        fx_rate: z.number().positive().optional(),
        date: date.optional().describe('約定日（省略時は今日）'),
        note: z.string().max(500).optional(),
        name: z.string().max(100).optional().describe('銘柄名（未登録銘柄のみ）'),
        currency: z.string().length(3).optional().describe('通貨コード（未登録銘柄のみ）'),
        asset_type: z.enum(ASSET_TYPES).optional().describe('未登録銘柄のみ'),
        price_unit: z.number().positive().optional().describe('未登録銘柄のみ。投信(JPY)は既定 10000'),
      },
      annotations: WRITE,
    },
    guard((a) => {
      const r = service.recordTrade({
        account: a.account,
        symbol: a.symbol,
        side: a.side,
        quantity: a.quantity,
        price: a.price,
        fee: a.fee,
        fxRate: a.fx_rate,
        date: a.date,
        note: a.note,
        name: a.name,
        currency: a.currency,
        assetType: a.asset_type,
        priceUnit: a.price_unit,
      });
      const t = r.trade;
      return ok(
        lines(
          `取引 #${t.id} を記録しました: ${t.tradeDate} ${t.accountId} ${t.symbol} ${t.side === 'buy' ? '買' : '売'} ${num(t.quantity)} @ ${num(t.price)}（約定金額 ${num(r.amount)}、手数料 ${num(t.fee)}）`,
          r.realizedGain !== null && `実現損益: ${signedMoney(r.realizedGain)} ${base}`,
          r.position
            ? `現在の保有: ${num(r.position.quantity)}、平均取得単価 ${num(r.position.averageCost)} ${r.position.currency}`
            : 'この口座での保有はなくなりました。',
        ),
        r,
      );
    }),
  );

  server.registerTool(
    'delete_trade',
    {
      title: '取引を削除',
      description: '誤登録した取引を ID で削除します。削除で後続の売却が保有数量を超える場合は拒否されます。修正は削除してから record_trade で登録し直してください。',
      inputSchema: { trade_id: z.number().int().positive() },
      annotations: DESTRUCTIVE,
    },
    guard(({ trade_id }) => {
      const t = service.deleteTrade(trade_id);
      return ok(`取引 #${t.id}（${t.tradeDate} ${t.symbol} ${t.side === 'buy' ? '買' : '売'} ${num(t.quantity)} @ ${num(t.price)}）を削除しました。`, t);
    }),
  );

  server.registerTool(
    'import_trades_csv',
    {
      title: 'CSV から取引を一括登録',
      description: 'ヘッダー付き CSV の売買履歴をまとめて登録します。必須列: date(約定日), symbol(銘柄コード), side(買/売), quantity(数量), price(単価)。任意列: account, fee, fx_rate, currency, name, asset_type, note。日本語ヘッダーも可。1 行でもエラーがあれば何も登録しません。まず dry_run=true で検証してください。',
      inputSchema: {
        csv: z.string().min(1).max(500_000),
        default_account: account.optional().describe('account 列がない行に使う口座（既定 main）'),
        dry_run: z.boolean().optional(),
      },
      annotations: WRITE,
    },
    guard(({ csv, default_account, dry_run }) => {
      const r = service.importTradesCsv(csv, { defaultAccount: default_account, dryRun: dry_run });
      return ok(
        r.dryRun
          ? `検証 OK: ${r.validated} 件を登録できます（まだ登録していません）。`
          : `${r.imported} 件の取引を登録しました。`,
        r,
      );
    }),
  );

  server.registerTool(
    'record_dividend',
    {
      title: '配当を記録',
      description: `受け取った配当・分配金を記録します。amount は税引前、tax は源泉徴収税（いずれも銘柄の通貨建て）。外貨は受取時の fx_rate を指定。`,
      inputSchema: {
        account,
        symbol,
        amount: z.number().nonnegative(),
        tax: z.number().nonnegative().optional(),
        fx_rate: z.number().positive().optional(),
        date: date.optional().describe('受取日（省略時は今日）'),
        note: z.string().max(500).optional(),
      },
      annotations: WRITE,
    },
    guard((a) => {
      const d = service.recordDividend({ ...a, fxRate: a.fx_rate });
      return ok(`配当 #${d.id} を記録しました: ${d.paidDate} ${d.symbol} 税引前 ${num(d.amount)} / 源泉税 ${num(d.tax)}`, d);
    }),
  );

  server.registerTool(
    'delete_dividend',
    {
      title: '配当を削除',
      description: '誤登録した配当を ID で削除します（dividend_report で ID を確認）。',
      inputSchema: { dividend_id: z.number().int().positive() },
      annotations: DESTRUCTIVE,
    },
    guard(({ dividend_id }) => {
      service.deleteDividend(dividend_id);
      return ok(`配当 #${dividend_id} を削除しました。`);
    }),
  );

  server.registerTool(
    'update_prices',
    {
      title: '価格・為替を更新',
      description: `銘柄の現在値と為替レートを登録し、その日の評価額スナップショットを保存します。price は銘柄の通貨建て・price_unit あたり。fx の rate は 1 外貨あたりの ${base}（例: USD 150.2）。`,
      inputSchema: {
        prices: z
          .array(z.object({ symbol, price: z.number().nonnegative(), as_of: date.optional() }))
          .max(500)
          .optional(),
        fx: z
          .array(z.object({ currency: z.string().length(3), rate: z.number().positive(), as_of: date.optional() }))
          .max(50)
          .optional(),
        source: z.string().max(200).optional().describe('価格の出所（例: 株探、Yahoo!ファイナンス）'),
      },
      annotations: { ...WRITE, idempotentHint: true },
    },
    guard(({ prices, fx, source }) => {
      const r = service.updatePrices({
        prices: prices?.map((p) => ({ symbol: p.symbol, price: p.price, asOf: p.as_of })),
        fx: fx?.map((f) => ({ currency: f.currency, rate: f.rate, asOf: f.as_of })),
        source,
      });
      return ok(
        lines(
          `${r.updated} 件を更新しました。評価額 ${money(r.totals.marketValue)} ${base}（含み損益 ${signedMoney(r.totals.unrealized)}、${pct(r.totals.unrealizedPct, true)}）`,
          r.unknownSymbols.length > 0 && `未登録のためスキップ: ${r.unknownSymbols.join(', ')}`,
          r.missingPrices.length > 0 && `まだ価格がない保有銘柄: ${r.missingPrices.join(', ')}`,
        ),
        r,
      );
    }),
  );

  server.registerTool(
    'upsert_security',
    {
      title: '銘柄を登録・更新',
      description: '銘柄マスタ（名称、通貨、種別、セクター、市場、価格単位）を登録または更新します。省略した項目は既存値のままです。',
      inputSchema: {
        symbol,
        name: z.string().max(100).optional(),
        currency: z.string().length(3).optional(),
        asset_type: z.enum(ASSET_TYPES).optional(),
        sector: z.string().max(50).nullable().optional().describe('例: 情報・通信、銀行、米国株インデックス'),
        market: z.string().max(50).nullable().optional().describe('例: 東証プライム、NASDAQ'),
        price_unit: z.number().positive().optional(),
        note: z.string().max(500).nullable().optional(),
      },
      annotations: WRITE,
    },
    guard((a) => {
      const s = service.upsertSecurity({
        symbol: a.symbol,
        name: a.name,
        currency: a.currency,
        assetType: a.asset_type,
        sector: a.sector,
        market: a.market,
        priceUnit: a.price_unit,
        note: a.note,
      });
      return ok(`銘柄 ${s.symbol}（${s.name}、${s.currency}、${ASSET_TYPE_LABELS[s.assetType]}、価格単位 ${num(s.priceUnit)}）を保存しました。`, s);
    }),
  );

  server.registerTool(
    'upsert_account',
    {
      title: '口座を登録・更新',
      description: '口座を登録または更新します。kind: tokutei=特定口座, ippan=一般口座, nisa_growth=NISA成長投資枠, nisa_tsumitate=NISAつみたて投資枠, other。',
      inputSchema: {
        id: z.string().min(1).max(32).describe('英数字の ID（例: sbi_nisa）'),
        name: z.string().min(1).max(50),
        kind: z.enum(ACCOUNT_KINDS),
        broker: z.string().max(50).optional(),
      },
      annotations: WRITE,
    },
    guard((a) => {
      const acc = service.upsertAccount(a);
      return ok(`口座 ${acc.id}（${acc.name}、${accountKindLabel(acc.kind)}）を保存しました。`, acc);
    }),
  );

  return server;
}
