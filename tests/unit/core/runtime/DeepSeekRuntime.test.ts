jest.mock('@/core/tools/mcpBridge', () => ({
  classifyMcpToolRisk: jest.fn(() => ({ level: 'read-only', reason: 'test' })),
  enumerateMcpToolsForDeepSeek: jest.fn(),
}));

import type { McpServerManager } from '@/core/mcp';
import {
  appendWithinDeepSeekStreamLimit,
  DeepSeekRuntime,
  fetchDeepSeekResponseWithTimeout,
  parseDeepSeekDSMLToolCalls,
  parseSSEStream,
  readSseChunkWithTimeout,
  shouldForceDeepSeekExecutionContinuation,
  shouldForceDeepSeekWriteAfterToolRounds,
  stripDeepSeekDSMLToolCallBlocks,
} from '@/core/runtime/DeepSeekRuntime';
import { enumerateMcpToolsForDeepSeek } from '@/core/tools/mcpBridge';
import { DEFAULT_SETTINGS } from '@/core/types/settings';
import type CodianPlugin from '@/main';

const enumerateMcpToolsForDeepSeekMock = enumerateMcpToolsForDeepSeek as jest.MockedFunction<
  typeof enumerateMcpToolsForDeepSeek
>;

function createDeepSeekRuntime(mcpManager?: McpServerManager): DeepSeekRuntime {
  const settings = {
    ...DEFAULT_SETTINGS,
    providerConfigs: {
      ...DEFAULT_SETTINGS.providerConfigs,
      deepseek: {
        enabled: true,
        apiKey: 'sk-test',
        baseUrl: 'https://api.deepseek.example/v1',
        model: 'deepseek-chat',
      },
    },
  };
  const plugin = {
    settings,
    app: { vault: { adapter: { basePath: '/mock/vault' } } },
  } as unknown as CodianPlugin;
  return new DeepSeekRuntime(plugin, mcpManager);
}

