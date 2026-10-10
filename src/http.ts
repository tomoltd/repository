import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { PortfolioService } from './service.js';
import { createMcpServer } from './tools.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface HttpOptions {
  /** Bearer token required on /mcp. Undefined disables auth (local testing only). */
  token?: string;
}

const tokenMatches = (header: string | undefined, token: string) => {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!match) return false;
  const given = Buffer.from(match[1]!.trim());
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
};

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new RangeError('Request body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

export function createHttpServer(service: PortfolioService, options: HttpOptions) {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') return json(res, 200, { ok: true });
    if (url.pathname !== '/mcp') return json(res, 404, { error: 'Not found' });

    if (options.token && !tokenMatches(req.headers.authorization, options.token))
      return json(res, 401, { error: 'Unauthorized' }, { 'www-authenticate': 'Bearer' });

    // Stateless mode: every POST gets a fresh server and transport, so there is
    // no session to resume and GET/DELETE (SSE streams, session end) do not apply.
    if (req.method !== 'POST')
      return json(
        res,
        405,
        { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null },
        { allow: 'POST' },
      );

    let body: unknown;
    try {
      body = await readBody(req);
    } catch (error) {
      const tooLarge = error instanceof RangeError;
      return json(res, tooLarge ? 413 : 400, {
        jsonrpc: '2.0',
        error: { code: -32700, message: tooLarge ? 'Request body too large.' : 'Parse error.' },
        id: null,
      });
    }

    const server = createMcpServer(service);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      console.error('MCP request failed', error);
      if (!res.headersSent)
        json(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error.' }, id: null });
    }
  });
}
