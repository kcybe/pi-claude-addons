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

type LoopState = {
  active: boolean;
  iteration: number;
  maxIterations: number;
  sessionId?: string;
  startedAt?: string;
  prompt?: string;
};

type ParsedLoopCommand =
  | { action: 'start'; prompt: string; maxIterations: number }
  | { action: 'stop' }
  | { action: 'status' }
  | { action: 'help' };

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
  const state: LoopState = { active: false, iteration: 0, maxIterations: DEFAULT_MAX_ITERATIONS };
  if (!match) return state;

  const frontmatter = match[1] ?? '';
  for (const line of frontmatter.split(/\r?\n/)) {
    const [rawKey, ...rawValueParts] = line.split(':');
    const key = rawKey?.trim();
    const value = rawValueParts.join(':').trim();
    if (key === 'active') state.active = value === 'true';
    if (key === 'iteration') state.iteration = Number.parseInt(value, 10) || 0;
    if (key === 'maxIterations') state.maxIterations = Number.parseInt(value, 10) || DEFAULT_MAX_ITERATIONS;
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
    `iteration: ${state.iteration}`,
    `maxIterations: ${state.maxIterations}`,
  ];
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
    return { active: false, iteration: 0, maxIterations: DEFAULT_MAX_ITERATIONS };
  }
}

async function writeState(cwd: string, state: LoopState): Promise<void> {
  const file = statePath(cwd);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, serializeState(state), 'utf8');
}

async function clearState(cwd: string): Promise<void> {
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

function parseLoopCommand(args: string): ParsedLoopCommand {
  const trimmed = args.trim();
  if (!trimmed) {
    return { action: 'start', prompt: '', maxIterations: DEFAULT_MAX_ITERATIONS };
  }

  const first = trimmed.split(/\s+/, 1)[0]?.toLowerCase();
  if (first === 'stop' || first === 'cancel' || first === 'off') return { action: 'stop' };
  if (first === 'status') return { action: 'status' };
  if (first === 'help' || first === '--help' || first === '-h') return { action: 'help' };

  let maxIterations = DEFAULT_MAX_ITERATIONS;
  let prompt = trimmed;

  const maxMatch = prompt.match(/(?:^|\s)--max(?:-iterations)?(?:=|\s+)(\d+)(?=\s|$)/i);
  if (maxMatch?.[1]) {
    maxIterations = Math.max(1, Number.parseInt(maxMatch[1], 10) || DEFAULT_MAX_ITERATIONS);
    prompt = prompt.replace(maxMatch[0], ' ').trim();
  }

  return { action: 'start', prompt, maxIterations };
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

function startPrompt(task: string, maxIterations: number): string {
  return `[PI LOOP START]

Work autonomously on this task until it is completely and verifiably done.

Task:
${task}

Loop rules:
- Keep working across turns until the task is complete.
- Use available tools to inspect, edit, and verify your work.
- If you are blocked, explain the blocker and do NOT claim completion.
- ONLY when the task is completely and verifiably finished, end your response with exactly:

<promise>DONE</promise>

This completion promise must be truthful. The loop will auto-continue until that promise appears or ${maxIterations} continuation iteration(s) are reached.`;
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

function helpText(): string {
  return `Pi Loop: auto-continue work until completion.

Usage:
  /loop <task>
  /loop --max 25 <task>
  /loop              # use ${CONFIG_DIR_NAME}/${DEFAULT_PROMPT_FILENAME} or ~/.pi/agent/${DEFAULT_PROMPT_FILENAME}
  /loop status
  /loop stop

Completion signal:
  <promise>DONE</promise>

Only output the completion signal when the task is completely and verifiably finished.

State file:
  ${CONFIG_DIR_NAME}/${STATE_FILENAME}`;
}

async function startLoop(args: Extract<ParsedLoopCommand, { action: 'start' }>, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const prompt = args.prompt || (await readDefaultPrompt(ctx.cwd));
  const state: LoopState = {
    active: true,
    iteration: 0,
    maxIterations: args.maxIterations,
    sessionId: ctx.sessionManager.getSessionId(),
    startedAt: new Date().toISOString(),
    prompt,
  };

  await writeState(ctx.cwd, state);
  ctx.ui.notify(`Loop started (max ${state.maxIterations} continuation iteration(s))`, 'info');
  pi.sendUserMessage(startPrompt(prompt, state.maxIterations));
}

async function showStatus(ctx: ExtensionCommandContext): Promise<void> {
  const state = await readState(ctx.cwd);
  if (!state.active) {
    ctx.ui.notify('No active Pi loop.', 'info');
    return;
  }

  ctx.ui.notify(`Loop active: iteration ${state.iteration}/${state.maxIterations}`, 'info');
}

async function stopLoop(ctx: Pick<ExtensionCommandContext | ExtensionContext, 'cwd' | 'ui'>): Promise<void> {
  const state = await readState(ctx.cwd);
  await clearState(ctx.cwd);
  ctx.ui.notify(
    state.active ? `Loop stopped after ${state.iteration} continuation iteration(s).` : 'No active Pi loop.',
    'info',
  );
}

export default function piLoop(pi: ExtensionAPI) {
  pi.registerCommand('loop', {
    description: 'Auto-continue work until <promise>DONE</promise> or max iterations',
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.trim().toLowerCase();
      return ['status', 'stop', 'help', '--max ']
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

  pi.on('agent_end', async (event, ctx) => {
    const state = await readState(ctx.cwd);
    if (!state.active) return;
    if (state.sessionId && state.sessionId !== ctx.sessionManager.getSessionId()) return;

    if (isComplete(event)) {
      await clearState(ctx.cwd);
      ctx.ui.notify(`Loop completed after ${state.iteration} continuation iteration(s).`, 'info');
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
        pi.sendUserMessage(continuationPrompt(nextState), ctx.isIdle() ? undefined : { deliverAs: 'followUp' });
      } catch (error) {
        ctx.ui.notify(`Loop could not continue: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    }, 100);
  });
}
