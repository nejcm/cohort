import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP, type AddressInfo } from 'node:net';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, listIds, loadProjectConfig, type SuiteEntry } from '../config/files.ts';
import { DEFAULT_MASKS, resolveSubmission, validateSubmission } from '../config/resolve.ts';
import { preflight } from '../core/estimate.ts';
import { BundleError, bundleDir, readBundleFile } from '../evidence/bundle.ts';
import type { RunManifest } from '../evidence/manifest.ts';
import { GenerateError, generatePersona } from '../personas/generate.ts';
import { catalogHash, CatalogError, loadCatalog, resolveModel } from '../providers/catalog.ts';
import { createProviders } from '../providers/registry.ts';
import { EFFORTS, ProviderError, type Effort, type ProviderAdapter } from '../providers/types.ts';
import { SecretStore, safeUrl } from '../setup/secrets.ts';
import { LabDb, type RunRow } from './db.ts';
import { appendSuiteEntry, createPersona, EditError, readEditable, saveEditable } from './files.ts';
import { indexRuns, QueueError, recoverInterrupted, RunQueue } from './runner.ts';

export interface DashboardOptions {
  projectRoot: string;
  host?: string;
  port?: number;
  env?: NodeJS.ProcessEnv;
  providers?: Record<string, ProviderAdapter>;
  /** Built UI directory; defaults to the packaged `ui` folder beside this module. */
  assetsDir?: string;
}

export interface Dashboard {
  /** Launch URL; the token travels in the fragment, never the query. */
  url: string;
  origin: string;
  token: string;
  queue: RunQueue;
  close(): Promise<void>;
}

class HttpError extends Error {
  override name = 'HttpError';
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
const MAX_PAGE = 100;
const HEARTBEAT_MS = 15_000;
const MAX_SSE_BUFFER = 1024 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const SHOT = /^shot-[0-9]{4}$/u;

export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const ARTIFACT_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";
const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

export const isLoopback = (host: string): boolean => LOOPBACK.has(host);

function hostName(header: string): { name: string; port: string } | null {
  const match = /^(\[[0-9a-f:.]+\]|[^:[\]]+):([0-9]{1,5})$/iu.exec(header);
  return match ? { name: match[1]!.replace(/^\[|\]$/gu, '').toLowerCase(), port: match[2]! } : null;
}

// DNS rebinding needs a DNS name; loopback binds accept only loopback names, other binds the given host or an IP literal.
function hostAllowed(header: string | undefined, bind: string, port: number): boolean {
  const parsed = header ? hostName(header) : null;
  if (!parsed || parsed.port !== String(port)) return false;
  if (isLoopback(bind)) return isLoopback(parsed.name);
  return parsed.name === bind.toLowerCase() || isIP(parsed.name) !== 0 || isLoopback(parsed.name);
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader('Content-Security-Policy', CSP);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Cache-Control', 'no-store');
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(;|$)/u.test(request.headers['content-type'] ?? ''))
    throw new HttpError(415, 'requests must be application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request body larger than 1 MiB');
    chunks.push(chunk);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new HttpError(400, 'body must be a JSON object');
  return value as Record<string, unknown>;
}

const text = (value: unknown, name: string): string => {
  if (typeof value !== 'string') throw new HttpError(400, `${name} must be a string`);
  return value;
};

function publicRun(row: RunRow) {
  return {
    id: row.id,
    batchId: row.batch_id,
    entryIndex: row.entry_index,
    repeat: row.repeat_index,
    personaId: row.persona_id,
    goal: row.goal,
    mode: row.mode,
    provider: row.provider,
    model: row.model,
    effort: row.effort,
    catalog: {
      version: row.catalog_version,
      hash: row.catalog_hash,
      entry: JSON.parse(row.catalog_entry_json) as unknown,
    },
    untested: row.model_untested === 1,
    status: row.status,
    outcome: row.outcome_state,
    blockedKind: row.blocked_kind,
    outcomeCode: row.outcome_code,
    interruptedBy: row.interrupted_by,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    steps: row.steps,
    durationMs: row.duration_ms,
    costUsd: row.estimated_cost_usd,
    capEnforcement: row.cap_enforcement,
  };
}

