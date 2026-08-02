/**
 * Model type definitions and constants.
 */

import type { RuntimeBeta } from '../runtime/contracts';

/** Model identifier (string to support custom models via environment variables). */
export type ClaudeModel = string;

export const DEFAULT_CODEX_MODELS: { value: ClaudeModel; label: string; description: string }[] = [
  { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', description: '最新旗舰 Agent 编码模型' },
  { value: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', description: '适合日常工作的均衡 Agent 编码模型' },
  { value: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', description: '快速且经济的 Agent 编码模型' },
  { value: 'gpt-5.5', label: 'GPT-5.5', description: '适合复杂编码、研究和实际工作的上一代模型' },
  { value: 'gpt-5.4', label: 'GPT-5.4', description: '适合日常编码的稳定模型' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4-Mini', description: '适合简单编码任务的轻量模型' },
];

export const DEFAULT_CLAUDE_MODELS = DEFAULT_CODEX_MODELS;

const RETIRED_CODEX_MODELS = new Set(['gpt-5.2', 'gpt-5.3-codex']);

export interface CodexModelCatalog {
  models: { value: ClaudeModel; label: string; description: string }[];
  defaultModel: ClaudeModel;
  thinkingBudgets: Record<string, ThinkingBudget>;
}

export interface CodexModelCatalogClient {
  initialize(): Promise<void>;
  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  kill(): void;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asThinkingBudget(value: unknown): ThinkingBudget | null {
  switch (value) {
    case 'off':
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return value;
    default:
      return null;
  }
}

/** Converts the Codex App Server model/list response into selector-ready data. */
export function parseCodexModelCatalog(value: unknown): CodexModelCatalog {
  const response = asRecord(value);
  const entries = Array.isArray(response?.data) ? response.data : [];
  const models: CodexModelCatalog['models'] = [];
  const thinkingBudgets: Record<string, ThinkingBudget> = {};
  let defaultModel = '';

  for (const rawEntry of entries) {
    const entry = asRecord(rawEntry);
    if (!entry || entry.hidden === true) continue;

    const model = asNonEmptyString(entry.model) ?? asNonEmptyString(entry.id);
    if (!model) continue;

    models.push({
      value: model,
      label: asNonEmptyString(entry.displayName) ?? model,
      description: asNonEmptyString(entry.description) ?? '',
    });

    const thinkingBudget = asThinkingBudget(entry.defaultReasoningEffort);
    if (thinkingBudget) {
      thinkingBudgets[model] = thinkingBudget;
    }
    if (!defaultModel && entry.isDefault === true) {
      defaultModel = model;
    }
  }

  return {
    models,
    defaultModel: defaultModel || models[0]?.value || '',
    thinkingBudgets,
  };
}

/** Reads the current account's models from Codex App Server with a bounded wait. */
export async function fetchCodexModelCatalog(
  createClient: (signal: AbortSignal) => CodexModelCatalogClient,
  timeoutMs = 5000,
): Promise<CodexModelCatalog> {
  const abortController = new AbortController();
  const client = createClient(abortController.signal);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const requestCatalog = async () => {
    await client.initialize();
    const response = await client.request('model/list', {});
    return parseCodexModelCatalog(response);
  };

  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      abortController.abort();
      reject(new Error('读取 Codex 模型清单超时。'));
    }, timeoutMs);
  });

  try {
    return await Promise.race([requestCatalog(), timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    client.kill();
  }
}

/** Migrates known retired built-ins without overwriting supported or custom choices. */
export function reconcileCodexModelSelection(
  currentModel: string,
  availableModels: string[],
  defaultModel: string,
): { model: string; migrated: boolean } {
  if (availableModels.includes(currentModel) || !RETIRED_CODEX_MODELS.has(currentModel) || !defaultModel) {
    return { model: currentModel, migrated: false };
  }
  return { model: defaultModel, migrated: true };
}

export const BETA_1M_CONTEXT: RuntimeBeta = 'context-1m-2025-08-07';

export interface ModelWithBetas {
  model: string;
  betas: RuntimeBeta[];
}

export interface ModelWithoutBetas {
  model: string;
  betas?: undefined;
}

/** Resolves a model to its base model and optional beta flags. */
export function resolveModelWithBetas(model: string, include1MBeta: true): ModelWithBetas;
export function resolveModelWithBetas(model: string, include1MBeta?: false): ModelWithoutBetas;
export function resolveModelWithBetas(model: string, include1MBeta: boolean): ModelWithBetas | ModelWithoutBetas;
export function resolveModelWithBetas(model: string, include1MBeta = false): ModelWithBetas | ModelWithoutBetas {
  if (!model || typeof model !== 'string') {
    throw new Error('resolveModelWithBetas: model is required and must be a non-empty string');
  }
  if (include1MBeta) {
    return {
      model,
      betas: [BETA_1M_CONTEXT],
    };
  }
  return { model };
}

export type ThinkingBudget = 'off' | 'low' | 'medium' | 'high' | 'xhigh';

export const THINKING_BUDGETS: { value: ThinkingBudget; label: string; tokens: number }[] = [
  { value: 'off', label: 'Off', tokens: 0 },
  { value: 'low', label: 'Low', tokens: 4000 },
  { value: 'medium', label: 'Med', tokens: 8000 },
  { value: 'high', label: 'High', tokens: 16000 },
  { value: 'xhigh', label: 'Ultra', tokens: 32000 },
];

/** Default thinking budget per model tier. */
export const DEFAULT_THINKING_BUDGET: Record<string, ThinkingBudget> = {
  'gpt-5.6-sol': 'low',
  'gpt-5.6-terra': 'medium',
  'gpt-5.6-luna': 'medium',
  'gpt-5.5': 'medium',
  'gpt-5.4': 'medium',
  'gpt-5.4-mini': 'medium',
};

export const CONTEXT_WINDOW_STANDARD = 200_000;
export const CONTEXT_WINDOW_1M = 1_000_000;

export function getContextWindowSize(
  model: string,
  is1MEnabled = false,
  customLimits?: Record<string, number>
): number {
  if (customLimits && model in customLimits) {
    const limit = customLimits[model];
    if (typeof limit === 'number' && limit > 0 && !isNaN(limit) && isFinite(limit)) {
      return limit;
    }
  }

  // Legacy 1M handling is retained only for backward compatibility.
  if (is1MEnabled && model.includes('sonnet')) {
    return CONTEXT_WINDOW_1M;
  }
  return CONTEXT_WINDOW_STANDARD;
}
