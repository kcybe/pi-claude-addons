import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type AgentEndEvent,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const STATE_FILENAME = 'loop.local.md';
const DEFAULT_PROMPT_FILENAME = 'loop.md';
const COMPLETION_TAG = /<promise>\s*DONE\s*<\/promise>/is;
const DEFAULT_MAX_ITERATIONS = 100;
const MAX_PROMPT_BYTES = 25_000;

type LoopMode = 'work' | 'timed';

type LoopState = {
  active: boolean;
  mode: LoopMode;
  iteration: number;
  maxIterations: number;
  intervalMs?: number;
  nextRunAt?: string;
  sessionId?: string;
  startedAt?: string;
  prompt?: string;
};

type ParsedLoopCommand =
  | { action: 'start'; prompt: string; maxIterations: number; mode: LoopMode; intervalMs?: number }
  | { action: 'stop' }
  | { action: 'status' }
  | { action: 'help' };

type CommandContextLike = Pick<ExtensionCommandContext | ExtensionContext, 'cwd' | 'ui'>;

type ScheduledTimer = {
  cwd: string;
  sessionId?: string;
  nextRunAt: string;
  timer: ReturnType<typeof setTimeout>;
};

let scheduledTimer: ScheduledTimer | undefined;

function inactiveState(): LoopState {
  return { active: false, mode: 'work', iteration: 0, maxIterations: DEFAULT_MAX_ITERATIONS };
}

function statePath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, STATE_FILENAME);
}

function projectDefaultPromptPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, DEFAULT_PROMPT_FILENAME);
}

function userDefaultPromptPath(): string {
  return join(getAgentDir(), DEFAULT_PROMPT_FILENAME);
}

function parseState(content: string): LoopState {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const state: LoopState = inactiveState();
  if (!match) return state;

  const frontmatter = match[1] ?? '';
  for (const line of frontmatter.split(/\r?\n/)) {
    const [rawKey, ...rawValueParts] = line.split(':');
    const key = rawKey?.trim();
    const value = rawValueParts.join(':').trim();
    if (key === 'active') state.active = value === 'true';
    if (key === 'mode') state.mode = value === 'timed' ? 'timed' : 'work';
    if (key === 'iteration') state.iteration = Number.parseInt(value, 10) || 0;
    if (key === 'maxIterations') state.maxIterations = Number.parseInt(value, 10) || DEFAULT_MAX_ITERATIONS;
    if (key === 'intervalMs') state.intervalMs = Number.parseInt(value, 10) || undefined;
    if (key === 'nextRunAt') state.nextRunAt = value || undefined;
    if (key === 'sessionId') state.sessionId = value || undefined;
    if (key === 'startedAt') state.startedAt = value || undefined;
  }

  const body = content.slice(match[0].length).trim();
  if (body) state.prompt = body;
  return state;
}

function serializeState(state: LoopState): string {
  const lines = [
    '---',
    `active: ${state.active}`,
    `mode: ${state.mode}`,
    `iteration: ${state.iteration}`,
    `maxIterations: ${state.maxIterations}`,
  ];
  if (state.intervalMs) lines.push(`intervalMs: ${state.intervalMs}`);
  if (state.nextRunAt) lines.push(`nextRunAt: ${state.nextRunAt}`);
  if (state.sessionId) lines.push(`sessionId: ${state.sessionId}`);
  if (state.startedAt) lines.push(`startedAt: ${state.startedAt}`);
  lines.push('---');
  if (state.prompt) lines.push('', state.prompt);
  return `${lines.join('\n')}\n`;
}

async function readState(cwd: string): Promise<LoopState> {
  try {
    const content = await readFile(statePath(cwd), 'utf8');
    return parseState(content);
  } catch {
    return inactiveState();
  }
}

async function writeState(cwd: string, state: LoopState): Promise<void> {
  const file = statePath(cwd);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, serializeState(state), 'utf8');
}

function clearScheduledTimer(): void {
  if (scheduledTimer) clearTimeout(scheduledTimer.timer);
  scheduledTimer = undefined;
}

async function clearState(cwd: string): Promise<void> {
  clearScheduledTimer();
  await rm(statePath(cwd), { force: true });
}

async function readDefaultPrompt(cwd: string): Promise<string> {
  const candidates = [projectDefaultPromptPath(cwd), userDefaultPromptPath()];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const content = await readFile(candidate, 'utf8');
    return content.slice(0, MAX_PROMPT_BYTES).trim();
  }

  return `Continue any unfinished work in this Pi session and current repository.

Priority order:
1. Finish work already requested in the conversation.
2. If there is an active code change, inspect status, run focused verification, and fix remaining issues.
3. If there is nothing left to do, summarize that clearly and finish.

Do not start unrelated new initiatives. Do not perform destructive or publishing actions unless the conversation already authorized them.`;
}

