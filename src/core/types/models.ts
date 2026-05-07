/**
 * Model type definitions and constants.
 */

import type { SdkBeta } from '@anthropic-ai/claude-agent-sdk';

/** Model identifier (string to support custom models via environment variables). */
export type ClaudeModel = string;

export const DEFAULT_CODEX_MODELS: { value: ClaudeModel; label: string; description: string }[] = [
  { value: 'gpt-5.5', label: 'GPT-5.5', description: '当前环境下更稳的默认 Codex 模型' },
  { value: 'gpt-5.4', label: 'GPT-5.4', description: '兼容性较好的 GPT-5.4 模型' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4-Mini', description: '更轻量的 GPT-5.4-Mini 模型' },
  { value: 'gpt-5.3-codex', label: 'GPT-5.3-Codex', description: '偏编码场景的 Codex 模型' },
  { value: 'gpt-5.2', label: 'GPT-5.2', description: '较旧但兼容的 GPT-5.2 模型' },
];

export const DEFAULT_CLAUDE_MODELS = DEFAULT_CODEX_MODELS;

export const BETA_1M_CONTEXT: SdkBeta = 'context-1m-2025-08-07';

export interface ModelWithBetas {
  model: string;
  betas: SdkBeta[];
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
  'gpt-5.5': 'off',
  'gpt-5.4': 'off',
  'gpt-5.4-mini': 'off',
  'gpt-5.3-codex': 'off',
  'gpt-5.2': 'off',
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
