import type { SetupModule } from 'synthetic-customer-lab';

// Signs in through the fixture's test-only API, then offers a code tool the agent calls just before it needs a code.
const setup: SetupModule = async (ctx) => {
  const origin = new URL(ctx.env('LAB_FIXTURE_ORIGIN'));
  const api = (path: string): string => new URL(`${path}?scope=${encodeURIComponent(ctx.scopeId)}`, origin).href;
  const post = async (path: string, signal: AbortSignal): Promise<Record<string, string>> => {
    const response = await fetch(api(path), { method: 'POST', signal });
    if (!response.ok) throw new Error(`${path} answered ${response.status}`);
    return (await response.json()) as Record<string, string>;
  };

  const { token } = await post('/lab/auth/session', ctx.signal);
  ctx.onCleanup(async () => void (await post('/lab/auth/logout', AbortSignal.timeout(5000))));

  return {
    startUrl: api('/lab/account'),
    storageState: {
      cookies: [
        {
          name: 'lab_session',
          value: token!,
          domain: origin.hostname,
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ],
      origins: [],
    },
    tools: {
      request_code: {
        description: 'Ask the test inbox for a fresh one-time sign-in code. Returns a placeholder to type with fill.',
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
        async execute(_args, { signal, bindSecret }) {
          const { code } = await post('/lab/auth/code', signal);
          return {
            text: 'A fresh code arrived; older codes no longer work.',
            secretRefs: { code: bindSecret('code', code!) },
          };
        },
      },
    },
  };
};

export default setup;
