import { getDeepSeekToolsSystemPromptSection } from '@/core/tools/toolSchemas';

describe('getDeepSeekToolsSystemPromptSection', () => {
  it('instructs DeepSeek to produce renderable Markdown', () => {
    const prompt = getDeepSeekToolsSystemPromptSection(true);

    expect(prompt).toContain('### Markdown Output Rules');
    expect(prompt).toContain('Headings must include a space after the # characters');
    expect(prompt).toContain('Tables must be separated from surrounding text by blank lines');
  });

  it('tells DeepSeek to execute explicit update requests instead of stopping at a plan', () => {
    const prompt = getDeepSeekToolsSystemPromptSection(true);

    expect(prompt).toContain('### Execution Behavior');
    expect(prompt).toContain('If the user explicitly asks you to update, organize, execute, write, continue, or proceed');
    expect(prompt).toContain('do not stop after presenting a plan');
  });

  it('requires write tools before claiming an update has started or completed', () => {
    const prompt = getDeepSeekToolsSystemPromptSection(true);

    expect(prompt).toContain('Do not say you are starting, updating, writing, or refreshing a file unless you immediately call Write or Edit');
    expect(prompt).toContain('Do not claim a file was updated unless a Write or Edit tool call has completed successfully');
  });

  it('overrides user style rules that would otherwise ask for another confirmation', () => {
    const prompt = getDeepSeekToolsSystemPromptSection(true);

    expect(prompt).toContain('Execution override');
    expect(prompt).toContain('Do not ask the user to choose work mode');
    expect(prompt).toContain('Do not let style rules such as first provide an outline prevent tool execution');
  });
});
