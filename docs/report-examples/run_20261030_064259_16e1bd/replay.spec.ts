import { expect, test } from '@playwright/test';

const viewport = {"width":800,"height":600};

function binding(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing replay binding ${name}`);
  return value;
}

const isTokenLike = (value        ) =>
  value.length >= 20 || (value.length >= 8 && /\d/u.test(value) && /\p{L}/u.test(value));

function inheritQuery(url: URL): string {
  const start = new URL(binding('COHORT_START_URL'));
  if (url.origin !== start.origin || url.search) return url.href;
  const hidden = Object.entries(process.env).filter(([name, value]) => value && /^COHORT_(SECRET_|TOOL_TOKEN)/.test(name)).map(([, value]) => value as string);
  for (const [name, value] of start.searchParams) if (!isTokenLike(value) && !hidden.some((secret) => value.includes(secret))) url.searchParams.append(name, value);
  return url.href;
}

function bind(template: string): string {
  return template.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (_, name: string) => binding(`COHORT_SECRET_${name.toUpperCase()}`));
}

test.use({
  viewport,
  hasTouch: false,
  locale: "en-US",
  timezoneId: "UTC",
  ...(process.env.COHORT_STORAGE_STATE ? { storageState: process.env.COHORT_STORAGE_STATE } : {}),
});

test("replay run_20261030_064259_16e1bd", async ({ page }) => {

  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
});
