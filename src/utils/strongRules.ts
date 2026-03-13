function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---\n')) return markdown;

  const endIndex = markdown.indexOf('\n---\n', 4);
  if (endIndex === -1) return markdown;

  return markdown.slice(endIndex + 5);
}

export type StrongRulesQuickReplies = Record<string, string>;

function extractSectionLines(lines: string[], headingPattern: RegExp): string[] {
  const startIndex = lines.findIndex((line) => headingPattern.test(line.trim()));
  if (startIndex === -1) return [];

  const sectionLines: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+/.test(line.trim())) {
      break;
    }
    sectionLines.push(line);
  }

  return sectionLines;
}

export function extractStrongRulesFromMarkdown(markdown: string): string {
  const body = stripFrontmatter(markdown).trim();
  if (!body) return '';

  const lines = body.split(/\r?\n/);
  const firstHeadingIndex = lines.findIndex((line) => /^#\s+/.test(line));
  if (firstHeadingIndex === -1) {
    return body;
  }

  const sectionLines: string[] = [];
  for (let i = firstHeadingIndex; i < lines.length; i++) {
    const line = lines[i];
    if (i > firstHeadingIndex && /^#\s+/.test(line)) {
      break;
    }
    sectionLines.push(line);
  }

  return sectionLines.join('\n').trim();
}

export function extractQuickRepliesFromMarkdown(markdown: string): StrongRulesQuickReplies {
  const body = stripFrontmatter(markdown).trim();
  if (!body) return {};

  const lines = body.split(/\r?\n/);
  const quickReplyLines = extractSectionLines(lines, /^##\s+快捷回答\s*$/);
  if (quickReplyLines.length === 0) {
    return {};
  }

  const normalizedLines = quickReplyLines.map((line) => line.replace(/\r$/, ''));
  const replies: StrongRulesQuickReplies = {};
  let currentQuestion = '';
  let contentLines: string[] = [];

  const flush = () => {
    const normalizedQuestion = currentQuestion.trim();
    const normalizedContent = contentLines.join('\n').trim();
    if (normalizedQuestion && normalizedContent) {
      replies[normalizedQuestion] = normalizedContent;
    }
  };

  for (const line of normalizedLines) {
    const headingMatch = line.trim().match(/^###\s+(.+?)\s*$/);
    if (headingMatch) {
      flush();
      currentQuestion = headingMatch[1];
      contentLines = [];
      continue;
    }

    if (!currentQuestion) {
      continue;
    }

    contentLines.push(line);
  }

  flush();
  return replies;
}
