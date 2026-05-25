import { normalizeAssistantMarkdownForRender } from '@/features/chat/rendering/MessageRenderer';

describe('normalizeAssistantMarkdownForRender', () => {
  it('separates horizontal rules from following headings', () => {
    expect(normalizeAssistantMarkdownForRender('前文---##当前知识库状态')).toBe('前文\n\n---\n\n## 当前知识库状态');
  });

  it('adds missing spaces after heading markers', () => {
    expect(normalizeAssistantMarkdownForRender('##当前状态\n###行动清单')).toBe('## 当前状态\n### 行动清单');
  });

  it('splits compact markdown table rows', () => {
    const compact = '|维度|状态||------|------||日记|已读取|';
    expect(normalizeAssistantMarkdownForRender(compact)).toBe('|维度|状态|\n|------|------|\n|日记|已读取|');
  });

  it('separates inline headings from preceding Chinese text', () => {
    const compact = '检查结果—需要你确认再继续的变更以下是内容：###1.资料目录文件数变更';
    expect(normalizeAssistantMarkdownForRender(compact)).toBe('检查结果—需要你确认再继续的变更以下是内容：\n\n### 1.资料目录文件数变更');
  });

  it('separates emoji headings and compact checked bullet chains', () => {
    const compact = '找到问题。检查结果###✅无事实矛盾所有核心事实在来源层和知识库层一致： -生日1981.5.22✔-绰号墙哥✔-兴趣：篮球、摄影、写作、AI✔-状态：创业、找工作、带女儿✔-当前重点：越南贸易、日出酒吧、苏州市局、资金理顺✔###❌问题一：核心入口断链（6处）';

    expect(normalizeAssistantMarkdownForRender(compact)).toBe([
      '找到问题。检查结果',
      '',
      '### ✅无事实矛盾',
      '所有核心事实在来源层和知识库层一致：',
      '',
      '- 生日1981.5.22✔',
      '- 绰号墙哥✔',
      '- 兴趣：篮球、摄影、写作、AI✔',
      '- 状态：创业、找工作、带女儿✔',
      '- 当前重点：越南贸易、日出酒吧、苏州市局、资金理顺✔',
      '',
      '### ❌问题一：核心入口断链（6处）',
    ].join('\n'));
  });

  it('adds spacing after ordered-list markers before emoji text', () => {
    expect(normalizeAssistantMarkdownForRender('1.🟡基本画像\n2.🔴近期动态')).toBe('1. 🟡基本画像\n2. 🔴近期动态');
  });

  it('separates warning headings from following prose', () => {
    const compact = '矛盾项###⚠矛盾1（关键）：维护规则指向不一致-大叔墙的那些事.md第124行：>每周日21:30，汇总本周日记';

    expect(normalizeAssistantMarkdownForRender(compact)).toBe([
      '矛盾项',
      '',
      '### ⚠矛盾1（关键）：',
      '维护规则指向不一致-大叔墙的那些事.md第124行：>每周日21:30，汇总本周日记',
    ].join('\n'));
  });

  it('separates heading text from a following table header', () => {
    const compact = '###1.资料目录文件数变更（基于实际扫描）|目录|旧数量|新数量|变动说明|';
    expect(normalizeAssistantMarkdownForRender(compact)).toBe('### 1.资料目录文件数变更（基于实际扫描）\n\n|目录|旧数量|新数量|变动说明|');
  });

  it('rebuilds table rows split into isolated pipe lines', () => {
    const broken = [
      '|目录|旧|新|',
      '|------|:--:|:--:|',
      '|',
      '大叔墙的文章/',
      '|120|',
      '121',
      '|',
      '|',
      '大叔墙的工作/',
      '|34|',
      '49',
      '|',
    ].join('\n');

    expect(normalizeAssistantMarkdownForRender(broken)).toBe([
      '|目录|旧|新|',
      '|------|:--:|:--:|',
      '|大叔墙的文章/|120|121|',
      '|大叔墙的工作/|34|49|',
    ].join('\n'));
  });

  it('adds readable spacing for common compressed English status text', () => {
    expect(normalizeAssistantMarkdownForRender("NowI'llupdatethe全局知识地图sectionwithcurrentdirectorycountsandadd知识库/asanewentry."))
      .toBe("Now I'll update the 全局知识地图 section with current directory counts and add 知识库/ as a new entry.");
  });

  it('does not treat Obsidian or HTML anchors as headings', () => {
    const input = '|[[理顺个人资金]]、[[每天看书半小时]]|锚点写法 {#理顺个人资金} 和 {#每天看书半小时} 可能不跳转|';
    expect(normalizeAssistantMarkdownForRender(input)).toBe(input);
  });

  it('does not split hash characters inside braces', () => {
    const input = '把 `{#理顺个人资金}` 和 `{#每天看书半小时}` 改成标准标题。';
    expect(normalizeAssistantMarkdownForRender(input)).toBe(input);
  });
});