describe('DeepSeekRuntime MCP discovery gating', () => {
  afterEach(() => {
    enumerateMcpToolsForDeepSeekMock.mockReset();
  });

  it('starts an ordinary chat without waiting for unrequested MCP discovery', async () => {
    let finishDiscovery!: (value: []) => void;
    enumerateMcpToolsForDeepSeekMock.mockReturnValue(new Promise((resolve) => {
      finishDiscovery = resolve;
    }));
    const mcpManager = {
      getServers: () => [
        { name: 'eagle-mcp', enabled: true },
        { name: 'zhipu-web-search', enabled: true },
      ],
    } as unknown as McpServerManager;
    const iterator = createDeepSeekRuntime(mcpManager).query('你好');

    let firstChunkSettled = false;
    const firstChunkPromise = iterator.next().then((result) => {
      firstChunkSettled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(firstChunkSettled).toBe(true);

    finishDiscovery([]);
    await expect(firstChunkPromise).resolves.toMatchObject({
      value: { type: 'runtime_user_sent' },
      done: false,
    });
  });

  it('does not let an unselected MCP server delay an explicitly selected server', async () => {
    let finishUnfilteredDiscovery!: (value: []) => void;
    enumerateMcpToolsForDeepSeekMock.mockImplementation(((_manager, requestedNames?: Set<string>) => {
      if (
        requestedNames?.size === 1
        && requestedNames.has('eagle-mcp')
      ) {
        return Promise.resolve([]);
      }
      return new Promise((resolve) => {
        finishUnfilteredDiscovery = resolve;
      });
    }) as typeof enumerateMcpToolsForDeepSeek);
    const mcpManager = {
      getServers: () => [
        { name: 'eagle-mcp', enabled: true },
        { name: 'zhipu-web-search', enabled: true },
      ],
    } as unknown as McpServerManager;
    const iterator = createDeepSeekRuntime(mcpManager).query(
      '使用 Eagle 查询素材',
      undefined,
      undefined,
      { enabledMcpServers: new Set(['eagle-mcp']) },
    );

    let firstChunkSettled = false;
    const firstChunkPromise = iterator.next().then((result) => {
      firstChunkSettled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(firstChunkSettled).toBe(true);

    if (finishUnfilteredDiscovery) finishUnfilteredDiscovery([]);
    await expect(firstChunkPromise).resolves.toMatchObject({
      value: { type: 'runtime_user_sent' },
      done: false,
    });
  });
});

describe('DeepSeekRuntime network liveness', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('rejects when response headers do not arrive within 30 seconds', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => {}));

    const request = fetchDeepSeekResponseWithTimeout('https://example.invalid', {}, new AbortController().signal);
    const rejection = request.catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(30_000);

    await expect(rejection).resolves.toEqual(
      new Error('DeepSeek API connection timed out after 30000ms.'),
    );
  });

  it('propagates user cancellation before the header timeout', async () => {
    jest.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(() => {}));
    const controller = new AbortController();

    const request = fetchDeepSeekResponseWithTimeout('https://example.invalid', {}, controller.signal);
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('clears the response-header timer after success', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

    await fetchDeepSeekResponseWithTimeout('https://example.invalid', {}, new AbortController().signal);

    expect(jest.getTimerCount()).toBe(0);
  });

  it('rejects and cancels a reader after 90 seconds of stream inactivity', async () => {
    const reader = {
      read: jest.fn(() => new Promise<ReadableStreamReadResult<Uint8Array>>(() => {})),
      cancel: jest.fn(async () => undefined),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;

    const read = readSseChunkWithTimeout(reader, new AbortController().signal);
    const rejection = read.catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(90_000);

    await expect(rejection).resolves.toEqual(
      new Error('DeepSeek stream was idle for 90000ms.'),
    );
    expect(reader.cancel).toHaveBeenCalledTimes(1);
  });
});

describe('DeepSeekRuntime stream capacity', () => {
  it('rejects an incomplete SSE line larger than 1 MiB', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(1024 * 1024 + 1)));
        controller.close();
      },
    });
    const iterator = parseSSEStream(new Response(stream), new AbortController().signal);

    await expect(iterator.next()).rejects.toThrow('DeepSeek SSE buffer exceeds 1048576 characters.');
  });

  it('rejects accumulated text, reasoning, and tool arguments above 1 MiB', () => {
    for (const label of ['text', 'reasoning', 'tool arguments']) {
      expect(() => appendWithinDeepSeekStreamLimit('x'.repeat(1024 * 1024), 'y', label))
        .toThrow(`DeepSeek ${label} exceeds 1048576 characters.`);
    }
  });
});

