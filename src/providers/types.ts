import type { ToolCall, ToolDefinition } from '../core/tools.ts';

export type Effort = 'low' | 'medium' | 'high';
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high'];

interface VisionObservation {
  kind: 'vision';
  id: string;
  /** Model-safe text describing the observation; never contains secrets, queries, or fragments. */
  text: string;
  pngBase64: string;
}

interface TextObservation {
  kind: 'text';
  id: string;
  /** Model-safe text holding the redacted accessibility snapshot. */
  text: string;
}

export interface Usage {
  /** Total input tokens, including cached and cache-write tokens. */
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  imageInputTokens: number | null;
  reportedCostUsd: number | null;
  source: 'provider' | 'estimated';
}

export interface DecideRequest {
  model: string;
  effort: Effort;
  instructions: string;
  history: readonly string[];
  observation: VisionObservation | TextObservation;
  tools: readonly ToolDefinition[];
  maxOutputTokens: number;
}

export interface Decision {
  calls: ToolCall[];
  /** Null when the response lacks valid token counts; the call's reservation then stays unsettled. */
  usage: Usage | null;
  returnedModel: string | null;
  requestId?: string;
}

export interface ProviderAdapter {
  id: string;
  keyEnv: string;
  available(): boolean;
  decide(request: DecideRequest, options: { signal: AbortSignal }): Promise<Decision>;
}

export class ProviderError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;
  // A failed request may still be billed; callers keep its reservation.
  readonly possiblyBilled: boolean;
  constructor(message: string, options: { status: number | null; retryable: boolean; possiblyBilled: boolean }) {
    super(message);
    this.name = 'ProviderError';
    this.status = options.status;
    this.retryable = options.retryable;
    this.possiblyBilled = options.possiblyBilled;
  }
}

export interface AdapterOptions {
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}

export function userText(request: DecideRequest): string {
  return [
    'Recent steps (oldest first):',
    ...(request.history.length > 0 ? request.history : ['(none)']),
    '',
    request.observation.text,
  ].join('\n');
}

export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  secret: string,
  signal: AbortSignal,
): Promise<{ json: Record<string, unknown>; headers: Headers }> {
  const scrub = (text: string): string => text.split(secret).join('[redacted]').slice(0, 500);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ProviderError(`transport failure: ${scrub(String(error))}`, {
      status: null,
      retryable: true,
      possiblyBilled: true,
    });
  }
  const text = await response.text();
  if (!response.ok) {
    throw new ProviderError(`HTTP ${response.status}: ${scrub(text)}`, {
      status: response.status,
      retryable: response.status === 429 || response.status >= 500,
      possiblyBilled: response.status >= 500,
    });
  }
  try {
    return { json: JSON.parse(text) as Record<string, unknown>, headers: response.headers };
  } catch {
    throw new ProviderError('malformed JSON response', {
      status: response.status,
      retryable: false,
      possiblyBilled: true,
    });
  }
}

export function parseArguments(raw: unknown): Record<string, unknown> {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      value = null;
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ProviderError('tool arguments are not an object', {
      status: null,
      retryable: false,
      possiblyBilled: true,
    });
  return value as Record<string, unknown>;
}

export function tokenCount(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

export function effortOrThrow(effort: string): Effort {
  if (!(EFFORTS as readonly string[]).includes(effort))
    throw new ProviderError(`unsupported effort: ${effort}`, { status: null, retryable: false, possiblyBilled: false });
  return effort as Effort;
}
