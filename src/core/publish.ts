import { ConfigError } from '../config/files.ts';
import { PROVENANCE_PATTERNS, renderCompareMarkdown, type CompareResult } from './compare.ts';

type Fetch = typeof fetch;

export class PublishError extends Error {
  override name = 'PublishError';
}

const RUN_ID = /^run_[0-9]{8}_[0-9]{6}_[0-9a-f]{6}$/u;
const ORIGIN = /^https?:\/\/[^/\s?#@]+$/u;
const STATUSES = new Set(['passed', 'failed', 'error']);

/** Checks a compare report from another job before any of it reaches a comment. */
export function parseCompareReport(text: string): CompareResult {
  let report: CompareResult;
  try {
    report = JSON.parse(text) as CompareResult;
  } catch {
    throw new ConfigError('the compare report is not JSON');
  }
  const p = report?.provenance;
  const valid =
    RUN_ID.test(report?.runId) &&
    ORIGIN.test(report.base) &&
    ORIGIN.test(report.head) &&
    ['regression', 'no_regression', 'inconclusive'].includes(report.outcome) &&
    typeof report.reason === 'string' &&
    report.reason.length <= 500 &&
    Array.isArray(report.executions) &&
    report.executions.length <= 4 &&
    report.executions.every(
      (execution) =>
        ['base', 'head'].includes(execution?.side) &&
        STATUSES.has(execution.status) &&
        Number.isFinite(execution.durationMs) &&
        (execution.failure === null || (typeof execution.failure === 'string' && execution.failure.length <= 500)),
    ) &&
    p !== null &&
    typeof p === 'object' &&
    Object.entries(PROVENANCE_PATTERNS).every(([name, pattern]) => {
      const value = p[name as keyof typeof p];
      return value === null || pattern.test(String(value));
    });
  if (!valid) throw new ConfigError('the compare report does not have the shape cohort compare --json writes');
  if (Object.keys(PROVENANCE_PATTERNS).some((name) => p[name as keyof typeof p] === null))
    throw new ConfigError('the compare report has no complete provenance, so there is no pull request to comment on');
  return report;
}

const skip = (reason: string) => ({ action: 'skipped' as const, reason, commentId: null });

/** Posts or updates the one marked comment for this PR and journey, unless the PR head moved since the comparison. */
export async function publishCompare(
  report: CompareResult,
  options: { token: string; apiUrl?: string; evidenceUrl?: string; fetch?: Fetch },
): Promise<{ action: 'created' | 'updated' | 'skipped'; reason: string | null; commentId: number | null }> {
  const call = options.fetch ?? fetch;
  const api = `${options.apiUrl ?? 'https://api.github.com'}/repos/${report.provenance.repository}`;
  const request = async <T>(path: string, method = 'GET', body?: object): Promise<T> => {
    const response = await call(`${api}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${options.token}`,
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => {
      throw new PublishError(`GitHub ${method} ${path.split('?')[0]} did not respond`);
    });
    if (!response.ok) throw new PublishError(`GitHub ${method} ${path.split('?')[0]} returned ${response.status}`);
    return (await response.json()) as T;
  };
  const pr = report.provenance.pullRequest!;
  const staleness = async (): Promise<string | null> => {
    const pull = await request<{ head: { sha: string; repo: { full_name: string } | null } }>(`/pulls/${pr}`);
    if (pull.head.repo?.full_name !== report.provenance.repository)
      return 'the pull request comes from another repository';
    return pull.head.sha === report.provenance.headSha ? null : 'the pull request head moved since this comparison';
  };
  const stale = await staleness();
  if (stale) return skip(stale);
  const marker = `<!-- cohort-compare:${report.runId} -->`;
  let existing: number | null = null;
  for (let page = 1; existing === null; page += 1) {
    const comments = await request<{ id: number; body?: string; user?: { type?: string } }[]>(
      `/issues/${pr}/comments?per_page=100&page=${page}`,
    );
    existing = comments.find((comment) => comment.user?.type === 'Bot' && comment.body?.startsWith(marker))?.id ?? null;
    if (comments.length < 100) break;
  }
  const body = { body: renderCompareMarkdown(report, options.evidenceUrl) };
  const moved = await staleness();
  if (moved) return skip(moved);
  if (existing !== null) {
    await request(`/issues/comments/${existing}`, 'PATCH', body);
    return { action: 'updated', reason: null, commentId: existing };
  }
  const created = await request<{ id: number }>(`/issues/${pr}/comments`, 'POST', body);
  return { action: 'created', reason: null, commentId: created.id };
}
