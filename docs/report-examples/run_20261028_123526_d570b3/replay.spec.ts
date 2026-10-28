import { test } from '@playwright/test';

const viewport = {"width":800,"height":600};

function binding(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing replay binding ${name}`);
  return value;
}

function bind(template: string): string {
  return template.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (_, name: string) => binding(`LAB_SECRET_${name.toUpperCase()}`));
}

test.use({
  viewport,
  hasTouch: false,
  locale: "en-US",
  timezoneId: "UTC",
  ...(process.env.LAB_STORAGE_STATE ? { storageState: process.env.LAB_STORAGE_STATE } : {}),
});

test("replay run_20261028_123526_d570b3", async ({ page }) => {
  await test.step("s0000 navigate", async () => {
    await page.goto(binding('LAB_START_URL'));
  });
  await test.step("s0001 wait", async () => {
    await page.waitForTimeout(100);
  });
  await test.step("s0002 scroll", async () => {
    await page.mouse.move(viewport.width / 2, viewport.height / 2);
    await page.mouse.wheel(0, 200);
  });
  await test.step("s0003 wait", async () => {
    await page.waitForTimeout(100);
  });
  await test.step("s0004 scroll", async () => {
    await page.mouse.move(viewport.width / 2, viewport.height / 2);
    await page.mouse.wheel(0, 200);
  });
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
});
