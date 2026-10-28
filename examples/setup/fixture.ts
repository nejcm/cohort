import type { SetupModule } from 'synthetic-customer-lab';

const setup: SetupModule = async (ctx) => {
  const origin = new URL(ctx.env('LAB_FIXTURE_ORIGIN'));
  const startUrl = new URL('/', origin);
  startUrl.searchParams.set('scope', ctx.scopeId);
  return { startUrl: startUrl.href };
};

export default setup;
