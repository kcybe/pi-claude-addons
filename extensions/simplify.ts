import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem } from '@earendil-works/pi-tui';

const COMMON_TARGETS = ['.', 'HEAD', 'HEAD~1..HEAD', 'main...HEAD', 'origin/main...HEAD'] as const;

function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === '\\') {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaping) current += '\\';
  if (current) tokens.push(current);
  return tokens;
}

function buildSimplifyPrompt(args: string): string {
  const tokens = tokenizeArgs(args);
  const target = tokens.length > 0 ? tokens.join(' ') : 'default changed-code scope: current branch commits ahead of upstream plus staged and unstaged working-tree changes';

  return `Run a local cleanup pass modeled on Claude Code /simplify.

Invocation arguments: ${args.trim() || '(none)'}
Parsed target: ${target}

This command is cleanup-only and applies fixes. Do not use it as a correctness bug hunt; use /code-review for correctness, security, and regression findings.

## Expected behavior

Review the changed code for cleanup opportunities, then apply safe fixes directly to the working tree. Current Claude Code /simplify behavior is separate from /code-review: it looks for reuse, simplification, efficiency, and whether the change sits at the right abstraction level. It should not hunt for bugs.

## Scope discovery

1. Confirm this is a git repository.
2. Read project guidance already in context plus nearby AGENTS.md or CLAUDE.md files when relevant.
3. Determine the changed-code scope:
   - With no target: inspect commits ahead of the upstream branch plus staged and unstaged working-tree changes.
   - With a file/directory target: simplify current changes affecting that path.
   - With a PR target: use gh pr view/gh pr diff when available. Apply fixes only if the PR branch is checked out or the affected files match the working tree; otherwise summarize the cleanup patch that should be applied after checkout.
   - With a branch/ref/range target: inspect that diff and apply fixes to the current working tree only when the files and changes correspond.
4. Collect git status, diff stats, and diffs before editing.

Helpful commands to consider, adapting to the target:
- git status --short --branch
- git rev-parse --show-toplevel
- git rev-parse --abbrev-ref --symbolic-full-name @{u}
- git diff --stat
- git diff
- git diff --cached
- git diff <target>
- gh pr diff <PR> / gh pr view <PR> when reviewing a PR

## Four cleanup lenses

Inspect the changed code through these lenses:

1. Reuse: replace duplicated or ad hoc code with existing helpers, components, hooks, utilities, types, constants, or patterns already used in the repo.
2. Simplification: remove unnecessary branching, indirection, state, conversions, wrappers, or overly broad abstractions. Prefer clearer local code over cleverness.
3. Efficiency: remove avoidable repeated work, unnecessary renders/recomputations, wasteful loops, or inefficient data access introduced by the change.
4. Right abstraction level: move logic to the layer where the repo already keeps similar behavior, avoid feature leakage into shared code, and avoid adding abstractions that only serve one caller.

## What not to do

- Do not search for correctness bugs, security bugs, or broad regressions unless a cleanup edit would obviously introduce one.
- Do not make style-only, formatting-only, naming-only, or preference changes.
- Do not rewrite unrelated code.
- Do not duplicate what formatters, linters, or typecheckers already enforce.
- Do not apply large refactors without strong local evidence.

## Edit rules

- Apply only safe, focused cleanup changes that are directly supported by the diff and surrounding code.
- Preserve behavior.
- Keep the patch small and reviewable.
- If no worthwhile cleanup exists, make no edits and say so.
- If multiple cleanup ideas exist, prioritize the highest-signal changes and skip speculative ones.

## Validation

After edits, run targeted validation when practical, such as typecheck, lint, focused tests, or a narrower command that fits the changed files. If validation is too expensive or unavailable, explain what was not run.

## Output format

Start with one of:

- No cleanup changes applied.
- Applied N cleanup change(s):

Then summarize each change:

- <path>: <what was simplified/reused/optimized and why behavior is preserved>

Finish with:

- Validation: <commands run and results, or not run with reason>
- Residual risks: <anything not checked or target limitations>
`;
}

function sendSimplify(pi: ExtensionAPI, prompt: string, ctx: ExtensionCommandContext): void {
  if (ctx.isIdle()) {
    pi.sendUserMessage(prompt);
    return;
  }

  pi.sendUserMessage(prompt, { deliverAs: 'followUp' });
  ctx.ui.notify('Queued /simplify as a follow-up.', 'info');
}

export default function simplifyExtension(pi: ExtensionAPI) {
  pi.registerCommand('simplify', {
    description: 'Review changed code for cleanup opportunities and apply safe fixes',
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const normalizedPrefix = prefix.trim();
      const filtered = COMMON_TARGETS.filter((target) => target.startsWith(normalizedPrefix));
      return filtered.length > 0 ? filtered.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const gitRoot = await pi.exec('git', ['rev-parse', '--show-toplevel'], {
        timeout: 5000,
      });
      if (gitRoot.code !== 0) {
        ctx.ui.notify('/simplify works best inside a git repository; continuing anyway.', 'warning');
      }

      const hasTarget = tokenizeArgs(args).length > 0;
      if (hasTarget && /(?:^|\s)(?:https:\/\/github\.com\/\S+\/pull\/\d+|#?\d+)(?:\s|$)/.test(args)) {
        const gh = await pi.exec('bash', ['-lc', 'command -v gh >/dev/null 2>&1'], { timeout: 5000 });
        if (gh.code !== 0) {
          ctx.ui.notify('gh CLI not found; PR targets will need a checked-out branch or pasted diff.', 'warning');
        }
      }

      sendSimplify(pi, buildSimplifyPrompt(args), ctx);
    },
  });
}
