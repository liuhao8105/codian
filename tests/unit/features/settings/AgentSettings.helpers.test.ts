import { mergeSelectedOptions, normalizeAgentNameCandidate } from '@/features/settings/ui/AgentSettings';

describe('mergeSelectedOptions', () => {
  it('returns undefined for empty selections', () => {
    expect(mergeSelectedOptions([])).toBeUndefined();
  });

  it('trims, deduplicates, and sorts selected values', () => {
    expect(
      mergeSelectedOptions(['  WebSearch ', 'Read', 'Read', '', 'Bash'])
    ).toEqual(['Bash', 'Read', 'WebSearch']);
  });
});

describe('normalizeAgentNameCandidate', () => {
  it('normalizes common ASCII names into a valid slug', () => {
    expect(normalizeAgentNameCandidate(' Brainstorm Helper_V2 ')).toBe('brainstorm-helper-v2');
  });

  it('keeps non-ASCII input for validator to reject later', () => {
    expect(normalizeAgentNameCandidate('头脑风暴助手')).toBe('头脑风暴助手');
  });
});
