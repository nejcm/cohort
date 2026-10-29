import { expect, test } from '@playwright/test';

const viewport = {"width":800,"height":600};

function binding(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing replay binding ${name}`);
  return value;
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

test("replay run_20261029_144720_1b4cfa", async ({ page }) => {
  await test.step("s0000 navigate", async () => {
    await page.goto(binding('COHORT_START_URL'));
  });
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
});