function parseDurationToken(token: string): number | undefined {
  const compact = token.match(/^(\d+)([smhd])$/i);
  if (compact?.[1] && compact[2]) {
    const amount = Number.parseInt(compact[1], 10);
    const unit = compact[2].toLowerCase();
    if (unit === 's') return amount * 1_000;
    if (unit === 'm') return amount * 60_000;
    if (unit === 'h') return amount * 60 * 60_000;
    if (unit === 'd') return amount * 24 * 60 * 60_000;
  }

  const words = token.match(/^(\d+)\s*(second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|day|days)$/i);
  if (words?.[1] && words[2]) {
    const amount = Number.parseInt(words[1], 10);
    const unit = words[2].toLowerCase();
    if (unit.startsWith('sec')) return amount * 1_000;
    if (unit.startsWith('min')) return amount * 60_000;
    if (unit.startsWith('hour')) return amount * 60 * 60_000;
    if (unit.startsWith('day')) return amount * 24 * 60 * 60_000;
  }

  return undefined;
}

function durationLabel(ms: number): string {
  if (ms % (24 * 60 * 60_000) === 0) return `${ms / (24 * 60 * 60_000)}d`;
  if (ms % (60 * 60_000) === 0) return `${ms / (60 * 60_000)}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

function stripMaxOption(input: string): { text: string; maxIterations: number } {
  let maxIterations = DEFAULT_MAX_ITERATIONS;
  let text = input;
  const maxMatch = text.match(/(?:^|\s)--max(?:-iterations)?(?:=|\s+)(\d+)(?=\s|$)/i);
  if (maxMatch?.[1]) {
    maxIterations = Math.max(1, Number.parseInt(maxMatch[1], 10) || DEFAULT_MAX_ITERATIONS);
    text = text.replace(maxMatch[0], ' ').trim();
  }
  return { text, maxIterations };
}

function stripInterval(input: string): { text: string; intervalMs?: number } {
  const everyMatch = input.match(/^every\s+(\d+\s*(?:second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|day|days))\s*/i);
  if (everyMatch?.[1]) {
    return { text: input.slice(everyMatch[0].length).trim(), intervalMs: parseDurationToken(everyMatch[1]) };
  }

  const leadingMatch = input.match(/^(\d+[smhd])(?:\s+|$)/i);
  if (leadingMatch?.[1]) {
    return { text: input.slice(leadingMatch[0].length).trim(), intervalMs: parseDurationToken(leadingMatch[1]) };
  }

  const trailingEveryMatch = input.match(/\s+every\s+(\d+\s*(?:second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|day|days))\s*$/i);
  if (trailingEveryMatch?.[1]) {
    return {
      text: input.slice(0, trailingEveryMatch.index).trim(),
      intervalMs: parseDurationToken(trailingEveryMatch[1]),
    };
  }

  return { text: input };
}

function parseLoopCommand(args: string): ParsedLoopCommand {
  const trimmed = args.trim();
  if (!trimmed) {
    return { action: 'start', prompt: '', maxIterations: DEFAULT_MAX_ITERATIONS, mode: 'work' };
  }

  const first = trimmed.split(/\s+/, 1)[0]?.toLowerCase();
  if (first === 'stop' || first === 'cancel' || first === 'off') return { action: 'stop' };
  if (first === 'status') return { action: 'status' };
  if (first === 'help' || first === '--help' || first === '-h') return { action: 'help' };

  const { text: withoutMax, maxIterations } = stripMaxOption(trimmed);
  const { text: prompt, intervalMs } = stripInterval(withoutMax);
  return {
    action: 'start',
    prompt,
    maxIterations,
    mode: intervalMs ? 'timed' : 'work',
    intervalMs,
  };
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const maybeText = (part as { text?: unknown }).text;
      return typeof maybeText === 'string' ? maybeText : '';
    })
    .filter(Boolean)
    .join('\n');
}

function assistantTextFromMessages(messages: unknown[]): string {
  return messages
    .map((message) => {
      if (!message || typeof message !== 'object') return '';
      const maybeMessage = message as { role?: unknown; content?: unknown; message?: { role?: unknown; content?: unknown } };
      const role = maybeMessage.role ?? maybeMessage.message?.role;
      if (role !== 'assistant') return '';
      return textFromContent(maybeMessage.content ?? maybeMessage.message?.content);
    })
    .filter(Boolean)
    .join('\n');
}

function isComplete(event: AgentEndEvent): boolean {
  return COMPLETION_TAG.test(assistantTextFromMessages(event.messages as unknown[]));
}

function startPrompt(state: LoopState): string {
  const timedText =
    state.mode === 'timed' && state.intervalMs
      ? `\nThis is a timed monitoring loop. Run the task now, then Pi will wait ${durationLabel(state.intervalMs)} before running it again. You may stop the loop early by outputting the completion promise when the monitoring task is fully resolved.`
      : '';

  return `[PI LOOP START]

Work autonomously on this task until it is completely and verifiably done.${timedText}

Task:
${state.prompt}

Loop rules:
- Use available tools to inspect, edit, and verify your work.
- If you are blocked, explain the blocker and do NOT claim completion.
- ONLY when the task is completely and verifiably finished, end your response with exactly:

<promise>DONE</promise>

This completion promise must be truthful. The loop will ${state.mode === 'timed' ? 'repeat on its interval' : 'auto-continue'} until that promise appears or ${state.maxIterations} continuation iteration(s) are reached.`;
}

function continuationPrompt(state: LoopState): string {
  return `[PI LOOP - ITERATION ${state.iteration}/${state.maxIterations}]

Your previous turn did not output the completion promise.

Continue from where you left off. Review progress, inspect the repository as needed, and keep working on the original task.

Original task:
${state.prompt || '(no task recorded)'}

Completion rule:
- ONLY when the task is completely and verifiably finished, end your response with exactly:

<promise>DONE</promise>

If you are blocked, explain the blocker and do not output the completion promise.`;
}

function timedIterationPrompt(state: LoopState): string {
  return `[PI TIMED LOOP - ITERATION ${state.iteration}/${state.maxIterations}]

Re-run the scheduled loop prompt now.

Scheduled task:
${state.prompt || '(no task recorded)'}

If the task is now fully resolved and no further checks are needed, end your response with exactly:

<promise>DONE</promise>

Otherwise report what you found/did. Pi will wait ${state.intervalMs ? durationLabel(state.intervalMs) : 'the configured interval'} and run the prompt again.`;
}

function helpText(): string {
  return `Pi Loop: auto-continue work until completion, with optional timed monitoring.

Usage:
  /loop <task>                 # work-until-done mode, continues immediately
  /loop --max 25 <task>        # cap continuation iterations
  /loop 5m <task>              # timed mode, run now then every 5 minutes
  /loop every 2 hours <task>   # timed mode, natural interval syntax
  /loop                        # use ${CONFIG_DIR_NAME}/${DEFAULT_PROMPT_FILENAME} or ~/.pi/agent/${DEFAULT_PROMPT_FILENAME}
  /loop status
  /loop stop

Completion signal:
  <promise>DONE</promise>

Only output the completion signal when the task is completely and verifiably finished.

State file:
  ${CONFIG_DIR_NAME}/${STATE_FILENAME}`;
}

function sendLoopPrompt(pi: ExtensionAPI, ctx: ExtensionContext, prompt: string): void {
  pi.sendUserMessage(prompt, ctx.isIdle() ? undefined : { deliverAs: 'followUp' });
}

function scheduleTimedLoop(pi: ExtensionAPI, ctx: ExtensionContext, state: LoopState, delayMs?: number): void {
  clearScheduledTimer();
  if (!state.active || state.mode !== 'timed' || !state.intervalMs || !state.nextRunAt) return;

  const waitMs = Math.max(0, delayMs ?? new Date(state.nextRunAt).getTime() - Date.now());
  scheduledTimer = {
    cwd: ctx.cwd,
    sessionId: ctx.sessionManager.getSessionId(),
    nextRunAt: state.nextRunAt,
    timer: setTimeout(() => {
      void (async () => {
        try {
          const current = await readState(ctx.cwd);
          if (!current.active || current.mode !== 'timed') return;
          if (current.sessionId && current.sessionId !== ctx.sessionManager.getSessionId()) return;
          if (current.nextRunAt !== state.nextRunAt) return;

          if (current.iteration >= current.maxIterations) {
            await clearState(ctx.cwd);
            ctx.ui.notify(`Loop stopped: reached max iterations (${current.maxIterations}).`, 'warning');
            return;
          }

          const nextState: LoopState = { ...current, iteration: current.iteration + 1, nextRunAt: undefined };
          await writeState(ctx.cwd, nextState);
          sendLoopPrompt(pi, ctx, timedIterationPrompt(nextState));
        } catch (error) {
          ctx.ui.notify(`Loop could not continue: ${error instanceof Error ? error.message : String(error)}`, 'error');
        }
      })();
    }, waitMs),
  };
}

async function startLoop(args: Extract<ParsedLoopCommand, { action: 'start' }>, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const prompt = args.prompt || (await readDefaultPrompt(ctx.cwd));
  const state: LoopState = {
    active: true,
    mode: args.mode,
    iteration: 0,
    maxIterations: args.maxIterations,
    intervalMs: args.intervalMs,
    sessionId: ctx.sessionManager.getSessionId(),
    startedAt: new Date().toISOString(),
    prompt,
  };

  await writeState(ctx.cwd, state);
  clearScheduledTimer();
  const suffix = state.mode === 'timed' && state.intervalMs ? `, interval ${durationLabel(state.intervalMs)}` : '';
  ctx.ui.notify(`Loop started (${state.mode} mode, max ${state.maxIterations}${suffix})`, 'info');
  pi.sendUserMessage(startPrompt(state));
}

async function showStatus(ctx: ExtensionCommandContext): Promise<void> {
  const state = await readState(ctx.cwd);
  if (!state.active) {
    ctx.ui.notify('No active Pi loop.', 'info');
    return;
  }

  const interval = state.intervalMs ? `, interval ${durationLabel(state.intervalMs)}` : '';
  const next = state.nextRunAt ? `, next ${new Date(state.nextRunAt).toLocaleString()}` : '';
  ctx.ui.notify(`Loop active: ${state.mode} mode, iteration ${state.iteration}/${state.maxIterations}${interval}${next}`, 'info');
}

async function stopLoop(ctx: CommandContextLike): Promise<void> {
  const state = await readState(ctx.cwd);
  await clearState(ctx.cwd);
  ctx.ui.notify(
    state.active ? `Loop stopped after ${state.iteration} continuation iteration(s).` : 'No active Pi loop.',
    'info',
  );
}

export default function piLoop(pi: ExtensionAPI) {
  pi.registerCommand('loop', {
    description: 'Auto-continue work until <promise>DONE</promise>; supports timed intervals like /loop 5m <task>',
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trim().toLowerCase();
      return ['status', 'stop', 'help', '--max ', '5m ', '15m ', '1h ', 'every ']
        .filter((item) => item.startsWith(normalized))
        .map((item) => ({ value: item, label: item }));
    },
    handler: async (args, ctx) => {
      const command = parseLoopCommand(args);
      if (command.action === 'help') {
        ctx.ui.notify(helpText(), 'info');
        return;
      }
      if (command.action === 'status') {
        await showStatus(ctx);
        return;
      }
      if (command.action === 'stop') {
        await stopLoop(ctx);
        return;
      }

      await startLoop(command, ctx, pi);
    },
  });

  pi.registerCommand('cancel-loop', {
    description: 'Cancel the active Pi loop',
    handler: async (_args, ctx) => {
      await stopLoop(ctx);
    },
  });

  pi.on('session_start', async (_event, ctx) => {
    if (ctx.mode !== 'tui') return;
    const state = await readState(ctx.cwd);
    if (state.active && state.mode === 'timed' && state.nextRunAt) {
      scheduleTimedLoop(pi, ctx, state);
      ctx.ui.notify(`Timed loop restored; next run ${new Date(state.nextRunAt).toLocaleString()}`, 'info');
    }
  });

  pi.on('session_shutdown', () => {
    clearScheduledTimer();
  });

  pi.on('agent_end', async (event, ctx) => {
    const state = await readState(ctx.cwd);
    if (!state.active) return;
    if (state.sessionId && state.sessionId !== ctx.sessionManager.getSessionId()) return;

    if (isComplete(event)) {
      await clearState(ctx.cwd);
      ctx.ui.notify(`Loop completed after ${state.iteration} continuation iteration(s).`, 'info');
      return;
    }

    if (state.mode === 'timed') {
      if (!state.intervalMs) {
        await clearState(ctx.cwd);
        ctx.ui.notify('Loop stopped: timed loop had no interval.', 'warning');
        return;
      }

      if (state.iteration >= state.maxIterations) {
        await clearState(ctx.cwd);
        ctx.ui.notify(`Loop stopped: reached max iterations (${state.maxIterations}).`, 'warning');
        return;
      }

      const nextRunAt = new Date(Date.now() + state.intervalMs).toISOString();
      const nextState = { ...state, nextRunAt };
      await writeState(ctx.cwd, nextState);
      scheduleTimedLoop(pi, ctx, nextState, state.intervalMs);
      ctx.ui.notify(`Loop waiting ${durationLabel(state.intervalMs)} until next run.`, 'info');
      return;
    }

    if (state.iteration >= state.maxIterations) {
      await clearState(ctx.cwd);
      ctx.ui.notify(`Loop stopped: reached max iterations (${state.maxIterations}).`, 'warning');
      return;
    }

    const nextState = { ...state, iteration: state.iteration + 1 };
    await writeState(ctx.cwd, nextState);

    setTimeout(() => {
      try {
        sendLoopPrompt(pi, ctx, continuationPrompt(nextState));
      } catch (error) {
        ctx.ui.notify(`Loop could not continue: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    }, 100);
  });
}