describe('DeepSeekRuntime DSML fallback parsing', () => {
  const dsml = `<||DSML||tool_calls>
<||DSML||invoke name="Bash">
<||DSML||parameter name="description" string="true">查看目标文件夹</||DSML||parameter>
<||DSML||parameter name="command" string="true">ls -la "大叔墙的笔记/学习笔记"</||DSML||parameter>
</||DSML||invoke>
</||DSML||tool_calls>`;

  it('parses text DSML tool calls into executable tool calls', () => {
    const calls = parseDeepSeekDSMLToolCalls(dsml);

    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('Bash');
    expect(JSON.parse(calls[0].function.arguments)).toEqual({
      description: '查看目标文件夹',
      command: 'ls -la "大叔墙的笔记/学习笔记"',
    });
  });

  it('strips DSML tool call blocks from visible text', () => {
    const stripped = stripDeepSeekDSMLToolCallBlocks(`前文\n${dsml}\n后文`);

    expect(stripped).toContain('前文');
    expect(stripped).toContain('后文');
    expect(stripped).not.toContain('DSML');
    expect(stripped).not.toContain('invoke name="Bash"');
  });

  it('parses compact DSML tags emitted as visible text', () => {
    const compact = `< | | DSML | | tool_calls>
< | | DSML | | invokename="Bash">
< | | DSML | | parametername="description"string="true">修正参数重新转写视频</| | DSML | | parameter>
< | | DSML | | parametername="command"string="true">python3 ~/.codian/skills/transcribe/scripts/transcribe_diarize.py "/tmp/video.mp4" --model gpt-4o-mini-transcribe</| | DSML | | parameter>
</| | DSML | | invoke>
</| | DSML | | tool_calls>`;

    const calls = parseDeepSeekDSMLToolCalls(compact);

    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('Bash');
    expect(JSON.parse(calls[0].function.arguments)).toEqual({
      description: '修正参数重新转写视频',
      command: 'python3 ~/.codian/skills/transcribe/scripts/transcribe_diarize.py "/tmp/video.mp4" --model gpt-4o-mini-transcribe',
    });
    expect(stripDeepSeekDSMLToolCallBlocks(compact)).toBe('');
  });

  it('parses compact DSML tags when tag names are glued to adjacent tags', () => {
    const glued = `< | | DSML | | tool_calls>< | | DSML | | invokename="Bash">< | | DSML | | parametername="description"string="true">查找视频文件</| | DSML | | parameter>< | | DSML | | parametername="command"string="true">find . -path "*涂抹工具*" -name "*.mp4"</| | DSML | | parameter></| | DSML | | invoke></| | DSML | | tool_calls>`;

    const calls = parseDeepSeekDSMLToolCalls(glued);

    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('Bash');
    expect(JSON.parse(calls[0].function.arguments)).toEqual({
      description: '查找视频文件',
      command: 'find . -path "*涂抹工具*" -name "*.mp4"',
    });
    expect(stripDeepSeekDSMLToolCallBlocks(glued)).toBe('');
  });

  it('parses visible Read DSML emitted after transcription', () => {
    const readCall = `转写完成，读取转写稿。 < | | DSML | | tool_calls>< | | DSML | | invoke name="Read">< | | DSML | | parameter name="file_path" string="true">大叔墙的笔记/学习笔记/摄影学习笔记/原来这才是ps涂抹工具的最强用法-原来这才是ps涂抹工具的最强用法ps教程-琎哥哥探设计／452/transcribe/原来这才是ps涂抹工具的最强用法-原来这才是ps涂抹工具的最强用法ps教程-琎哥哥探设计／452.txt</| | DSML | | parameter></| | DSML | | invoke></| | DSML | | tool_calls>`;

    const calls = parseDeepSeekDSMLToolCalls(readCall);

    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('Read');
    expect(JSON.parse(calls[0].function.arguments)).toEqual({
      file_path: '大叔墙的笔记/学习笔记/摄影学习笔记/原来这才是ps涂抹工具的最强用法-原来这才是ps涂抹工具的最强用法ps教程-琎哥哥探设计／452/transcribe/原来这才是ps涂抹工具的最强用法-原来这才是ps涂抹工具的最强用法ps教程-琎哥哥探设计／452.txt',
    });
    expect(stripDeepSeekDSMLToolCallBlocks(readCall)).toBe('转写完成，读取转写稿。');
  });

  it('parses fullwidth DSML bars emitted as visible text', () => {
    const fullwidth = `好的，先更新长期记忆。<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="Edit"><｜｜DSML｜｜parameter name="file_path" string="true">墙的AI记忆/长期记忆-大叔墙.md</｜｜DSML｜｜parameter><｜｜DSML｜｜parameter name="old_string" string="true">## 交流注意事项</｜｜DSML｜｜parameter><｜｜DSML｜｜parameter name="new_string" string="true">### 2026年5月第3周\n## 交流注意事项</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>`;

    const calls = parseDeepSeekDSMLToolCalls(fullwidth);

    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('Edit');
    expect(JSON.parse(calls[0].function.arguments)).toEqual({
      file_path: '墙的AI记忆/长期记忆-大叔墙.md',
      old_string: '## 交流注意事项',
      new_string: '### 2026年5月第3周\n## 交流注意事项',
    });
    expect(stripDeepSeekDSMLToolCallBlocks(fullwidth)).toBe('好的，先更新长期记忆。');
  });
});

