import { setIcon } from 'obsidian';

import type { ContentBlock } from '../../../core/types';
import { renderTodoItems } from './todoUtils';

type PlanBlock = Extract<ContentBlock, { type: 'plan' }>;
type CommandBlock = Extract<ContentBlock, { type: 'command' }>;

function ensureBlockContainer(parentEl: HTMLElement, key: string): HTMLElement {
  const existing = parentEl.querySelector(`[data-process-block-id="${key}"]`) as HTMLElement | null;
  if (existing) return existing;

  const blockEl = parentEl.createDiv({ cls: 'codian-process-block' });
  blockEl.dataset.processBlockId = key;
  return blockEl;
}

function renderPlanHeader(container: HTMLElement, block: PlanBlock): void {
  const completed = block.steps.filter(step => step.status === 'completed').length;
  const active = block.steps.find(step => step.status === 'in_progress');

  const header = container.createDiv({ cls: 'codian-process-header' });
  const iconEl = header.createSpan({ cls: 'codian-process-icon' });
  setIcon(iconEl, 'list-checks');

  header.createSpan({
    cls: 'codian-process-title',
    text: `Tasks ${completed}/${block.steps.length}`,
  });

  if (active) {
    header.createSpan({
      cls: 'codian-process-summary',
      text: active.step,
    });
  } else if (block.explanation) {
    header.createSpan({
      cls: 'codian-process-summary',
      text: block.explanation,
    });
  }

  const statusEl = header.createSpan({ cls: 'codian-process-status' });
  if (completed === block.steps.length && block.steps.length > 0) {
    statusEl.addClass('status-completed');
    setIcon(statusEl, 'check');
  } else {
    statusEl.addClass('status-running');
  }
}

function renderPlanContent(container: HTMLElement, block: PlanBlock): void {
  const content = container.createDiv({
    cls: 'codian-process-content codian-process-content-plan codian-todo-list-container',
  });
  const todos = block.steps.map(step => ({
    content: step.step,
    status: step.status,
    activeForm: block.explanation ?? step.step,
  }));
  renderTodoItems(content, todos);
}

function getCommandSummary(block: CommandBlock): string {
  return block.cwd ? `${block.command} (${block.cwd})` : block.command;
}

function renderCommandHeader(container: HTMLElement, block: CommandBlock): void {
  const header = container.createDiv({ cls: 'codian-process-header' });
  const iconEl = header.createSpan({ cls: 'codian-process-icon' });
  setIcon(iconEl, 'terminal');

  header.createSpan({
    cls: 'codian-process-title',
    text: 'Bash',
  });

  header.createSpan({
    cls: 'codian-process-summary',
    text: getCommandSummary(block),
  });

  const statusEl = header.createSpan({ cls: 'codian-process-status' });
  statusEl.addClass(`status-${block.status}`);
  if (block.status === 'completed') {
    setIcon(statusEl, 'check');
  } else if (block.status === 'error') {
    setIcon(statusEl, 'x');
  }
}

function renderCommandContent(container: HTMLElement, block: CommandBlock): void {
  const content = container.createDiv({ cls: 'codian-process-content codian-process-content-command' });
  if (!block.output) return;

  const linesEl = content.createDiv({ cls: 'codian-tool-lines' });
  const lineEl = linesEl.createDiv({ cls: 'codian-tool-line' });
  lineEl.style.whiteSpace = 'pre-wrap';
  lineEl.style.wordBreak = 'break-word';
  lineEl.setText(block.output);

  if (block.exitCode !== undefined) {
    linesEl.createDiv({
      cls: 'codian-tool-truncated',
      text: `exit code: ${block.exitCode}`,
    });
  }
}

export function renderOrUpdatePlanBlock(parentEl: HTMLElement, block: PlanBlock): HTMLElement {
  const container = ensureBlockContainer(parentEl, block.blockId);
  container.empty();
  container.addClass('codian-process-block-plan');
  renderPlanHeader(container, block);
  renderPlanContent(container, block);
  return container;
}

export function renderStoredPlanBlock(parentEl: HTMLElement, block: PlanBlock): HTMLElement {
  return renderOrUpdatePlanBlock(parentEl, block);
}

export function renderOrUpdateCommandBlock(parentEl: HTMLElement, block: CommandBlock): HTMLElement {
  const container = ensureBlockContainer(parentEl, block.blockId);
  container.empty();
  container.addClass('codian-process-block-command');
  renderCommandHeader(container, block);
  renderCommandContent(container, block);
  return container;
}

export function renderStoredCommandBlock(parentEl: HTMLElement, block: CommandBlock): HTMLElement {
  return renderOrUpdateCommandBlock(parentEl, block);
}
