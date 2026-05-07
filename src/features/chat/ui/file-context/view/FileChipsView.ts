import { setIcon } from 'obsidian';

export interface FileChipsViewCallbacks {
  onRemoveAttachment: (path: string) => void;
  onOpenFile: (path: string) => void;
}

export class FileChipsView {
  private containerEl: HTMLElement;
  private callbacks: FileChipsViewCallbacks;
  private fileIndicatorEl: HTMLElement;

  constructor(containerEl: HTMLElement, callbacks: FileChipsViewCallbacks) {
    this.containerEl = containerEl;
    this.callbacks = callbacks;

    const firstChild = this.containerEl.firstChild;
    this.fileIndicatorEl = this.containerEl.createDiv({ cls: 'codian-file-indicator' });
    if (firstChild) {
      this.containerEl.insertBefore(this.fileIndicatorEl, firstChild);
    }
  }

  destroy(): void {
    this.fileIndicatorEl.remove();
  }

  renderFiles(currentNotePath: string | null, attachedFiles: Iterable<string>): void {
    this.fileIndicatorEl.empty();

    const files = Array.from(new Set([
      ...(currentNotePath ? [currentNotePath] : []),
      ...attachedFiles,
    ]));

    if (files.length === 0) {
      this.fileIndicatorEl.style.display = 'none';
      return;
    }

    this.fileIndicatorEl.style.display = 'flex';
    for (const filePath of files) {
      this.renderFileChip(
        filePath,
        filePath === currentNotePath,
        () => this.callbacks.onRemoveAttachment(filePath)
      );
    }
  }

  private renderFileChip(filePath: string, isCurrentNote: boolean, onRemove: () => void): void {
    const chipEl = this.fileIndicatorEl.createDiv({
      cls: `codian-file-chip${isCurrentNote ? ' is-current-note' : ''}`,
    });

    const iconEl = chipEl.createSpan({ cls: 'codian-file-chip-icon' });
    setIcon(iconEl, isCurrentNote ? 'book-open' : 'file-text');

    const normalizedPath = filePath.replace(/\\/g, '/');
    const filename = normalizedPath.split('/').pop() || filePath;
    const nameEl = chipEl.createSpan({ cls: 'codian-file-chip-name' });
    nameEl.setText(filename);
    nameEl.setAttribute('title', filePath);

    const removeEl = chipEl.createSpan({ cls: 'codian-file-chip-remove' });
    removeEl.setText('\u00D7');
    removeEl.setAttribute('aria-label', 'Remove');

    chipEl.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('.codian-file-chip-remove')) {
        this.callbacks.onOpenFile(filePath);
      }
    });

    removeEl.addEventListener('click', () => {
      onRemove();
    });
  }
}