describe('DeepSeekRuntime execution continuation guard', () => {
  it('forces continuation when an explicit update request ends with a plan only', () => {
    const responseText = '好，信息已经全部到位。给你一份完整的现状分析和更新计划。---##当前知识库状态\n按这个计划推进？还是你先挑重点？';

    expect(shouldForceDeepSeekExecutionContinuation({
      originalPrompt: '更新知识库，继续执行',
      responseText,
      hasCompletedWriteEdit: false,
      forcedContinuationCount: 0,
    })).toBe(true);
  });

  it('forces continuation when an explicit update request asks for confirmation again', () => {
    expect(shouldForceDeepSeekExecutionContinuation({
      originalPrompt: '继续更新知识库',
      responseText: '我已经整理出更新方案，你确认后我再继续写入。',
      hasCompletedWriteEdit: false,
      forcedContinuationCount: 0,
    })).toBe(true);
  });

  it('does not force continuation after a write or edit tool has completed', () => {
    expect(shouldForceDeepSeekExecutionContinuation({
      originalPrompt: '更新知识库',
      responseText: '按这个计划推进？',
      hasCompletedWriteEdit: true,
      forcedContinuationCount: 0,
    })).toBe(false);
  });

  it('forces continuation after a cosmetic edit when the model still asks to continue the main update', () => {
    expect(shouldForceDeepSeekExecutionContinuation({
      originalPrompt: '更新全局知识地图',
      responseText: '已完成最后修改日期更新。需要你确认两点再继续改。',
      hasCompletedWriteEdit: true,
      forcedContinuationCount: 0,
    })).toBe(true);
  });

  it('does not force continuation more than once for the same user turn', () => {
    expect(shouldForceDeepSeekExecutionContinuation({
      originalPrompt: '继续',
      responseText: '现在开始更新。',
      hasCompletedWriteEdit: false,
      forcedContinuationCount: 2,
    })).toBe(false);
  });

  it('allows a second forced continuation when the model still ends with a status sentence', () => {
    expect(shouldForceDeepSeekExecutionContinuation({
      originalPrompt: '更新全局知识地图',
      responseText: '分析完了，现在要读关键新文件，确保更新准确。',
      hasCompletedWriteEdit: false,
      forcedContinuationCount: 1,
    })).toBe(true);
  });

  it('does not force continuation for non-action questions', () => {
    expect(shouldForceDeepSeekExecutionContinuation({
      originalPrompt: '这个回复是正确的吗',
      responseText: '这个回复不完整，需要继续验证。',
      hasCompletedWriteEdit: false,
      forcedContinuationCount: 0,
    })).toBe(false);
  });

  it('forces write tools after many read-only rounds for explicit update requests', () => {
    expect(shouldForceDeepSeekWriteAfterToolRounds({
      originalPrompt: '更新全局知识地图',
      hasCompletedWriteEdit: false,
      forcedWriteAttemptCount: 0,
      round: 6,
      duplicateCount: 0,
      consecutiveNoProgress: 0,
    })).toBe(true);
  });

  it('does not force write tools for non-action questions', () => {
    expect(shouldForceDeepSeekWriteAfterToolRounds({
      originalPrompt: '这个对话是否正确',
      hasCompletedWriteEdit: false,
      forcedWriteAttemptCount: 0,
      round: 6,
      duplicateCount: 0,
      consecutiveNoProgress: 0,
    })).toBe(false);
  });

  it('does not force write tools after a write or edit succeeded', () => {
    expect(shouldForceDeepSeekWriteAfterToolRounds({
      originalPrompt: '更新全局知识地图',
      hasCompletedWriteEdit: true,
      forcedWriteAttemptCount: 0,
      round: 6,
      duplicateCount: 0,
      consecutiveNoProgress: 0,
    })).toBe(false);
  });
});
