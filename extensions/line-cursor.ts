import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Editor, Input } from '@earendil-works/pi-tui';

const GLOBAL_STATE = Symbol.for('pi.claudeAddons.lineCursor.state');
const ORIGINAL_EDITOR_RENDER = Symbol.for('pi.claudeAddons.lineCursor.originalEditorRender');
const ORIGINAL_INPUT_RENDER = Symbol.for('pi.claudeAddons.lineCursor.originalInputRender');
const PATCH_VERSION = Symbol.for('pi.claudeAddons.lineCursor.patchVersion');

const BAR_CURSOR = '\x1b[5 q';
const RESET_CURSOR = '\x1b[0 q';

type CursorStyle = 'line' | 'block';
type GlobalState = {
  style: CursorStyle;
};

const globalState = (globalThis as typeof globalThis & { [GLOBAL_STATE]?: GlobalState })[GLOBAL_STATE] ??= {
  style: 'line',
};

function stripFakeBlockCursor(line: string): string {
  // Pi's built-in Editor/Input render the fake cursor as inverse video:
  //   ESC[7m<char-or-space>ESC[0m / ESC[27m
  // Keep the character/space but remove the block styling. The existing
  // CURSOR_MARKER remains immediately before it, so the visible hardware cursor
  // can sit at the same position as a terminal-native vertical bar.
  return line.replace(/\x1b\[7m([^\x1b]*)\x1b\[(?:0|27)m/g, '$1');
}

function setTerminalCursorStyle(style: CursorStyle): void {
  if (process.stdout.isTTY) {
    process.stdout.write(style === 'line' ? BAR_CURSOR : RESET_CURSOR);
  }
}

function maybeSetHardwareCursor(component: unknown): void {
  const tui = (component as { tui?: { setShowHardwareCursor?: (enabled: boolean) => void } }).tui;
  tui?.setShowHardwareCursor?.(globalState.style === 'line');
}

function patchRenderableCursor(prototype: unknown, originalSymbol: symbol): void {
  const target = prototype as {
    [PATCH_VERSION]?: number;
    [key: symbol]: unknown;
    render: (this: unknown, width: number) => string[];
  };

  target[originalSymbol] ??= target.render;
  target[PATCH_VERSION] = 1;

  target.render = function patchedRender(this: unknown, width: number): string[] {
    maybeSetHardwareCursor(this);
    setTerminalCursorStyle(globalState.style);

    const originalRender = target[originalSymbol] as (this: unknown, width: number) => string[];
    const lines = originalRender.call(this, width);

    if (globalState.style !== 'line') return lines;
    return lines.map(stripFakeBlockCursor);
  };
}

export default function lineCursor(pi: ExtensionAPI) {
  patchRenderableCursor(Editor.prototype, ORIGINAL_EDITOR_RENDER);
  patchRenderableCursor(Input.prototype, ORIGINAL_INPUT_RENDER);

  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode === 'tui') {
      setTerminalCursorStyle(globalState.style);
      ctx.ui.notify(`Cursor style: ${globalState.style}`, 'info');
    }
  });

  pi.on('session_shutdown', () => {
    setTerminalCursorStyle('block');
  });

  pi.registerCommand('cursor', {
    description: 'Set cursor style: line or block',
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trim().toLowerCase();
      return (['line', 'block'] as const)
        .filter((style) => style.startsWith(normalized))
        .map((style) => ({ value: style, label: style }));
    },
    handler: async (args, ctx) => {
      const requested = args.trim().toLowerCase();
      if (requested !== 'line' && requested !== 'block') {
        ctx.ui.notify(`Cursor style: ${globalState.style}. Usage: /cursor line|block`, 'info');
        return;
      }

      globalState.style = requested;
      setTerminalCursorStyle(globalState.style);
      ctx.ui.notify(`Cursor style: ${globalState.style}. Type or move the cursor to see it update.`, 'info');
    },
  });
}
