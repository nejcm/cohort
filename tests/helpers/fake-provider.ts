import type { Locator, Page } from 'playwright';
import { pngSize } from '../../src/browser/observations.ts';
import type { ToolCall } from '../../src/core/tools.ts';
import type { DecideRequest, ProviderAdapter, Usage } from '../../src/providers/types.ts';

export type Turn = (request: DecideRequest, index: number) => ToolCall | ToolCall[] | Promise<ToolCall | ToolCall[]>;

export interface FakeProvider extends ProviderAdapter {
  requests: DecideRequest[];
}

const USAGE: Usage = {
  inputTokens: 1000,
  outputTokens: 50,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  imageInputTokens: null,
  reportedCostUsd: null,
  source: 'provider',
};

// Scripted stand-in for a model: no network, deterministic tool calls.
export function fakeProvider(turns: Turn | Turn[], usage: Partial<Usage> = {}): FakeProvider {
  const requests: DecideRequest[] = [];
  return {
    id: 'fake',
    keyEnv: 'FAKE_API_KEY',
    available: () => true,
    requests,
    async decide(request) {
      const index = requests.push(request) - 1;
      const turn = Array.isArray(turns) ? turns[Math.min(index, turns.length - 1)]! : turns;
      const result = await turn(request, index);
      return {
        calls: Array.isArray(result) ? result : [result],
        usage: { ...USAGE, ...usage },
        returnedModel: 'fake-model',
      };
    },
  };
}

/** Screenshot-space center of a locator for the current observation. */
export async function pointOf(
  page: Page,
  locator: Locator,
  request: DecideRequest,
): Promise<{ kind: 'point'; x: number; y: number }> {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport) throw new Error('target not visible');
  const image = pngSize(Buffer.from(request.observation.pngBase64, 'base64'));
  return {
    kind: 'point',
    x: Math.round(((box.x + box.width / 2) * image.width) / viewport.width),
    y: Math.round(((box.y + box.height / 2) * image.height) / viewport.height),
  };
}

export function lastStepId(request: DecideRequest): string {
  const match = /Latest step: (s\d{4,})/u.exec(request.observation.text);
  if (!match?.[1]) throw new Error('no latest step in observation');
  return match[1];
}