const defaultAssets = (): string => fileURLToPath(new URL('../../dist/ui/', import.meta.url));

async function screenshotIds(dir: string): Promise<string[]> {
  const names = await readdir(join(dir, 'screenshots')).catch(() => []);
  return names
    .map((name) => name.replace(/\.png$/u, ''))
    .filter((name) => SHOT.test(name))
    .toSorted();
}

// Manifest paths are data from disk: plain segments only, and every directory on the way must be a real directory.
async function bundlePath(dir: string, relative: string): Promise<string> {
  const segments = relative.split('/');
  if (!segments.every((segment) => /^[\w-][\w.-]*$/u.test(segment))) throw new HttpError(404, 'artifact unavailable');
  for (let depth = 1; depth < segments.length; depth += 1) {
    const info = await lstat(join(dir, ...segments.slice(0, depth))).catch(() => null);
    if (!info?.isDirectory()) throw new HttpError(404, 'artifact unavailable');
  }
  return join(dir, ...segments);
}

async function sendFile(
  response: ServerResponse,
  dir: string,
  relative: string,
  mediaType: string,
  attachment: string | null,
): Promise<void> {
  const path = await bundlePath(dir, relative);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!handle) throw new HttpError(404, 'artifact unavailable');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new HttpError(404, 'artifact unavailable');
    if (info.size > MAX_ARTIFACT_BYTES) throw new HttpError(413, 'artifact too large to serve');
    const data = await handle.readFile();
    response.setHeader('Content-Security-Policy', ARTIFACT_CSP);
    response.writeHead(200, {
      'Content-Type': mediaType,
      'Content-Length': data.length,
      ...(attachment
        ? { 'Content-Disposition': `attachment; filename="${attachment.replace(/[^\w.-]/gu, '_')}"` }
        : {}),
    });
    response.end(data);
  } finally {
    await handle.close();
  }
}

