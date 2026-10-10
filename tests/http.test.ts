import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpServer } from '../src/http.js';
import { PortfolioService } from '../src/service.js';
import { Store } from '../src/store.js';

const TOKEN = 'test-token';
const server = createHttpServer(
  new PortfolioService(new Store(':memory:'), { today: () => '2026-10-10' }),
  { token: TOKEN },
);
let url: URL;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

// Connects the same way OpenDots Connections does.
async function connect(token = TOKEN) {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

const text = (result: unknown) =>
  (result as { content: { type: string; text: string }[] }).content.map((c) => c.text).join('\n');

describe('MCP over HTTP', () => {
  it('rejects a wrong token', async () => {
    await assert.rejects(connect('wrong'));
    const response = await fetch(url, { method: 'POST' });
    assert.equal(response.status, 401);
  });

  it('lists tools with read-only hints for OpenDots approvals', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const hint = (name: string) => tools.find((t) => t.name === name)?.annotations?.readOnlyHint;
    assert.equal(hint('portfolio_summary'), true);
    assert.equal(hint('list_holdings'), true);
    assert.equal(hint('record_trade'), false);
    assert.equal(hint('delete_trade'), false);
    for (const tool of tools) {
      assert.match(tool.name, /^[a-z0-9_]{1,40}$/);
      assert.ok((tool.description ?? '').length <= 1000, `${tool.name} description too long`);
      assert.ok(JSON.stringify(tool.inputSchema).length < 16_000);
    }
    await client.close();
  });

  it('records a trade and reports it in the summary', async () => {
    const client = await connect();
    const recorded = await client.callTool({
      name: 'record_trade',
      arguments: { account: 'main', symbol: '7203', side: 'buy', quantity: 100, price: 2500, currency: 'JPY', name: 'トヨタ自動車', date: '2026-10-01' },
    });
    assert.ok(!recorded.isError, text(recorded));
    assert.match(text(recorded), /取引 #1 を記録しました/);

    await client.callTool({ name: 'update_prices', arguments: { prices: [{ symbol: '7203', price: 2800 }] } });
    const summary = await client.callTool({ name: 'portfolio_summary', arguments: {} });
    assert.match(text(summary), /評価額: 280,000/);
    assert.match(text(summary), /含み損益: \+30,000（\+12\.00%）/);

    const failed = await client.callTool({
      name: 'record_trade',
      arguments: { account: 'main', symbol: '7203', side: 'sell', quantity: 1000, price: 1 },
    });
    assert.equal(failed.isError, true);
    assert.match(text(failed), /超えています/);
    await client.close();
  });
});
