import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Editor } from '@earendil-works/pi-tui';

type EditorState = {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
};

type EditorWithInternals = Editor & {
  state: EditorState;
  pastes: Map<number, string>;
  scrollOffset: number;
  onChange?: (text: string) => void;
  normalizeText?: (text: string) => string;
  setCursorCol?: (col: number) => void;
};

const PATCH_VERSION = Symbol.for('pi.repeatPasteExpand.patchVersion');
const ORIGINAL_HANDLE_PASTE = Symbol.for('pi.repeatPasteExpand.originalHandlePaste');
const ORIGINAL_SET_TEXT = Symbol.for('pi.repeatPasteExpand.originalSetText');
const GLOBAL_STATE = Symbol.for('pi.repeatPasteExpand.globalState');
const LARGE_PASTE_LINE_THRESHOLD = 10;
const LARGE_PASTE_CHAR_THRESHOLD = 1000;

type GlobalState = {
  lastLargePasteByEditor: WeakMap<Editor, string>;
};

const globalState = (globalThis as typeof globalThis & { [GLOBAL_STATE]?: GlobalState })[GLOBAL_STATE] ??= {
  lastLargePasteByEditor: new WeakMap<Editor, string>(),
};

function normalizePaste(editor: EditorWithInternals, pastedText: string): string {
  const decodedText = pastedText.replace(/\x1b\[(\d+);5u/g, (match, code: string) => {
    const codePoint = Number(code);
    if (codePoint >= 97 && codePoint <= 122) return String.fromCharCode(codePoint - 96);
    if (codePoint >= 65 && codePoint <= 90) return String.fromCharCode(codePoint - 64);
    return match;
  });

  const cleanText = editor.normalizeText
    ? editor.normalizeText(decodedText)
    : decodedText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\t/g, '    ');

  return cleanText
    .split('')
    .filter((char) => char === '\n' || char.charCodeAt(0) >= 32)
    .join('');
}

function getAbsoluteCursorIndex(editor: EditorWithInternals): number {
  let index = 0;
  for (let line = 0; line < editor.state.cursorLine; line++) {
    index += (editor.state.lines[line] || '').length + 1;
  }
  return index + editor.state.cursorCol;
}

function setTextAndCursor(editor: EditorWithInternals, text: string, cursorIndex: number): void {
  const lines = text.split('\n');
  editor.state.lines = lines.length === 0 ? [''] : lines;

  let remaining = Math.max(0, Math.min(cursorIndex, text.length));
  for (let line = 0; line < editor.state.lines.length; line++) {
    const lineLength = (editor.state.lines[line] || '').length;
    if (remaining <= lineLength) {
      editor.state.cursorLine = line;
      if (editor.setCursorCol) editor.setCursorCol(remaining);
      else editor.state.cursorCol = remaining;
      editor.scrollOffset = 0;
      editor.onChange?.(editor.getText());
      return;
    }
    remaining -= lineLength + 1;
  }

  editor.state.cursorLine = editor.state.lines.length - 1;
  const lastLineLength = (editor.state.lines[editor.state.cursorLine] || '').length;
  if (editor.setCursorCol) editor.setCursorCol(lastLineLength);
  else editor.state.cursorCol = lastLineLength;
  editor.scrollOffset = 0;
  editor.onChange?.(editor.getText());
}

function findStoredPasteIds(editor: EditorWithInternals, pasteContent: string): number[] {
  const pasteIds: number[] = [];
  for (const [pasteId, storedContent] of editor.pastes) {
    if (storedContent === pasteContent) pasteIds.push(pasteId);
  }
  return pasteIds;
}

function expandPasteMarker(editor: EditorWithInternals, pasteId: number, pasteContent: string): boolean {
  const fullText = editor.getLines().join('\n');
  const cursorIndex = getAbsoluteCursorIndex(editor);
  const markerRegex = new RegExp(`\\[paste #${pasteId}( (\\+\\d+ lines|\\d+ chars))?\\]`, 'g');
  const matches = [...fullText.matchAll(markerRegex)];
  if (matches.length === 0) return false;

  const matchBeforeCursor = matches
    .filter((match) => match.index !== undefined && match.index + match[0].length <= cursorIndex)
    .at(-1);
  const match = matchBeforeCursor ?? matches[0];
  if (match.index === undefined) return false;

  const beforeMarker = fullText.slice(0, match.index);
  const afterMarker = fullText.slice(match.index + match[0].length);
  setTextAndCursor(editor, beforeMarker + pasteContent + afterMarker, beforeMarker.length + pasteContent.length);
  return true;
}

export default function (_pi: ExtensionAPI) {
  const prototype = Editor.prototype as typeof Editor.prototype & {
    [PATCH_VERSION]?: number;
    [ORIGINAL_HANDLE_PASTE]?: (this: Editor, pastedText: string) => void;
    [ORIGINAL_SET_TEXT]?: (this: Editor, text: string) => void;
    handlePaste: (pastedText: string) => void;
    setText: (text: string) => void;
  };

  // Keep the first method we see as the delegate. This makes /reload work even
  // after an older version of this extension already monkey-patched handlePaste:
  // the new wrapper is installed on every load, while the previous behavior is
  // still available as the fallback path.
  prototype[ORIGINAL_HANDLE_PASTE] ??= prototype.handlePaste;
  prototype[ORIGINAL_SET_TEXT] ??= prototype.setText;
  prototype[PATCH_VERSION] = 3;

  const originalHandlePaste = prototype[ORIGINAL_HANDLE_PASTE];
  const originalSetText = prototype[ORIGINAL_SET_TEXT];

  prototype.setText = function patchedSetText(this: Editor, text: string): void {
    if (text === '') {
      // Ctrl+C clears the editor through setText(''). Treat that as a fresh
      // start, matching Claude Code: after clearing, the next large paste is
      // collapsed again, and a second paste expands it.
      globalState.lastLargePasteByEditor.delete(this);
    }
    originalSetText.call(this, text);
  };

  prototype.handlePaste = function patchedHandlePaste(this: Editor, pastedText: string): void {
    const editor = this as EditorWithInternals;
    const filteredText = normalizePaste(editor, pastedText);
    const lineCount = filteredText.split('\n').length;

    if (lineCount > LARGE_PASTE_LINE_THRESHOLD || filteredText.length > LARGE_PASTE_CHAR_THRESHOLD) {
      for (const existingPasteId of findStoredPasteIds(editor, filteredText)) {
        if (expandPasteMarker(editor, existingPasteId, filteredText)) {
          globalState.lastLargePasteByEditor.set(this, filteredText);
          return;
        }
      }

      if (globalState.lastLargePasteByEditor.get(this) === filteredText) {
        editor.insertTextAtCursor(filteredText);
        return;
      }

      globalState.lastLargePasteByEditor.set(this, filteredText);
    }

    originalHandlePaste.call(this, pastedText);
  };

}
