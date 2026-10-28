import type { BrowserContextOptions } from 'playwright';

export interface SetupContext {
  runId: string;
  scopeId: string;
  projectRoot: string;
  signal: AbortSignal;
  env(name: string): string;
  onCleanup(handler: () => Promise<void>): void;
}

export interface CustomTool {
  description: string;
  inputSchema: Record<string, unknown>;
  execute(
    args: unknown,
    context: { signal: AbortSignal; bindSecret(name: string, value: string): string },
  ): Promise<{ text?: string; secretRefs?: Record<string, string> }>;
}

export interface SetupResult {
  startUrl: string;
  storageState?: BrowserContextOptions['storageState'];
  secrets?: Record<string, string>;
  tools?: Record<string, CustomTool>;
}

export type SetupModule = (context: SetupContext) => Promise<SetupResult>;
