import type { BLOCKED_KINDS } from './tools.ts';

type BlockedKind = (typeof BLOCKED_KINDS)[number];

export interface EvidenceRef {
  stepId: string;
  screenshotId: string;
}

export type AgentErrorCode =
  | 'loop'
  | 'tool_error'
  | 'invalid_tool'
  | 'unsupported_target'
  | 'provider_error'
  | 'browser_error'
  | 'setup_error'
  | 'artifact_error'
  | 'interrupted';

export type Outcome =
  | { state: 'completed'; reason: string; evidence: EvidenceRef[]; verification: 'agent_reported' | 'harness_verified' }
  | { state: 'abandoned'; reason: string; initiatedBy: 'agent'; evidence: EvidenceRef[] }
  | { state: 'blocked'; kind: BlockedKind; detectedBy: 'agent' | 'harness'; reason: string; evidence: EvidenceRef[] }
  | {
      state: 'agent_error';
      code: AgentErrorCode;
      interruptedBy?: 'user' | 'process';
      reason: string;
      evidence: EvidenceRef[];
    }
  | {
      state: 'limit_reached';
      limit: 'steps' | 'time' | 'cost';
      reason: string;
      observed: number;
      maximum: number;
      evidence: EvidenceRef[];
    };
