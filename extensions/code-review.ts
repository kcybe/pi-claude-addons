import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem } from '@earendil-works/pi-tui';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
const FLAGS = ['--fix', '--comment'] as const;

type Effort = (typeof EFFORTS)[number];

type ParsedArgs = {
  effort?: Effort;
  fix: boolean;
  comment: boolean;
  target?: string;
  passthrough: string;
};

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

function parseArgs(args: string): ParsedArgs {
  const tokens = tokenizeArgs(args);
  let effort: Effort | undefined;
  let fix = false;
  let comment = false;
  const targetParts: string[] = [];

  for (const token of tokens) {
    if (!effort && EFFORTS.includes(token as Effort)) {
      effort = token as Effort;
      continue;
    }
    if (token === '--fix') {
      fix = true;
      continue;
    }
    if (token === '--comment') {
      comment = true;
      continue;
    }
    targetParts.push(token);
  }

  return {
    effort,
    fix,
    comment,
    target: targetParts.length > 0 ? targetParts.join(' ') : undefined,
    passthrough: args.trim() || '(none)',
  };
}

function buildReviewPrompt(args: string): string {
  const parsed = parseArgs(args);
  const effort = parsed.effort ?? 'session default';
  const target = parsed.target ?? 'default diff: current branch commits ahead of upstream plus staged and unstaged working-tree changes';
  const mode = parsed.fix ? 'review and fix' : 'read-only review';
  const commentMode = parsed.comment
    ? 'If this is a GitHub PR and gh is available/authenticated, post high-confidence findings as inline review comments where practical. If mapping lines is uncertain, present comment drafts instead.'
    : 'Do not post external comments.';

  return `Run a local code review modeled on Claude Code /code-review.

Invocation arguments: ${parsed.passthrough}
Parsed mode: ${mode}
Parsed effort: ${effort}
Parsed target: ${target}
GitHub comment mode: ${commentMode}

Operate as an extension-backed slash command. Treat this as a focused review of a git diff, not a general implementation task.

## Scope discovery

1. Confirm this is a git repository.
2. Read review guidance before judging code:
   - Project instructions already in context.
   - REVIEW.md at the repo root, if present. Treat it as review-specific, highest-priority guidance.
   - Relevant CLAUDE.md or AGENTS.md files near changed paths, if present and not already in context.
3. Determine the diff to review:
   - With no target: review commits ahead of the upstream branch plus staged and unstaged working-tree changes.
   - With a file/directory target: review current changes for that path and read surrounding code as needed.
   - With a PR target: use gh pr view/gh pr diff when available; otherwise ask for the diff or review the checked-out branch.
   - With a branch/ref/range target: review that git diff, plus uncommitted changes only if they affect the same files and are clearly relevant.
4. Collect git status, diff stats, and the actual diffs. Use read-only commands unless --fix is present.

Helpful commands to consider, adapting to the target:
- git status --short --branch
- git rev-parse --show-toplevel
- git rev-parse --abbrev-ref --symbolic-full-name @{u}
- git diff --stat
- git diff
- git diff --cached
- git diff <target>
- gh pr diff <PR> / gh pr view <PR> when reviewing a PR

## Effort guidance

- low: report only high-confidence correctness/security issues.
- medium: report important issues and a small number of useful cleanups.
- high, xhigh, max: inspect more surrounding code, callers, tests, schemas, and edge cases before concluding.
- ultra: emulate a deeper multi-pass review locally. Spend extra effort validating findings and, if subagents are available, consider read-only reviewer fanout.

## Review standards

Focus on issues introduced by the reviewed diff:

- Correctness bugs, broken edge cases, subtle regressions.
- Security vulnerabilities, auth/authorization mistakes, data leaks, injection risks.
- Error handling, concurrency, state consistency, and lifecycle problems.
- Reuse, simplification, and efficiency cleanups when actionable and relevant.

Do not spend findings on formatting, naming, missing tests, or preferences unless REVIEW.md explicitly asks for them. Avoid duplicating what lint/typecheck/formatters already enforce.

Validate every candidate finding against the actual code. Read surrounding functions, callers, tests, schemas, and types as needed. Prefer no finding over a speculative or low-confidence finding.

## Severity calibration

Use Claude Code-style severity markers:

- 🔴 Important: a bug, vulnerability, data loss/leak, production regression, or high-confidence issue that should be fixed before merging.
- 🟡 Nit: a minor issue or cleanup that is useful but not blocking.
- 🟣 Pre-existing: a real issue visible during review but not introduced by this diff.

## Output format

Start with one of:

- No actionable findings.
- Found N finding(s):

For each finding, use this format:

<severity> <short title>
File: <path>:<line>
Issue: <specific problem and why it matters>
Evidence: <brief validation from code/diff>
Suggestion: <minimal fix or mitigation>

Then add a concise summary of reviewed scope and residual risks.

## Fix mode

${parsed.fix ? '--fix was provided: present findings first, then apply only safe, focused changes for findings you can fix confidently. Run targeted validation when practical and summarize files changed/checks run.' : '--fix was not provided: do not edit files.'}
`;
}

function maybeSetEffort(pi: ExtensionAPI, effort: Effort | undefined): void {
  if (!effort) return;
  if (effort === 'max' || effort === 'ultra') {
    pi.setThinkingLevel('xhigh');
    return;
  }
  pi.setThinkingLevel(effort);
}

function sendReview(pi: ExtensionAPI, prompt: string, busyMessage: string, ctx: ExtensionCommandContext): void {
  if (ctx.isIdle()) {
    pi.sendUserMessage(prompt);
    return;
  }

  pi.sendUserMessage(prompt, { deliverAs: 'followUp' });
  ctx.ui.notify(busyMessage, 'info');
}

export default function codeReviewExtension(pi: ExtensionAPI) {
  pi.registerCommand('code-review', {
    description: 'Review the current diff like Claude Code /code-review',
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const options = [...EFFORTS, ...FLAGS].map((value) => ({ value, label: value }));
      const last = prefix.split(/\s+/).pop() ?? '';
      const filtered = options.filter((item) => item.value.startsWith(last));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const parsed = parseArgs(args);

      const gitRoot = await pi.exec('git', ['rev-parse', '--show-toplevel'], {
        timeout: 5000,
      });
      if (gitRoot.code !== 0) {
        ctx.ui.notify('/code-review works best inside a git repository; continuing anyway.', 'warning');
      }

      if (parsed.comment) {
        const gh = await pi.exec('bash', ['-lc', 'command -v gh >/dev/null 2>&1'], { timeout: 5000 });
        if (gh.code !== 0) {
          ctx.ui.notify('gh CLI not found; --comment will produce drafts instead of posting.', 'warning');
        }
      }

      maybeSetEffort(pi, parsed.effort);
      sendReview(pi, buildReviewPrompt(args), 'Queued /code-review as a follow-up.', ctx);
    },
  });

  pi.registerCommand('review', {
    description: 'Review a GitHub PR or target using the /code-review engine',
    handler: async (args, ctx) => {
      sendReview(pi, buildReviewPrompt(args.trim()), 'Queued /review as a follow-up.', ctx);
    },
  });
}
