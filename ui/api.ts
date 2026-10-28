const TOKEN_KEY = 'lab-token';

export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Moves the launch token from the URL fragment into session storage. */
export function bootstrapToken(): string | null {
  const match = /^#token=([\w-]+)$/u.exec(location.hash);
  if (match) {
    sessionStorage.setItem(TOKEN_KEY, match[1]!);
    history.replaceState(null, '', `${location.pathname}#/runs`);
  }
  return sessionStorage.getItem(TOKEN_KEY);
}

const authorization = (): Record<string, string> => ({
  authorization: `Bearer ${sessionStorage.getItem(TOKEN_KEY) ?? ''}`,
});

async function send(method: string, path: string, body?: unknown): Promise<Response> {
  const response = await fetch(path, {
    method,
    headers: { ...authorization(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.ok) return response;
  const detail = (await response.json().catch(() => null)) as { error?: string } | null;
  throw new ApiError(response.status, detail?.error ?? `${response.status} ${response.statusText}`);
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  return (await send(method, path, body)).json() as Promise<T>;
}

export const artifactPath = (runId: string, id: string): string =>
  `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(id)}`;
export const screenshotPath = (runId: string, shot: string): string =>
  `/api/runs/${encodeURIComponent(runId)}/screenshots/${shot}`;

export async function blobUrl(path: string): Promise<string> {
  return URL.createObjectURL(await (await send('GET', path)).blob());
}

export async function artifactText(runId: string, id: string): Promise<string> {
  return (await send('GET', artifactPath(runId, id))).text();
}

/** Downloads through an authenticated fetch so the token never appears in a link. */
export async function download(path: string, filename: string): Promise<void> {
  const url = await blobUrl(path);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

interface ModelInfo {
  id: string;
  provider: string;
  label: string;
  visionCapable: boolean | null;
  supportedEffortLevels: string[];
  defaultEffort: string | null;
  pricesPerMTok: { input: number | null; output: number | null; cachedInput: number | null };
  pricingVerifiedAt: string | null;
  untested: boolean;
  enabled: boolean;
}

export interface Models {
  catalog: { version: string; hash: string };
  providers: { id: string; available: boolean }[];
  models: ModelInfo[];
}

export interface ProjectDefaults {
  defaults: {
    model: string;
    effort: string | null;
    mode: 'vision' | 'text';
    repeats: number;
    limits: { steps?: number; timeMs?: number; dollars?: number };
  };
}

export interface RunSummary {
  id: string;
  batchId: string;
  repeat: number;
  personaId: string;
  goal: string;
  mode: string;
  provider: string;
  model: string;
  effort: string;
  untested: boolean;
  status: 'queued' | 'running' | 'finished' | 'cancelled' | 'interrupted';
  outcome: string | null;
  blockedKind: string | null;
  outcomeCode: string | null;
  interruptedBy: string | null;
  createdAt: string;
  startedAt: string | null;
  steps: number;
  durationMs: number | null;
  costUsd: number | null;
  capEnforcement: string;
}

export interface Editable {
  id: string;
  source: string;
  revision: string;
  parsed: Record<string, unknown> | null;
  error: string | null;
}

export const usd = (value: number | null | undefined): string =>
  value === null || value === undefined
    ? 'unknown'
    : `$${value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`;

export const isActive = (status: string): boolean => status === 'queued' || status === 'running';

export interface LiveEvent {
  id: number;
  type: string;
  data: Record<string, unknown>;
}

/** Splits complete SSE frames off `buffer`; comment-only frames (heartbeats) are dropped. */
export function splitEvents(buffer: string): { events: LiveEvent[]; rest: string } {
  const frames = buffer.split('\n\n');
  const rest = frames.pop() ?? '';
  const events: LiveEvent[] = [];
  for (const frame of frames) {
    let id = Number.NaN;
    let type = 'message';
    let data = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('id: ')) id = Number(line.slice(4));
      else if (line.startsWith('event: ')) type = line.slice(7);
      else if (line.startsWith('data: ')) data += line.slice(6);
    }
    if (Number.isInteger(id) && data) events.push({ id, type, data: JSON.parse(data) as Record<string, unknown> });
  }
  return { events, rest };
}

/**
 * The single SSE client: authenticated fetch streaming, resumed with Last-Event-ID after a drop.
 * `onEnd` fires once the server closes the stream for a finished run or refuses it.
 */
export function follow(
  runId: string,
  onEvent: (event: LiveEvent) => void,
  onEnd: () => void,
  delay = (attempt: number) => Math.min(500 * 2 ** attempt, 10_000),
): () => void {
  const controller = new AbortController();
  let last = 0;
  void (async () => {
    for (let attempt = 0; !controller.signal.aborted; attempt += 1) {
      try {
        const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/events`, {
          headers: { ...authorization(), 'last-event-id': String(last) },
          signal: controller.signal,
        });
        if (response.status >= 400 && response.status < 500) return onEnd();
        if (!response.ok || !response.body) throw new ApiError(response.status, 'event stream unavailable');
        let buffer = '';
        for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
          attempt = 0;
          const split = splitEvents(buffer + chunk);
          buffer = split.rest;
          for (const event of split.events) {
            last = event.id;
            onEvent(event);
          }
        }
        return onEnd();
      } catch {
        if (controller.signal.aborted) return;
        await new Promise((resolve) => setTimeout(resolve, delay(attempt)));
      }
    }
  })();
  return () => controller.abort();
}
