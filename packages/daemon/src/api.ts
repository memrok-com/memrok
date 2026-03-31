import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Store, Node } from '@memrok/store';
import type { Injector, RelevanceWeights } from '@memrok/injector';
import type { ApiConfig, DaemonStatus } from './types.js';
import type { ConsolidationEngine } from './consolidation.js';

interface ApiDeps {
  store: Store;
  injector: Injector;
  consolidation: ConsolidationEngine;
  getStatus: () => DaemonStatus;
  onNotify?: (data: unknown) => void;
  onTrigger?: () => Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseUrl(url: string): { path: string; params: URLSearchParams } {
  const parsed = new URL(url, 'http://localhost');
  return { path: parsed.pathname, params: parsed.searchParams };
}

export function createApiServer(config: ApiConfig | undefined, deps: ApiDeps): Server {
  const host = config?.host ?? '127.0.0.1';
  const port = config?.port ?? 18790;

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const { path, params } = parseUrl(req.url ?? '/');
      const method = req.method ?? 'GET';

      // GET /health
      if (method === 'GET' && path === '/health') {
        json(res, 200, deps.getStatus());
        return;
      }

      // GET /header
      if (method === 'GET' && path === '/header') {
        const header = deps.injector.assemble();
        json(res, 200, header);
        return;
      }

      // POST /header
      if (method === 'POST' && path === '/header') {
        const body = await readBody(req);
        const context = body ? JSON.parse(body) : undefined;
        const header = deps.injector.assemble(context);
        json(res, 200, header);
        return;
      }

      // POST /notify
      if (method === 'POST' && path === '/notify') {
        const body = await readBody(req);
        const data = body ? JSON.parse(body) : {};
        if (deps.onNotify) deps.onNotify(data);
        json(res, 200, { ok: true });
        return;
      }

      // POST /trigger
      if (method === 'POST' && path === '/trigger') {
        if (deps.onTrigger) {
          await deps.onTrigger();
        }
        json(res, 200, { ok: true, triggered: true });
        return;
      }

      // GET /nodes or GET /nodes/:key
      if (method === 'GET' && path.startsWith('/nodes')) {
        const parts = path.split('/').filter(Boolean);
        if (parts.length === 1) {
          // GET /nodes with query params
          const filter: Record<string, unknown> = {};
          const layer = params.get('layer');
          const category = params.get('category');
          const active = params.get('active');
          if (layer) filter.layer = layer;
          if (category) filter.category = category;
          if (active !== null) filter.active = active === 'true';
          const nodes: Node[] = deps.store.queryNodes(filter);
          json(res, 200, nodes);
          return;
        }
        if (parts.length === 2) {
          // GET /nodes/:key
          const key = decodeURIComponent(parts[1]);
          const node = deps.store.getNode(key);
          if (!node) {
            json(res, 404, { error: 'Node not found' });
            return;
          }
          json(res, 200, node);
          return;
        }
      }

      // GET /weights
      if (method === 'GET' && path === '/weights') {
        json(res, 200, deps.injector.getWeights());
        return;
      }

      // PUT /weights/:signal
      if (method === 'PUT' && path.startsWith('/weights/')) {
        const signal = path.split('/').pop()!;
        const body = await readBody(req);
        const { value } = JSON.parse(body) as { value: number };
        const weights = deps.injector.getWeights();
        if (!(signal in weights)) {
          json(res, 400, { error: `Unknown signal: ${signal}` });
          return;
        }
        deps.injector.setWeight(signal, value);
        json(res, 200, deps.injector.getWeights());
        return;
      }

      json(res, 404, { error: 'Not found' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      json(res, 500, { error: message });
    }
  });

  server.listen(port, host);
  return server;
}
