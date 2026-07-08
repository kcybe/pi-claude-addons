import { CustomEditor, type ExtensionAPI, type KeybindingsManager } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, type EditorTheme, type TUI } from '@earendil-works/pi-tui';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const IMAGE_PLACEHOLDER_PATTERN = /\[Image #(\d+)\]/g;
const BRACKETED_PASTE_PATTERN = /^\x1b\[200~([\s\S]*)\x1b\[201~$/;
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

type ImagePathMatch = {
  start: number;
  end: number;
  path: string;
};

type MutableEditorInternals = {
  state: {
    lines: string[];
    cursorLine: number;
    cursorCol: number;
  };
  cancelAutocomplete?: () => void;
  pushUndoSnapshot?: () => void;
  exitHistoryBrowsing?: () => void;
  setCursorCol?: (col: number) => void;
  lastAction?: unknown;
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

  handleInput(data: string): void {
    const imagePath = imagePathFromPaste(data);
    if (imagePath) {
      this.insertPlaceholder(imagePath);
      return;
    }

    if (matchesKey(data, Key.backspace) && this.deletePlaceholderBackward()) return;
    if (matchesKey(data, Key.delete) && this.deletePlaceholderForward()) return;

    if (matchesKey(data, Key.left) && this.snapCursorOutOfPlaceholder('start')) return;
    if (matchesKey(data, Key.right) && this.snapCursorOutOfPlaceholder('end')) return;
    if (isLikelyPrintableInput(data)) this.snapCursorOutOfPlaceholder('end');

    super.handleInput(data);

    if (matchesKey(data, Key.left)) this.snapCursorOutOfPlaceholder('start');
    else if (matchesKey(data, Key.right)) this.snapCursorOutOfPlaceholder('end');
    else this.snapCursorOutOfPlaceholder('nearest');

    this.replaceVisibleImagePaths();
  }

  handlePaste(pastedText: string): void {
    const imagePath = imagePathFromPaste(pastedText);
    if (imagePath) {
      this.insertPlaceholder(imagePath);
      return;
    }

    super.handlePaste(pastedText);
    this.replaceVisibleImagePaths();
  }

  insertTextAtCursor(text: string): void {
    const imagePath = imagePathFromPaste(text);
    if (!imagePath) {
      super.insertTextAtCursor(text);
      this.replaceVisibleImagePaths();
      return;
    }

    this.insertPlaceholder(imagePath);
  }

  private insertPlaceholder(path: string): void {
    const record = this.tracker.getOrCreate(path);
    super.insertTextAtCursor(`${record.placeholder} `);
  }

  private replaceVisibleImagePaths(): void {
    const current = this.getText();
    const result = replaceRawImagePaths(current, this.tracker);
    if (result.changed) this.setText(result.text);
  }

  private deletePlaceholderBackward(): boolean {
    const internals = this as unknown as MutableEditorInternals;
    const line = internals.state.lines[internals.state.cursorLine] ?? '';
    const cursor = internals.state.cursorCol;
    const span = findPlaceholderSpan(line, cursor, 'backward');
    if (!span) return false;

    this.deletePlaceholderSpan(span.start, span.end);
    return true;
  }

  private deletePlaceholderForward(): boolean {
    const internals = this as unknown as MutableEditorInternals;
    const line = internals.state.lines[internals.state.cursorLine] ?? '';
    const cursor = internals.state.cursorCol;
    const span = findPlaceholderSpan(line, cursor, 'forward');
    if (!span) return false;

    this.deletePlaceholderSpan(span.start, span.end);
    return true;
  }

  private deletePlaceholderSpan(start: number, end: number): void {
    const internals = this as unknown as MutableEditorInternals;
    internals.cancelAutocomplete?.();
    internals.pushUndoSnapshot?.();
    internals.exitHistoryBrowsing?.();
    internals.lastAction = null;

    const lineIndex = internals.state.cursorLine;
    const line = internals.state.lines[lineIndex] ?? '';
    internals.state.lines[lineIndex] = line.slice(0, start) + line.slice(end);
    setEditorCursorCol(internals, start);

    this.onChange?.(this.getText());
    this.invalidate();
  }

  private snapCursorOutOfPlaceholder(prefer: 'start' | 'end' | 'nearest'): boolean {
    const internals = this as unknown as MutableEditorInternals;
    const line = internals.state.lines[internals.state.cursorLine] ?? '';
    const cursor = internals.state.cursorCol;
    const span = findPlaceholderSpanContaining(line, cursor);
    if (!span) return false;

    const target =
      prefer === 'start'
        ? span.start
        : prefer === 'end'
          ? span.end
          : cursor - span.start <= span.end - cursor
            ? span.start
            : span.end;
    setEditorCursorCol(internals, target);
    this.invalidate();
    return true;
  }
}

function setEditorCursorCol(internals: MutableEditorInternals, col: number): void {
  if (internals.setCursorCol) internals.setCursorCol(col);
  else internals.state.cursorCol = col;
}

function isLikelyPrintableInput(data: string): boolean {
  return data.length > 0 && !data.startsWith('\x1b') && data !== '\x7f' && !/^[\x00-\x1f]$/.test(data);
}

function findPlaceholderSpan(line: string, cursor: number, direction: 'backward' | 'forward'): { start: number; end: number } | undefined {
  for (const match of line.matchAll(IMAGE_PLACEHOLDER_PATTERN)) {
    const start = match.index;
    const end = start + match[0].length;
    if (direction === 'backward' && start < cursor && cursor <= end) return { start, end };
    if (direction === 'forward' && start <= cursor && cursor < end) return { start, end };
  }
  return undefined;
}
}

function findPlaceholderSpanContaining(line: string, cursor: number): { start: number; end: number } | undefined {
  for (const match of line.matchAll(IMAGE_PLACEHOLDER_PATTERN)) {
    const start = match.index;
    const end = start + match[0].length;
    if (start < cursor && cursor < end) return { start, end };
  }
  return undefined;
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.startsWith('~/')) {
    return resolve(process.env.HOME ?? process.cwd(), trimmed.slice(2));
  }
  return resolve(trimmed);
}

function imagePathFromPaste(text: string): string | undefined {
  const bracketed = text.match(BRACKETED_PASTE_PATTERN);
  const payload = (bracketed?.[1] ?? text).trim();
  const direct = unescapeShellPath(payload);
  if (isImagePath(direct) && isReadableFile(direct)) return direct;

  const matches = findImagePathMatches(payload);
  if (matches.length !== 1) return undefined;
  const match = matches[0];
  if (payload.slice(0, match.start).trim() || payload.slice(match.end).trim()) return undefined;
  return match.path;
}

function isPathStart(text: string, index: number): boolean {
  const previous = index === 0 ? ' ' : text[index - 1] ?? ' ';
  if (!/\s|[([{"']/.test(previous)) return false;

  const current = text[index];
  const next = text[index + 1];
  const afterNext = text[index + 2];

  return current === '/' || (current === '~' && next === '/') || (current === '.' && (next === '/' || (next === '.' && afterNext === '/')));
}

function findImagePathMatches(text: string): ImagePathMatch[] {
  const matches: ImagePathMatch[] = [];

  for (let i = 0; i < text.length; i++) {
    if (!isPathStart(text, i)) continue;

    let path = '';
    let j = i;
    let escaping = false;

    while (j < text.length) {
      const char = text[j] ?? '';

      if (escaping) {
        path += char;
        escaping = false;
        j++;
        continue;
      }

      if (char === '\\') {
        escaping = true;
        j++;
        continue;
      }

      if (/\s|['"`<>]/.test(char)) break;
      path += char;
      j++;
    }

    if (isImagePath(path) && isReadableFile(path)) {
      matches.push({ start: i, end: j, path });
      i = j - 1;
    }
  }

  return matches;
}

function unescapeShellPath(path: string): string {
  return path.replace(/\\(.)/g, '$1');
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
  const matches = findImagePathMatches(text);
  if (matches.length === 0) return { text, images: [], changed: false };

  const images: ImageContent[] = [];
  const seen = new Set<string>();
  let transformed = '';
  let cursor = 0;

  for (const match of matches) {
    const record = tracker.getOrCreate(match.path);
    transformed += text.slice(cursor, match.start);
    transformed += `${record.placeholder} `;
    cursor = match.end;

    if (!seen.has(record.path)) {
      seen.add(record.path);
      const image = readImage(record);
      if (image) images.push(image);
    }
  }

  transformed += text.slice(cursor);
  return { text: transformed, images, changed: true };
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
