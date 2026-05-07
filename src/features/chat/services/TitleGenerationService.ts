import { TITLE_GENERATION_SYSTEM_PROMPT } from '../../../core/prompts/titleGeneration';
import { execCodexPrompt } from '../../../core/runtime/codexExec';
import type CodianPlugin from '../../../main';
import { parseEnvironmentVariables } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';

export type TitleGenerationResult =
  | { success: true; title: string }
  | { success: false; error: string };

export type TitleGenerationCallback = (
  conversationId: string,
  result: TitleGenerationResult
) => Promise<void>;

export class TitleGenerationService {
  private plugin: CodianPlugin;
  private activeGenerations: Map<string, AbortController> = new Map();

  constructor(plugin: CodianPlugin) {
    this.plugin = plugin;
  }

  async generateTitle(
    conversationId: string,
    userMessage: string,
    callback: TitleGenerationCallback
  ): Promise<void> {
    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) {
      await this.safeCallback(callback, conversationId, {
        success: false,
        error: 'Could not determine vault path',
      });
      return;
    }

    const envVars = parseEnvironmentVariables(this.plugin.getActiveEnvironmentVariables());
    const titleModel =
      this.plugin.settings.titleGenerationModel ||
      envVars.OPENAI_MODEL ||
      envVars.CODEX_MODEL ||
      'gpt-5.5';

    const existingController = this.activeGenerations.get(conversationId);
    if (existingController) {
      existingController.abort();
    }

    const abortController = new AbortController();
    this.activeGenerations.set(conversationId, abortController);

    const truncatedUser = this.truncateText(userMessage, 500);
    const prompt = `${TITLE_GENERATION_SYSTEM_PROMPT}

User's request:
"""
${truncatedUser}
"""

Generate a title for this conversation:`;

    try {
      const response = await execCodexPrompt(this.plugin, {
        prompt,
        cwd: vaultPath,
        model: titleModel,
        permissionMode: 'normal',
        abortController,
      });

      const title = this.parseTitle(response.text);
      if (title) {
        await this.safeCallback(callback, conversationId, { success: true, title });
      } else {
        await this.safeCallback(callback, conversationId, {
          success: false,
          error: 'Failed to parse title from response',
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      await this.safeCallback(callback, conversationId, { success: false, error: msg });
    } finally {
      this.activeGenerations.delete(conversationId);
    }
  }

  cancel(): void {
    for (const controller of this.activeGenerations.values()) {
      controller.abort();
    }
    this.activeGenerations.clear();
  }

  private truncateText(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    return text.substring(0, maxLength) + '...';
  }

  private parseTitle(responseText: string): string | null {
    const trimmed = responseText.trim();
    if (!trimmed) return null;

    let title = trimmed;
    if (
      (title.startsWith('"') && title.endsWith('"')) ||
      (title.startsWith("'") && title.endsWith("'"))
    ) {
      title = title.slice(1, -1);
    }

    title = title.replace(/[.!?:;,]+$/, '');

    if (title.length > 50) {
      title = title.substring(0, 47) + '...';
    }

    return title || null;
  }

  private async safeCallback(
    callback: TitleGenerationCallback,
    conversationId: string,
    result: TitleGenerationResult
  ): Promise<void> {
    try {
      await callback(conversationId, result);
    } catch {
      // Ignore callback errors
    }
  }
}
