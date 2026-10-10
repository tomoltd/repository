import { createHttpServer } from './http.js';
import { PortfolioService } from './service.js';
import { Store } from './store.js';

const token = process.env.MCP_TOKEN?.trim() || undefined;
const allowNoAuth = process.env.ALLOW_NO_AUTH === 'true';
if (!token && !allowNoAuth) {
  console.error(
    'MCP_TOKEN が未設定です。.env に MCP_TOKEN を設定してください（認証なしで試すだけなら ALLOW_NO_AUTH=true）。',
  );
  process.exit(1);
}

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 4320);
const store = new Store(process.env.DATABASE_PATH ?? './data/portfolio.db');
const service = new PortfolioService(store, {
  baseCurrency: process.env.BASE_CURRENCY,
  timeZone: process.env.TIMEZONE,
});

const server = createHttpServer(service, { token });
server.listen(port, host, () => {
  console.log(`Portfolio MCP server: http://${host}:${port}/mcp${token ? '' : '（認証なし）'}`);
});

const shutdown = () => {
  server.close(() => {
    store.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