export async function startDashboard(options: DashboardOptions): Promise<Dashboard> {
  const { projectRoot } = options;
  const bind = options.host ?? '127.0.0.1';
  const env = options.env ?? process.env;
  const providers = options.providers ?? createProviders(env);
  const assetsDir = options.assetsDir ?? defaultAssets();
  const token = randomBytes(32).toString('base64url');
  const expected = Buffer.from(`Bearer ${token}`);
  await mkdir(join(projectRoot, '.lab'), { recursive: true, mode: 0o700 });
  const db = new LabDb(join(projectRoot, '.lab', 'index.sqlite'));
  await recoverInterrupted(projectRoot, db);
  await indexRuns(projectRoot, db);
  const queue = new RunQueue({ projectRoot, db, providers, env });
  const streams = new Set<ServerResponse>();
  let port = 0;

  const available = (id: string): boolean => providers[id]?.available() === true;

  const routes: [
    string,
    RegExp,
    (match: RegExpMatchArray, request: IncomingMessage, response: ServerResponse) => Promise<void>,
  ][] = [
    [
      'GET',
      /^\/api\/config$/u,
      async (_m, _q, response) => {
        const project = await loadProjectConfig(projectRoot);
        json(response, 200, {
          defaults: {
            model: project.model,
            effort: project.effort ?? null,
            mode: project.mode ?? 'vision',
            repeats: project.repeats ?? 3,
            limits: project.limits ?? {},
            allowedOrigins: project.allowedOrigins ?? [],
          },
          providers: Object.fromEntries(Object.keys(providers).map((id) => [id, available(id)])),
        });
      },
    ],
    [
      'GET',
      /^\/api\/models$/u,
      async (_m, _q, response) => {
        const catalog = await loadCatalog(projectRoot);
        json(response, 200, {
          catalog: { version: catalog.version, hash: catalogHash(catalog) },
          providers: Object.keys(providers).map((id) => ({ id, available: available(id) })),
          models: catalog.models
            .filter((entry) => available(entry.provider))
            .map((entry) => ({
              id: `${entry.provider}/${entry.id}`,
              provider: entry.provider,
              label: entry.label,
              visionCapable: entry.visionCapable,
              supportedEffortLevels: entry.supportedEffortLevels,
              defaultEffort: entry.defaultEffort,
              pricesPerMTok: entry.pricesPerMTok,
              pricingVerifiedAt: entry.pricingVerifiedAt,
              untested: entry.untested,
              enabled: entry.visionCapable !== null && entry.supportedEffortLevels.length > 0,
            })),
        });
      },
    ],
    [
      'GET',
      /^\/api\/personas$/u,
      async (_m, _q, response) => {
        const ids = await listIds(projectRoot, 'personas', '.md');
        const personas = await Promise.all(ids.map((id) => readEditable(projectRoot, 'personas', id)));
        json(response, 200, {
          personas: personas.map(({ id, parsed, error }) => {
            const persona = parsed as { name?: string; tags?: string[]; goal?: string; setup?: string } | null;
            return {
              id,
              name: persona?.name ?? null,
              tags: persona?.tags ?? [],
              goal: persona?.goal ?? null,
              setup: persona?.setup ?? null,
              error,
            };
          }),
        });
      },
    ],
    [
      'GET',
      /^\/api\/(personas|suites)\/([^/]+)$/u,
      async (match, _q, response) => {
        json(
          response,
          200,
          await readEditable(projectRoot, match[1] as 'personas' | 'suites', decodeURIComponent(match[2]!)),
        );
      },
    ],
    [
      'PUT',
      /^\/api\/(personas|suites)\/([^/]+)$/u,
      async (match, request, response) => {
        const body = await readJson(request);
        json(
          response,
          200,
          await saveEditable(
            projectRoot,
            match[1] as 'personas' | 'suites',
            decodeURIComponent(match[2]!),
            text(body.source, 'source'),
            text(body.revision, 'revision'),
          ),
        );
      },
    ],
    [
      'POST',
      /^\/api\/personas$/u,
      async (_m, request, response) => {
        const body = await readJson(request);
        json(response, 201, await createPersona(projectRoot, text(body.source, 'source')));
      },
    ],
    [
      'POST',
      /^\/api\/personas\/generate$/u,
      async (_m, request, response) => {
        const body = await readJson(request);
        const dollars = body.dollars;
        if (typeof dollars !== 'number' || !(dollars > 0 && dollars <= 1000))
          throw new HttpError(400, 'dollars must be an explicit cap in (0, 1000]');
        const [project, catalog] = await Promise.all([loadProjectConfig(projectRoot), loadCatalog(projectRoot)]);
        const effort = body.effort === undefined ? project.effort : (body.effort as Effort);
        if (effort !== undefined && !EFFORTS.includes(effort)) throw new HttpError(400, 'invalid effort');
        const resolved = resolveModel(catalog, body.model === undefined ? project.model : text(body.model, 'model'), {
          mode: 'vision',
          allowUntested: body.allowUntested === true,
          ...(effort ? { effort } : {}),
        });
        const provider = providers[resolved.provider];
        if (!provider?.available()) throw new HttpError(400, `provider ${resolved.provider} is unavailable`);
        const generated = await generatePersona({
          url: text(body.url, 'url'),
          description: text(body.description, 'description').slice(0, 4000),
          provider,
          model: resolved.model,
          effort: resolved.effort,
          prices: resolved.catalog.entry.pricesPerMTok,
          dollars,
          maskSelectors: project.screenshots?.maskSelectors ?? DEFAULT_MASKS,
          signal: closedSignal(response),
        });
        json(response, 200, {
          id: generated.id,
          markdown: generated.markdown,
          provider: resolved.provider,
          model: resolved.model,
          estimatedCostUsd: generated.estimatedCostUsd,
          reportedCostUsd: generated.usage?.reportedCostUsd ?? null,
          capEnforcement: generated.capEnforcement,
        });
      },
    ],
    [
      'GET',
      /^\/api\/suites$/u,
      async (_m, _q, response) => {
        const ids = await listIds(projectRoot, 'suites', '.yml');
        const suites = await Promise.all(ids.map((id) => readEditable(projectRoot, 'suites', id)));
        json(response, 200, {
          suites: suites.map(({ id, parsed, error }) => {
            const suite = parsed as { name?: string; entries?: unknown[] } | null;
            return { id, name: suite?.name ?? null, entries: suite?.entries?.length ?? 0, error };
          }),
        });
      },
    ],
    [
      'POST',
      /^\/api\/suites\/([^/]+)\/entries$/u,
      async (match, request, response) => {
        const body = await readJson(request);
        if (typeof body.entry !== 'object' || body.entry === null) throw new HttpError(400, 'entry must be an object');
        json(
          response,
          200,
          await appendSuiteEntry(
            projectRoot,
            decodeURIComponent(match[1]!),
            body.entry as SuiteEntry,
            text(body.revision, 'revision'),
          ),
        );
      },
    ],
    [
      'POST',
      /^\/api\/runs$/u,
      async (_m, request, response) => {
        const body = await readJson(request);
        const submission = validateSubmission(body.submission);
        const [project, catalog] = await Promise.all([loadProjectConfig(projectRoot), loadCatalog(projectRoot)]);
        const entries = await resolveSubmission(submission, {
          projectRoot,
          project,
          catalog,
          providers,
          // A preview lists untested models (inherited ones included) so the dialog can ask for consent before dispatch.
          allowUntested: body.preview === true || body.allowUntested === true,
        });
        const plan = preflight(entries);
        if (body.preview === true) return void json(response, 200, { ...plan });
        json(response, 202, {
          ...queue.enqueue(entries, {
            submission: submission.url
              ? { ...submission, url: safeUrl(submission.url, new SecretStore()) }
              : submission,
            allowUntested: body.allowUntested === true,
          }),
          ...plan,
        });
      },
    ],
    [
      'GET',
      /^\/api\/runs$/u,
      async (_m, request, response) => {
        const params = new URL(request.url!, 'http://local').searchParams;
        const limit = Math.min(MAX_PAGE, Math.max(1, Number(params.get('limit') ?? 50) || 50));
        const cursor = params.get('cursor');
        let after: { createdAt: string; id: string } | undefined;
        if (cursor) {
          const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
          if (!createdAt || !id) throw new HttpError(400, 'invalid cursor');
          after = { createdAt, id };
        }
        const rows = db.listRuns(limit, after);
        const last = rows.at(-1);
        json(response, 200, {
          runs: rows.map(publicRun),
          nextCursor:
            rows.length === limit && last ? Buffer.from(`${last.created_at}|${last.id}`).toString('base64url') : null,
        });
      },
    ],
    [
      'GET',
      /^\/api\/runs\/([^/]+)$/u,
      async (match, _q, response) => {
        const row = indexed(match[1]!);
        const dir = await runDir(row.id);
        const report = dir ? await readBundleFile(dir, 'report.json') : null;
        const manifest = dir ? await readBundleFile(dir, 'manifest.json') : null;
        json(response, 200, {
          run: publicRun(row),
          report: report ? (JSON.parse(report) as unknown) : null,
          artifacts: manifest
            ? (JSON.parse(manifest) as RunManifest).artifacts.map(({ path, mediaType, bytes, sensitivity }) => ({
                id: path,
                mediaType,
                bytes,
                sensitivity,
              }))
            : [],
          screenshots: dir ? await screenshotIds(dir) : [],
          lastEventId: db.eventsAfter(row.id, 0).at(-1)?.sequence ?? 0,
        });
      },
    ],
    [
      'POST',
      /^\/api\/runs\/([^/]+)\/cancel$/u,
      async (match, request, response) => {
        await readJson(request);
        const row = indexed(match[1]!);
        if (!queue.cancel(row.id)) throw new HttpError(409, `${row.id} is not queued or running`);
        json(response, 202, { id: row.id, cancelling: true });
      },
    ],
    [
      'GET',
      /^\/api\/runs\/([^/]+)\/events$/u,
      async (match, request, response) => {
        const row = indexed(match[1]!);
        const lastId = Number(request.headers['last-event-id'] ?? 0);
        if (!Number.isInteger(lastId) || lastId < 0) throw new HttpError(400, 'invalid Last-Event-ID');
        stream(row.id, lastId, response);
      },
    ],
    [
      'GET',
      /^\/api\/runs\/([^/]+)\/screenshots\/([^/]+)$/u,
      async (match, _q, response) => {
        const row = indexed(match[1]!);
        const shot = decodeURIComponent(match[2]!);
        if (!SHOT.test(shot)) throw new HttpError(404, 'unknown screenshot');
        const dir = await runDir(row.id);
        if (!dir) throw new HttpError(404, 'unknown screenshot');
        await sendFile(response, dir, `screenshots/${shot}.png`, 'image/png', null);
      },
    ],
    [
      'GET',
      /^\/api\/runs\/([^/]+)\/artifacts\/([^/]+)$/u,
      async (match, _q, response) => {
        const row = indexed(match[1]!);
        const artifactId = decodeURIComponent(match[2]!);
        const dir = await runDir(row.id);
        const manifest = dir ? await readBundleFile(dir, 'manifest.json') : null;
        const artifact = manifest
          ? (JSON.parse(manifest) as RunManifest).artifacts.find((item) => item.path === artifactId)
          : undefined;
        if (!dir || !artifact) throw new HttpError(404, 'artifact not in the run manifest');
        const inline = artifact.mediaType === 'image/png' || artifact.mediaType === 'application/json';
        await sendFile(
          response,
          dir,
          artifact.path,
          artifact.mediaType,
          inline ? null : artifact.path.split('/').at(-1)!,
        );
      },
    ],
    [
      'GET',
      /^\/api\/batches\/([^/]+)$/u,
      async (match, _q, response) => {
        const batch = db.batch(decodeURIComponent(match[1]!));
        if (!batch) throw new HttpError(404, 'unknown batch');
        const dir = await bundleDir(projectRoot, batch.id).then(
          ({ dir: found }) => found,
          () => null,
        );
        const summary = dir ? await readBundleFile(dir, 'report.json') : null;
        json(response, 200, {
          batch: { id: batch.id, createdAt: batch.created_at, request: JSON.parse(batch.request_json) as unknown },
          runs: db.batchRuns(batch.id).map(publicRun),
          summary: summary ? (JSON.parse(summary) as unknown) : null,
        });
      },
    ],
  ];

  function indexed(encoded: string): RunRow {
    const row = db.run(decodeURIComponent(encoded));
    if (!row) throw new HttpError(404, 'unknown run');
    return row;
  }

  async function runDir(runId: string): Promise<string | null> {
    return bundleDir(projectRoot, runId).then(
      ({ dir }) => dir,
      () => null,
    );
  }

  function stream(runId: string, lastId: number, response: ServerResponse): void {
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
    streams.add(response);
    let sent = lastId;
    const write = (event: { sequence: number; type: string; payload: Record<string, unknown> }): void => {
      // Batch-level claims can follow run.finished; the stream ends at the terminal event and the report carries them.
      if (event.sequence <= sent || response.writableEnded) return;
      sent = event.sequence;
      response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`);
      // A slow reader reconnects with Last-Event-ID instead of growing this buffer.
      if (response.writableLength > MAX_SSE_BUFFER) response.destroy();
      if (event.type === 'run.finished') response.end();
    };
    const unsubscribe = queue.subscribe(runId, write);
    for (const event of db.eventsAfter(runId, lastId)) write(event);
    const row = db.run(runId);
    if (row && !['queued', 'running'].includes(row.status) && !response.writableEnded) response.end();
    const heartbeat = setInterval(() => {
      if (!response.writableEnded) response.write(': ping\n\n');
    }, HEARTBEAT_MS);
    response.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      streams.delete(response);
    });
  }

  async function serveStatic(pathname: string, response: ServerResponse): Promise<void> {
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!/^[\w-]+(\/[\w-]+)*\.[a-z0-9]+$/u.test(relative) || !STATIC_TYPES[extname(relative)])
      throw new HttpError(404, 'not found');
    const handle = await open(
      join(assetsDir, relative),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch(() => null);
    if (!handle) {
      if (relative !== 'index.html') throw new HttpError(404, 'not found');
      response
        .writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end('Dashboard assets are not built; run `bun run build`.\n');
      return;
    }
    try {
      if (!(await handle.stat()).isFile()) throw new HttpError(404, 'not found');
      const data = await handle.readFile();
      response
        .writeHead(200, { 'Content-Type': STATIC_TYPES[extname(relative)]!, 'Content-Length': data.length })
        .end(data);
    } finally {
      await handle.close();
    }
  }

  function authorized(request: IncomingMessage): boolean {
    const header = Buffer.from(request.headers.authorization ?? '');
    return header.length === expected.length && timingSafeEqual(header, expected);
  }

  async function respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
    securityHeaders(response);
    if (!hostAllowed(request.headers.host, bind, port)) throw new HttpError(421, 'unexpected Host');
    const origin = request.headers.origin;
    const mutation = request.method !== 'GET' && request.method !== 'HEAD';
    if (origin !== undefined && origin !== `http://${request.headers.host}`)
      throw new HttpError(403, 'cross-origin request');
    if (mutation && origin === undefined) throw new HttpError(403, 'missing Origin');
    const site = request.headers['sec-fetch-site'];
    if (mutation && site !== undefined && site !== 'same-origin') throw new HttpError(403, 'cross-site request');
    const { pathname } = new URL(request.url ?? '/', 'http://local');
    if (!pathname.startsWith('/api/')) {
      if (request.method !== 'GET') throw new HttpError(405, 'method not allowed');
      return serveStatic(pathname, response);
    }
    if (!authorized(request)) throw new HttpError(401, 'missing or invalid token');
    for (const [method, pattern, handler] of routes) {
      const match = pattern.exec(pathname);
      if (match && method === request.method) return handler(match, request, response);
    }
    throw new HttpError(routes.some(([, pattern]) => pattern.test(pathname)) ? 405 : 404, 'not found');
  }

  const server = createServer((request, response) => {
    respond(request, response).catch((error: unknown) => {
      const status =
        error instanceof HttpError || error instanceof EditError
          ? error.status
          : error instanceof ConfigError || error instanceof CatalogError || error instanceof BundleError
            ? 400
            : error instanceof QueueError
              ? 429
              : error instanceof GenerateError || error instanceof ProviderError
                ? 502
                : 500;
      const message = status === 500 ? 'internal error' : (error as Error).message;
      if (response.headersSent) return void response.destroy();
      json(response, status, { error: message });
    });
  });
  server.requestTimeout = 120_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, bind, () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  const origin = `http://${isIP(bind) === 6 ? `[${bind}]` : bind}:${port}`;
  return {
    url: `${origin}/#token=${token}`,
    origin,
    token,
    queue,
    async close() {
      for (const response of streams) response.end();
      await queue.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}

// A client that disconnects mid-generation cancels it.
function closedSignal(response: ServerResponse): AbortSignal {
  const controller = new AbortController();
  response.once('close', () => controller.abort('user'));
  return controller.signal;
}
