import { CustomEditor, type ExtensionAPI, type KeybindingsManager } from '@earendil-works/pi-coding-agent';
import type { EditorTheme, TUI } from '@earendil-works/pi-tui';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const IMAGE_PATH_PATTERN = /(?:^|\s)(?<path>(?:~|\.|\/)[^\s'"`<>]+\.(?:png|jpe?g|gif|webp))(?=$|\s)/gi;
const IMAGE_PLACEHOLDER_PATTERN = /\[Image #(\d+)\]/g;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

type ImageContent = {
  type: 'image';
  data: string;
  mimeType: string;
};

type ImageRecord = {
  id: number;
  path: string;
  placeholder: string;
};

class ImageTracker {
  private nextId = 1;
  private byId = new Map<number, ImageRecord>();
  private byPath = new Map<string, ImageRecord>();

  getOrCreate(path: string): ImageRecord {
    const normalized = normalizePath(path);
    const existing = this.byPath.get(normalized);
    if (existing) return existing;

    const id = this.nextId++;
    const record = {
      id,
      path: normalized,
      placeholder: `[Image #${id}]`,
    };
    this.byId.set(id, record);
    this.byPath.set(normalized, record);
    return record;
  }

  getById(id: number): ImageRecord | undefined {
    return this.byId.get(id);
  }

  clear(): void {
    this.nextId = 1;
    this.byId.clear();
    this.byPath.clear();
  }
}

class ImagePlaceholderEditor extends CustomEditor {
  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, private readonly tracker: ImageTracker) {
    super(tui, theme, keybindings);
  }

  insertTextAtCursor(text: string): void {
    const imagePath = imagePathFromPaste(text);
    if (!imagePath) {
      super.insertTextAtCursor(text);
      return;
    }

    const record = this.tracker.getOrCreate(imagePath);
    super.insertTextAtCursor(record.placeholder);
  }
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.startsWith('~/')) {
    return resolve(process.env.HOME ?? process.cwd(), trimmed.slice(2));
  }
  return resolve(trimmed);
}

function imagePathFromPaste(text: string): string | undefined {
  const trimmed = text.trim();
  if (!isImagePath(trimmed)) return undefined;
  if (!isReadableFile(trimmed)) return undefined;
  return trimmed;
}

function isImagePath(path: string): boolean {
  return /\.(?:png|jpe?g|gif|webp)$/i.test(path);
}

function isReadableFile(path: string): boolean {
  try {
    const normalized = normalizePath(path);
    if (!existsSync(normalized)) return false;
    const stats = statSync(normalized);
    return stats.isFile() && stats.size > 0 && stats.size <= MAX_IMAGE_BYTES;
  } catch {
    return false;
  }
}

function detectMimeType(bytes: Buffer, path: string): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6) {
    const header = bytes.subarray(0, 6).toString('ascii');
    if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif';
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (/\.png$/i.test(path)) return 'image/png';
  if (/\.jpe?g$/i.test(path)) return 'image/jpeg';
  if (/\.gif$/i.test(path)) return 'image/gif';
  if (/\.webp$/i.test(path)) return 'image/webp';
  return undefined;
}

function readImage(record: ImageRecord): ImageContent | undefined {
  try {
    const bytes = readFileSync(record.path);
    const mimeType = detectMimeType(bytes, record.path);
    if (!mimeType) return undefined;
    return {
      type: 'image',
      data: bytes.toString('base64'),
      mimeType,
    };
  } catch {
    return undefined;
  }
}

function collectPlaceholderImages(text: string, tracker: ImageTracker): ImageContent[] {
  const images: ImageContent[] = [];
  const seen = new Set<number>();

  for (const match of text.matchAll(IMAGE_PLACEHOLDER_PATTERN)) {
    const id = Number(match[1]);
    if (!Number.isInteger(id) || seen.has(id)) continue;
    seen.add(id);
    const record = tracker.getById(id);
    if (!record) continue;
    const image = readImage(record);
    if (image) images.push(image);
  }

  return images;
}

function replaceRawImagePaths(text: string, tracker: ImageTracker): { text: string; images: ImageContent[]; changed: boolean } {
  const images: ImageContent[] = [];
  const seen = new Set<string>();
  let changed = false;

  const transformed = text.replace(IMAGE_PATH_PATTERN, (match: string, path: string | undefined, offset: number) => {
    const candidate = path ?? match.trim();
    if (!isReadableFile(candidate)) return match;

    const record = tracker.getOrCreate(candidate);
    if (!seen.has(record.path)) {
      seen.add(record.path);
      const image = readImage(record);
      if (image) images.push(image);
    }

    changed = true;
    const leadingWhitespace = /^\s/.test(match) && offset !== 0 ? match[0] : '';
    return `${leadingWhitespace}${record.placeholder}`;
  });

  return { text: transformed, images, changed };
}

export default function imagePlaceholdersExtension(pi: ExtensionAPI) {
  const tracker = new ImageTracker();

  pi.on('session_start', (_event, ctx) => {
    tracker.clear();
    if (ctx.mode !== 'tui') return;

    ctx.ui.setEditorComponent((tui, theme, keybindings) => new ImagePlaceholderEditor(tui, theme, keybindings, tracker));
  });

  pi.on('input', async (event) => {
    const placeholderImages = collectPlaceholderImages(event.text, tracker);
    const rawPathResult = replaceRawImagePaths(event.text, tracker);
    const images = [...(event.images ?? []), ...placeholderImages, ...rawPathResult.images];

    if (!rawPathResult.changed && images.length === (event.images?.length ?? 0)) {
      return { action: 'continue' as const };
    }

    return {
      action: 'transform' as const,
      text: rawPathResult.text,
      images: images.length > 0 ? images : event.images,
    };
  });
}
