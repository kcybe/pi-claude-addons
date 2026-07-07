import {
  CURRENT_SESSION_VERSION,
  getAgentDir,
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionEntry,
  type SessionHeader,
} from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem } from '@earendil-works/pi-tui';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

const COMMAND = 'cd';
const CUSTOM_TYPE = 'pi-claude-addons.cd';
const MAX_COMPLETIONS = 50;

let currentCwdForCompletions = process.cwd();

function stripWrappingQuotes(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length < 2) return trimmed;

  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function expandHome(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith(`~${sep}`) || input.startsWith('~/')) return join(homedir(), input.slice(2));
  return input;
}

function resolveTargetPath(rawArgs: string, cwd: string): string {
  // Shell-like convenience: bare `/cd` goes home, while paths with spaces work
  // without requiring quotes because Pi passes the whole remainder as args.
  const rawPath = stripWrappingQuotes(rawArgs) || homedir();
  const expanded = expandHome(rawPath);
  return resolve(cwd, expanded);
}

function makeSessionDir(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  return join(getAgentDir(), 'sessions', safePath);
}

function makeSessionId(): string {
  return randomUUID();
}

async function writeRelocatedSessionFile(
  targetCwd: string,
  sourceHeader: SessionHeader | null,
  sourceFile: string | undefined,
  entries: SessionEntry[],
): Promise<string> {
  const sessionDir = makeSessionDir(targetCwd);
  await mkdir(sessionDir, { recursive: true });

  const id = makeSessionId();
  const timestamp = new Date().toISOString();
  const fileTimestamp = timestamp.replace(/[:.]/g, '-');
  const sessionFile = join(sessionDir, `${fileTimestamp}_${id}.jsonl`);

  const header: SessionHeader = {
    type: 'session',
    version: CURRENT_SESSION_VERSION,
    id,
    timestamp,
    cwd: targetCwd,
    parentSession: sourceFile ?? sourceHeader?.parentSession,
  };

  const lines = [header, ...entries].map((entry) => `${JSON.stringify(entry)}\n`).join('');
  await writeFile(sessionFile, lines, { flag: 'wx' });
  return sessionFile;
}

async function relocateSession(ctx: ExtensionCommandContext, targetCwd: string): Promise<string> {
  const sourceFile = ctx.sessionManager.getSessionFile();

  // Prefer Pi's built-in cross-directory session fork when the current session
  // exists on disk. Fall back to writing the in-memory entries ourselves for a
  // brand-new session that has not been flushed yet.
  if (sourceFile && existsSync(sourceFile)) {
    try {
      const forked = SessionManager.forkFrom(sourceFile, targetCwd);
      const forkedFile = forked.getSessionFile();
      if (!forkedFile) throw new Error('Pi did not return a session file for the relocated session.');
      return forkedFile;
    } catch {
      // The session can exist as a placeholder before Pi has flushed the first
      // assistant turn. In that case, fall through and relocate the in-memory
      // entries exposed by the command context.
    }
  }

  return writeRelocatedSessionFile(
    targetCwd,
    ctx.sessionManager.getHeader(),
    sourceFile,
    ctx.sessionManager.getEntries(),
  );
}

function displayPath(path: string): string {
  const home = homedir();
  if (path === home) return '~';
  if (path.startsWith(`${home}${sep}`)) return `~${sep}${path.slice(home.length + 1)}`;
  return path;
}

function splitCompletionPrefix(rawPrefix: string): { dirPrefix: string; namePrefix: string } {
  if (rawPrefix === '~') return { dirPrefix: '~/', namePrefix: '' };

  const lastSlash = Math.max(rawPrefix.lastIndexOf('/'), rawPrefix.lastIndexOf(sep));
  if (lastSlash >= 0) {
    return {
      dirPrefix: rawPrefix.slice(0, lastSlash + 1),
      namePrefix: rawPrefix.slice(lastSlash + 1),
    };
  }

  return { dirPrefix: '', namePrefix: rawPrefix };
}

async function completePath(prefix: string): Promise<AutocompleteItem[] | null> {
  const rawPrefix = stripWrappingQuotes(prefix);
  const { dirPrefix, namePrefix } = splitCompletionPrefix(rawPrefix);
  const expandedDirPrefix = expandHome(dirPrefix || '.');
  const searchDir = isAbsolute(expandedDirPrefix)
    ? expandedDirPrefix
    : resolve(currentCwdForCompletions, expandedDirPrefix);

  let dirEntries;
  try {
    dirEntries = await readdir(searchDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const items: AutocompleteItem[] = [];

  // Make parent/current-directory navigation first-class. This prevents `..`
  // from being rewritten to the parent's basename (for example `pi-claude-addons/`),
  // which would incorrectly resolve under the current directory.
  if ('..'.startsWith(namePrefix)) {
    items.push({
      value: `${dirPrefix}../`,
      label: '../',
      description: displayPath(resolve(searchDir, '..')),
    });
  }

  if ('.'.startsWith(namePrefix)) {
    items.push({
      value: `${dirPrefix}./`,
      label: './',
      description: displayPath(searchDir),
    });
  }

  const includeHidden = namePrefix.startsWith('.');
  const directoryItems = dirEntries
    .filter((entry) => {
      if (!entry.isDirectory()) return false;
      if (!includeHidden && entry.name.startsWith('.')) return false;
      return entry.name.startsWith(namePrefix);
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_COMPLETIONS - items.length)
    .map((entry): AutocompleteItem => {
      const value = `${dirPrefix}${entry.name}/`;
      const absoluteValue = join(searchDir, entry.name);
      return {
        value,
        label: `${entry.name}/`,
        description: displayPath(absoluteValue),
      };
    });

  items.push(...directoryItems);
  return items.length > 0 ? items : null;
}

export default function cdCommand(pi: ExtensionAPI) {
  pi.on('session_start', (_event, ctx) => {
    currentCwdForCompletions = ctx.cwd;
  });

  pi.registerCommand(COMMAND, {
    description: 'Move this Pi session to another working directory, preserving the conversation',
    getArgumentCompletions: completePath,
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      const targetCwd = resolveTargetPath(args, ctx.cwd);
      let targetStats;
      try {
        targetStats = await stat(targetCwd);
      } catch {
        ctx.ui.notify(`No such directory: ${displayPath(targetCwd)}`, 'error');
        return;
      }

      if (!targetStats.isDirectory()) {
        ctx.ui.notify(`Not a directory: ${displayPath(targetCwd)}`, 'error');
        return;
      }

      if (resolve(ctx.cwd) === targetCwd) {
        ctx.ui.notify(`Already in ${displayPath(targetCwd)}`, 'info');
        return;
      }

      const previousCwd = ctx.cwd;
      const targetSessionFile = await relocateSession(ctx, targetCwd);
      const result = await ctx.switchSession(targetSessionFile, {
        withSession: async (nextCtx) => {
          currentCwdForCompletions = nextCtx.cwd;
          await nextCtx.sendMessage(
            {
              customType: CUSTOM_TYPE,
              display: true,
              content: `Working directory changed from ${previousCwd} to ${nextCtx.cwd}. Use the new directory for subsequent file and shell operations.`,
              details: { from: previousCwd, to: nextCtx.cwd },
            },
            { deliverAs: 'nextTurn' },
          );
          nextCtx.ui.notify(`cd ${displayPath(nextCtx.cwd)}`, 'info');
        },
      });

      if (result.cancelled) {
        ctx.ui.notify(`cd cancelled: ${displayPath(targetCwd)}`, 'warning');
      }
    },
  });
}
