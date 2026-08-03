jest.mock('@/utils/date', () => ({
  getTodayDate: () => 'Mocked Date',
}));

import { getInlineEditSystemPrompt } from '@/core/prompts/inlineEdit';
import { buildSystemPrompt } from '@/core/prompts/mainAgent';

describe('systemPrompt', () => {
  describe('buildSystemPrompt', () => {
    it('should append custom prompt section when provided', () => {
      const prompt = buildSystemPrompt({ customPrompt: 'Always be concise.' });
      expect(prompt).toContain('# Custom Instructions');
      expect(prompt).toContain('Always be concise.');
    });

    it('should append strong rules section when provided', () => {
      const prompt = buildSystemPrompt({ strongRulesPrompt: '# Strong Rules\n\nAlways use Chinese.' });
      expect(prompt).toContain('# Strong Rules');
      expect(prompt).toContain('Always use Chinese.');
    });

    it('should not append custom prompt section when empty', () => {
      const prompt = buildSystemPrompt({ customPrompt: '   ' });
      expect(prompt).not.toContain('# Custom Instructions');
    });

    it('should not append custom prompt section when undefined', () => {
      const prompt = buildSystemPrompt({});
      expect(prompt).not.toContain('# Custom Instructions');
    });

    it('should include base system prompt elements', () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toContain('Mocked Date');
      expect(prompt).toContain('Codian');
      expect(prompt).toContain('# Path Rules');
      expect(prompt).toContain('# User Message Format');
      expect(prompt).toContain('<context_files>');
    });

    it('should instruct the model to keep context reading internal', () => {
      const prompt = buildSystemPrompt();
      expect(prompt).toContain('## Response Behavior');
      expect(prompt).toContain('Context reading is an internal step. Do not narrate it.');
      expect(prompt).toContain('lead with a direct answer first');
    });

    it('keeps all Codian safety boundaries in a compact fixed prompt', () => {
      const prompt = buildSystemPrompt();

      expect(prompt).toContain('Codian');
      expect(prompt).toContain('## Path Rules');
      expect(prompt).toContain('<current_note>');
      expect(prompt).toContain('<context_files>');
      expect(prompt).toContain('stay inside the vault');
      expect(prompt).toContain('Do NOT use WebSearch');
      expect(prompt).toContain('use wikilink format');
      expect(prompt).toContain('never overwrite data without understanding context');
      expect(prompt).toContain('## Embedded Images in Notes');
      expect(prompt.length).toBeLessThan(9_000);
    });

    it('should include allowed export paths instructions when configured', () => {
      const prompt = buildSystemPrompt({ allowedExportPaths: ['~/Desktop', '/tmp'] });
      expect(prompt).toContain('# Allowed Export Paths');
      expect(prompt).toContain('- ~/Desktop');
      expect(prompt).toContain('- /tmp');
      expect(prompt).toContain('write-only');
    });

    it('should not include export paths when all paths are whitespace-only', () => {
      const prompt = buildSystemPrompt({ allowedExportPaths: ['   ', '', '  '] });
      expect(prompt).not.toContain('# Allowed Export Paths');
    });

    it('should deduplicate and filter export paths', () => {
      const prompt = buildSystemPrompt({ allowedExportPaths: ['~/Desktop', '~/Desktop', '', '/tmp'] });
      expect(prompt).toContain('# Allowed Export Paths');
      expect(prompt).toContain('- ~/Desktop');
      expect(prompt).toContain('- /tmp');
    });
  });

  describe('userName in system prompt', () => {
    it('should include user context when userName is provided', () => {
      const prompt = buildSystemPrompt({ userName: 'Alice' });
      expect(prompt).toContain('## User Context');
      expect(prompt).toContain('You are collaborating with **Alice**.');
    });

    it('should not include user context when userName is empty', () => {
      const prompt = buildSystemPrompt({ userName: '' });
      expect(prompt).not.toContain('## User Context');
    });

    it('should not include user context when userName is whitespace only', () => {
      const prompt = buildSystemPrompt({ userName: '   ' });
      expect(prompt).not.toContain('## User Context');
    });

    it('should not include user context when userName is undefined', () => {
      const prompt = buildSystemPrompt({});
      expect(prompt).not.toContain('## User Context');
    });

    it('should trim whitespace from userName', () => {
      const prompt = buildSystemPrompt({ userName: '  Bob  ' });
      expect(prompt).toContain('You are collaborating with **Bob**.');
      expect(prompt).not.toContain('**  Bob  **');
    });
  });

  describe('media folder instructions', () => {
    it('should use vault root path when mediaFolder is empty', () => {
      const prompt = buildSystemPrompt({ mediaFolder: '' });
      expect(prompt).toContain('Located in media folder: `.`');
      expect(prompt).toContain('Read file_path="image.jpg"');
    });

    it('should use vault root path when mediaFolder is whitespace only', () => {
      const prompt = buildSystemPrompt({ mediaFolder: '   ' });
      expect(prompt).toContain('Located in media folder: `.`');
    });

    it('should use custom mediaFolder path when provided', () => {
      const prompt = buildSystemPrompt({ mediaFolder: 'attachments' });
      expect(prompt).toContain('Located in media folder: `./attachments`');
      expect(prompt).toContain('Read file_path="attachments/image.jpg"');
    });

    it('should handle mediaFolder with special characters', () => {
      const prompt = buildSystemPrompt({ mediaFolder: '- attachments' });
      expect(prompt).toContain('Located in media folder: `./- attachments`');
      expect(prompt).toContain('Read file_path="- attachments/image.jpg"');
    });

    it('should include external image handling instructions', () => {
      const prompt = buildSystemPrompt({ mediaFolder: 'media' });
      expect(prompt).toContain('WebFetch does NOT support images');
      expect(prompt).toContain('Download to media folder');
      expect(prompt).toContain('curl');
      expect(prompt).toContain('replace the markdown link');
    });
  });

  describe('getInlineEditSystemPrompt', () => {
    it('should include inline edit critical output rules', () => {
      const prompt = getInlineEditSystemPrompt();
      expect(prompt).toContain('ABSOLUTE RULE');
      expect(prompt).toContain('<replacement>');
    });

    it('should include read-only tool descriptions', () => {
      const prompt = getInlineEditSystemPrompt();
      expect(prompt).toContain('Read, Grep, Glob, LS, WebSearch, WebFetch');
      expect(prompt).toContain('read-only');
    });

    it('should include example scenarios', () => {
      const prompt = getInlineEditSystemPrompt();
      expect(prompt).toContain('translate to French');
      expect(prompt).toContain('Bonjour le monde');
      expect(prompt).toContain('asking for clarification');
    });

    it('should include date from utils', () => {
      const prompt = getInlineEditSystemPrompt();
      expect(prompt).toContain('Mocked Date');
    });
  });
});
