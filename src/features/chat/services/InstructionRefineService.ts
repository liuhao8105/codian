import { buildRefineSystemPrompt } from '../../../core/prompts/instructionRefine';
import { execCodexPrompt } from '../../../core/runtime/codexExec';
import { type InstructionRefineResult } from '../../../core/types';
import type CodianPlugin from '../../../main';
import { getVaultPath } from '../../../utils/path';

export type RefineProgressCallback = (update: InstructionRefineResult) => void;

export class InstructionRefineService {
  private plugin: CodianPlugin;
  private abortController: AbortController | null = null;
  private existingInstructions = '';
  private conversationHistory: string[] = [];

  constructor(plugin: CodianPlugin) {
    this.plugin = plugin;
  }

  resetConversation(): void {
    this.conversationHistory = [];
  }

  async refineInstruction(
    rawInstruction: string,
    existingInstructions: string,
    onProgress?: RefineProgressCallback
  ): Promise<InstructionRefineResult> {
    this.existingInstructions = existingInstructions;
    this.conversationHistory = [];
    const prompt = `Please refine this instruction: "${rawInstruction}"`;
    return this.sendMessage(prompt, onProgress);
  }

  async continueConversation(
    message: string,
    onProgress?: RefineProgressCallback
  ): Promise<InstructionRefineResult> {
    if (this.conversationHistory.length === 0) {
      return { success: false, error: 'No active conversation to continue' };
    }
    return this.sendMessage(message, onProgress);
  }

  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  private async sendMessage(
    prompt: string,
    onProgress?: RefineProgressCallback
  ): Promise<InstructionRefineResult> {
    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) {
      return { success: false, error: 'Could not determine vault path' };
    }

    this.abortController = new AbortController();
    const historyPrefix = this.conversationHistory.length > 0
      ? `Previous conversation:\n${this.conversationHistory.join('\n\n')}\n\n`
      : '';
    const fullPrompt = `${buildRefineSystemPrompt(this.existingInstructions)}

${historyPrefix}User: ${prompt}`;

    try {
      const response = await execCodexPrompt(this.plugin, {
        prompt: fullPrompt,
        cwd: vaultPath,
        model: this.plugin.settings.model,
        permissionMode: 'normal',
        abortController: this.abortController,
      });

      const result = this.parseResponse(response.text);
      if (onProgress) {
        onProgress(result);
      }

      if (result.success) {
        this.conversationHistory.push(`User: ${prompt}`);
        this.conversationHistory.push(`Assistant: ${response.text.trim()}`);
      }

      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: msg };
    } finally {
      this.abortController = null;
    }
  }

  private parseResponse(responseText: string): InstructionRefineResult {
    const instructionMatch = responseText.match(/<instruction>([\s\S]*?)<\/instruction>/);
    if (instructionMatch) {
      return { success: true, refinedInstruction: instructionMatch[1].trim() };
    }

    const trimmed = responseText.trim();
    if (trimmed) {
      return { success: true, clarification: trimmed };
    }

    return { success: false, error: 'Empty response' };
  }
}
