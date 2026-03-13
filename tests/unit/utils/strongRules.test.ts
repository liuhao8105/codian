import { extractQuickRepliesFromMarkdown, extractStrongRulesFromMarkdown } from '@/utils/strongRules';

describe('strongRules', () => {
  it('extracts the first level-1 heading section after frontmatter', () => {
    const markdown = `---
title: Test
---

# Strong Rules

You are a writing assistant.

1. Use Chinese.
2. Be concise.

# Profile

Other content`;

    expect(extractStrongRulesFromMarkdown(markdown)).toBe(`# Strong Rules

You are a writing assistant.

1. Use Chinese.
2. Be concise.`);
  });

  it('falls back to the whole body when no level-1 heading exists', () => {
    const markdown = `---
title: Test
---

No heading here.
Just content.`;

    expect(extractStrongRulesFromMarkdown(markdown)).toBe(`No heading here.
Just content.`);
  });

  it('returns empty string for empty markdown', () => {
    expect(extractStrongRulesFromMarkdown('')).toBe('');
  });

  it('extracts configured quick replies from the quick reply section', () => {
    const markdown = `---
title: Test
---

# Strong Rules

Rule body

## 快捷回答

### 你是谁
我是丫头。

### 你能做什么
我主要帮你写作和整理。

### 你记得我什么
我记得你的偏好和近期动态。`;

    expect(extractQuickRepliesFromMarkdown(markdown)).toEqual({
      '你是谁': '我是丫头。',
      '你能做什么': '我主要帮你写作和整理。',
      '你记得我什么': '我记得你的偏好和近期动态。',
    });
  });

  it('returns empty quick replies when the section is missing', () => {
    expect(extractQuickRepliesFromMarkdown('# Strong Rules')).toEqual({});
  });
});
