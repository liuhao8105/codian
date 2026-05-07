/**
 * Codian - Image Embed Utilities
 *
 * Replaces Obsidian image embeds ![[image.png]] with HTML <img> tags
 * before MarkdownRenderer processes the content.
 *
 * Note: This is display-only - the agent still receives the wikilink text.
 */

import { promises as fs } from 'fs';
import type { App, TFile } from 'obsidian';

import type { ImageAttachment, ImageMediaType } from '../core/types';
import { escapeHtml } from './inlineEdit';
import { getVaultPath } from './path';

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'bmp',
  'ico',
]);

const IMAGE_EMBED_PATTERN = /!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

const ATTACHABLE_IMAGE_EXTENSIONS: Record<string, ImageMediaType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

function isImagePath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase();
  return ext ? IMAGE_EXTENSIONS.has(ext) : false;
}

export function resolveImageFile(
  app: App,
  imagePath: string,
  mediaFolder: string
): TFile | null {
  let file = app.vault.getFileByPath(imagePath);
  if (file) return file;

  if (mediaFolder) {
    const withFolder = `${mediaFolder}/${imagePath}`;
    file = app.vault.getFileByPath(withFolder);
    if (file) return file;
  }

  const resolved = app.metadataCache.getFirstLinkpathDest(imagePath, '');
  if (resolved) return resolved;

  return null;
}

export interface EmbeddedImageReference {
  index: number;
  embedPath: string;
  filePath: string;
  fileName: string;
}

function getAttachableImageMediaType(file: TFile): ImageMediaType | null {
  const ext = file.extension.toLowerCase();
  return ATTACHABLE_IMAGE_EXTENSIONS[ext] || null;
}

function createAttachmentId(filePath: string): string {
  return `note-image-${filePath}`;
}

/**
 * Extracts image attachments referenced by Obsidian embeds in markdown.
 * Only supported runtime image types are returned.
 */
export async function extractEmbeddedImageAttachments(
  app: App,
  markdown: string,
  mediaFolder = ''
): Promise<ImageAttachment[]> {
  if (!app?.vault || !app?.metadataCache || !markdown.trim()) {
    return [];
  }

  const vaultPath = getVaultPath(app);
  if (!vaultPath) {
    return [];
  }

  IMAGE_EMBED_PATTERN.lastIndex = 0;
  const seenPaths = new Set<string>();
  const attachments: ImageAttachment[] = [];

  for (const match of markdown.matchAll(IMAGE_EMBED_PATTERN)) {
    const imagePath = match[1];
    if (!isImagePath(imagePath)) {
      continue;
    }

    const file = resolveImageFile(app, imagePath, mediaFolder);
    if (!file || seenPaths.has(file.path)) {
      continue;
    }

    const mediaType = getAttachableImageMediaType(file);
    if (!mediaType) {
      continue;
    }

    try {
      const absolutePath = `${vaultPath}/${file.path}`;
      const buffer = await fs.readFile(absolutePath);
      attachments.push({
        id: createAttachmentId(file.path),
        name: file.name,
        mediaType,
        data: buffer.toString('base64'),
        size: buffer.byteLength,
        source: 'file',
      });
      seenPaths.add(file.path);
    } catch {
      // Ignore unreadable files and continue with remaining embeds.
    }
  }

  return attachments;
}

export function extractEmbeddedImageReferences(
  app: App,
  markdown: string,
  mediaFolder = ''
): EmbeddedImageReference[] {
  if (!app?.vault || !app?.metadataCache || !markdown.trim()) {
    return [];
  }

  IMAGE_EMBED_PATTERN.lastIndex = 0;
  const seenPaths = new Set<string>();
  const references: EmbeddedImageReference[] = [];
  let index = 0;

  for (const match of markdown.matchAll(IMAGE_EMBED_PATTERN)) {
    const imagePath = match[1];
    if (!isImagePath(imagePath)) {
      continue;
    }

    const file = resolveImageFile(app, imagePath, mediaFolder);
    if (!file || seenPaths.has(file.path)) {
      continue;
    }

    const mediaType = getAttachableImageMediaType(file);
    if (!mediaType) {
      continue;
    }

    index += 1;
    references.push({
      index,
      embedPath: imagePath,
      filePath: file.path,
      fileName: file.name,
    });
    seenPaths.add(file.path);
  }

  return references;
}


/** Supports formats: "100" (width only) or "100x200" (width x height) */
function buildStyleAttribute(altText: string | undefined): string {
  if (!altText) return '';

  const dimMatch = altText.match(/^(\d+)(?:x(\d+))?$/);
  if (!dimMatch) return '';

  const width = dimMatch[1];
  const height = dimMatch[2];

  if (height) {
    return ` style="width: ${width}px; height: ${height}px;"`;
  }
  return ` style="width: ${width}px;"`;
}

function createImageHtml(
  app: App,
  file: TFile,
  altText: string | undefined
): string {
  const src = app.vault.getResourcePath(file);
  const alt = escapeHtml(altText || file.basename);
  const style = buildStyleAttribute(altText);

  return `<span class="codian-embedded-image"><img src="${escapeHtml(src)}" alt="${alt}" loading="lazy"${style}></span>`;
}

function createFallbackHtml(wikilink: string): string {
  return `<span class="codian-embedded-image-fallback">${escapeHtml(wikilink)}</span>`;
}

/**
 * Call before MarkdownRenderer.renderMarkdown().
 * Non-image embeds (e.g., ![[note.md]]) pass through unchanged.
 */
export function replaceImageEmbedsWithHtml(
  markdown: string,
  app: App,
  mediaFolder: string = ''
): string {
  if (!app?.vault || !app?.metadataCache) {
    return markdown;
  }

  // Reset lastIndex to avoid issues with global regex
  IMAGE_EMBED_PATTERN.lastIndex = 0;

  return markdown.replace(
    IMAGE_EMBED_PATTERN,
    (match, imagePath: string, altText: string | undefined) => {
      try {
        if (!isImagePath(imagePath)) {
          return match;
        }

        const file = resolveImageFile(app, imagePath, mediaFolder);
        if (!file) {
          return createFallbackHtml(match);
        }

        return createImageHtml(app, file, altText);
      } catch {
        return createFallbackHtml(match);
      }
    }
  );
}
