import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Key, matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';

const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
type ThinkingLevel = (typeof LEVELS)[number];

const LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
  off: 'No thinking',
  minimal: 'Fastest reasoning',
  low: 'Light reasoning',
  medium: 'Balanced reasoning',
  high: 'Deep reasoning',
  xhigh: 'Maximum reasoning',
};

function normalize(input: string): ThinkingLevel | undefined {
  const value = input.trim().toLowerCase();
  if (!value) return undefined;
  if ((LEVELS as readonly string[]).includes(value)) return value as ThinkingLevel;
  return undefined;
}

function padToVisibleWidth(text: string, width: number): string {
  const remaining = width - visibleWidth(text);
  return remaining > 0 ? `${text}${' '.repeat(remaining)}` : text;
}

function putCentered(line: string[], text: string, center: number): void {
  const start = Math.max(0, Math.round(center - text.length / 2));
  for (let i = 0; i < text.length && start + i < line.length; i++) {
    line[start + i] = text[i] ?? ' ';
  }
}

async function chooseEffortHorizontally(
  ctx: ExtensionCommandContext,
  current: ThinkingLevel,
): Promise<ThinkingLevel | undefined> {
  if (ctx.mode !== 'tui') {
    const selected = await ctx.ui.select(
      'Choose effort level',
      LEVELS.map((candidate) => {
        const suffix = candidate === current ? ' (current)' : '';
        return `${candidate} — ${LEVEL_DESCRIPTIONS[candidate]}${suffix}`;
      }),
    );
    return selected ? normalize(selected.split(' — ')[0] ?? '') : undefined;
  }

  const currentIndex = Math.max(0, LEVELS.indexOf(current));
  let selectedIndex = currentIndex;

  return (
    (await ctx.ui.custom<ThinkingLevel | null>(
      (tui, theme, _keybindings, done) => {
        const render = (width: number): string[] => {
          const safeWidth = Math.max(24, width);
          const barWidth = Math.max(36, Math.min(96, safeWidth - 16));
          const left = Math.max(0, Math.floor((safeWidth - barWidth) / 2));
          const positions = LEVELS.map((_, index) => Math.round((index * (barWidth - 1)) / (LEVELS.length - 1)));

          const prefix = ' '.repeat(left);
          const fasterSmarter = Array.from({ length: barWidth }, () => ' ');
          putCentered(fasterSmarter, 'Faster', Math.round(barWidth * 0.16));
          putCentered(fasterSmarter, 'Smarter', Math.round(barWidth * 0.84));

          const marker = Array.from({ length: barWidth }, () => ' ');
          marker[positions[selectedIndex] ?? 0] = '▲';

          const labels: string[] = [];
          let cursor = 0;
          LEVELS.forEach((level, index) => {
            const start = Math.max(0, Math.round((positions[index] ?? 0) - level.length / 2));
            labels.push(' '.repeat(Math.max(0, start - cursor)));
            const styled =
              index === selectedIndex
                ? theme.fg('accent', level)
                : index < selectedIndex
                  ? theme.fg('muted', level)
                  : theme.fg('dim', level);
            labels.push(styled);
            cursor = start + level.length;
          });

          const selected = LEVELS[selectedIndex] ?? current;
          const selectedLine = `${theme.fg('accent', selected)} ${theme.fg('muted', `— ${LEVEL_DESCRIPTIONS[selected]}`)}`;

          const lines = [
            theme.fg('borderAccent', '─'.repeat(safeWidth)),
            '',
            `  ${theme.fg('text', theme.bold('Effort'))}`,
            '',
            truncateToWidth(prefix + theme.fg('text', fasterSmarter.join('')), safeWidth, ''),
            truncateToWidth(prefix + theme.fg('border', '─'.repeat(barWidth)), safeWidth, ''),
            truncateToWidth(prefix + theme.fg('accent', marker.join('')), safeWidth, ''),
            truncateToWidth(prefix + padToVisibleWidth(labels.join(''), barWidth), safeWidth, ''),
            truncateToWidth(prefix + selectedLine, safeWidth, ''),
            '',
            theme.fg('dim', '←/→ to adjust · Enter to confirm · Esc to cancel'),
          ];

          return lines.map((line) => truncateToWidth(line, safeWidth, ''));
        };

        return {
          render,
          invalidate() {},
          handleInput(data: string) {
            if (matchesKey(data, Key.left) || data === 'h') {
              selectedIndex = Math.max(0, selectedIndex - 1);
              tui.requestRender();
              return;
            }
            if (matchesKey(data, Key.right) || data === 'l') {
              selectedIndex = Math.min(LEVELS.length - 1, selectedIndex + 1);
              tui.requestRender();
              return;
            }
            if (matchesKey(data, Key.enter)) {
              done(LEVELS[selectedIndex] ?? current);
              return;
            }
            if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c'))) {
              done(null);
            }
          },
        };
      },
      { overlay: true, overlayOptions: { width: '100%', anchor: 'bottom-center', margin: 0 } },
    )) ?? undefined
  );
}

export default function effortCommand(pi: ExtensionAPI) {
  pi.registerCommand('effort', {
    description: 'Set effort/thinking level: off, minimal, low, medium, high, xhigh',
    getArgumentCompletions: (prefix) => {
      const normalizedPrefix = prefix.trim().toLowerCase();
      return LEVELS.filter((level) => level.startsWith(normalizedPrefix)).map((level) => ({
        value: level,
        label: level,
        description: LEVEL_DESCRIPTIONS[level],
      }));
    },
    handler: async (args, ctx) => {
      let level = normalize(args);

      if (!level) {
        if (args.trim()) {
          ctx.ui.notify(`Unknown effort "${args.trim()}". Use one of: ${LEVELS.join(', ')}`, 'error');
          return;
        }

        level = await chooseEffortHorizontally(ctx, normalize(pi.getThinkingLevel()) ?? 'off');
        if (!level) return;
      }

      const before = pi.getThinkingLevel();
      pi.setThinkingLevel(level);
      const after = pi.getThinkingLevel();
      const clamped = after !== level ? ` (requested ${level}, clamped for current model)` : '';
      ctx.ui.notify(`Effort: ${before} → ${after}${clamped}`, 'info');
    },
  });
}
