const TOKEN_KEY = 'cohort-token';

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
    history.replaceState(null, '', '/runs');
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
  pricesPerMTok: { input: number | null; output: number | null; cachedInput: number | null; cacheWrite: number | null };
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

export const initials = (id: string): string =>
  id
    .split(/[-_,\s]+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');
/** A stable identity tint class (p0-p4) for a persona id. */
export const tint = (id: string): string => `p${[...id].reduce((hash, char) => hash + char.charCodeAt(0), 0) % 5}`;

export const isActive = (status: string): boolean => status === 'queued' || status === 'running';

const BADGES: Record<string, string> = {
  completed: 'succeeded',
  blocked: 'blocked',
  limit_reached: 'limit',
  agent_error: 'failed',
  abandoned: 'interrupted',
  cancelled: 'interrupted',
  interrupted: 'interrupted',
};
/** The lab.css badge class for a run's status or outcome. */
export const badge = (status: string, outcome?: string | null, interruptedBy?: string | null): string =>
  interruptedBy ? 'interrupted' : (BADGES[outcome ?? status] ?? BADGES[status] ?? status);

/** Outcome and claim codes read as words: limit_reached → limit reached. */
export const words = (code: string): string => code.replaceAll('_', ' ');

export const statusLabel = (run: RunSummary): string =>
  run.status === 'finished'
    ? `${run.outcome ? words(run.outcome) : 'finished'}${run.blockedKind ? ` (${run.blockedKind})` : ''}${run.interruptedBy ? ` by ${run.interruptedBy}` : ''}`
    : run.status;

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
 * `onEnd` fires once the run has finished (or the server refuses the stream); a clean close of an active run reconnects.
 */
export function follow(
  runId: string,
  onEvent: (event: LiveEvent) => void,
  onEnd: () => void,
  delay = (attempt: number) => Math.min(500 * 2 ** attempt, 10_000),
): () => void {
  const controller = new AbortController();
  let last = 0;
  let finished = false;
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
            finished ||= event.type === 'run.finished';
            onEvent(event);
          }
        }
        const { run } = finished
          ? { run: null }
          : await api<{ run: { status: string } }>('GET', `/api/runs/${encodeURIComponent(runId)}`);
        if (!run || !isActive(run.status)) return onEnd();
      } catch {
        if (controller.signal.aborted) return;
      }
      await new Promise((resolve) => setTimeout(resolve, delay(attempt)));
    }
  })();
  return () => controller.abort();
}
