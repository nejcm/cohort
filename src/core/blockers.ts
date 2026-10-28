import type { BLOCKED_KINDS } from './tools.ts';

type BlockedKind = (typeof BLOCKED_KINDS)[number];

/** Disclosed in docs/setup-and-login.md; deliberately small and not exhaustive. A leading dot matches subdomains. */
export const KNOWN_BLOCKERS = {
  version: 1,
  hosts: [
    ['accounts.google.com', 'oauth'],
    ['login.microsoftonline.com', 'oauth'],
    ['login.live.com', 'oauth'],
    ['appleid.apple.com', 'oauth'],
    ['login.salesforce.com', 'oauth'],
    ['.okta.com', 'oauth'],
    ['.auth0.com', 'oauth'],
    ['.onelogin.com', 'oauth'],
    ['.amazoncognito.com', 'oauth'],
    ['challenges.cloudflare.com', 'captcha'],
    ['.hcaptcha.com', 'captcha'],
    ['checkout.stripe.com', 'payment'],
    ['www.paypal.com', 'payment'],
    ['pay.google.com', 'payment'],
  ] as const satisfies readonly (readonly [string, BlockedKind])[],
};

export function knownBlocker(url: string): { kind: BlockedKind; host: string } | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  const hit = KNOWN_BLOCKERS.hosts.find(([pattern]) =>
    pattern.startsWith('.') ? host.endsWith(pattern) : host === pattern,
  );
  return hit ? { kind: hit[1], host } : null;
}
