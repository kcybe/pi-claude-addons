# pi-claude-addons

Claude Code-inspired quality-of-life extensions for [Pi](https://pi.dev/).

This package adds a few familiar CLI behaviors while staying small, inspectable, and easy to remove.

## Install

```bash
pi install npm:pi-claude-addons
```

Restart Pi, or run `/reload` in an existing Pi session after installing/updating.

## Features

### `/code-review [low|medium|high|xhigh|max|ultra] [--fix] [--comment] [target]`

Review the current diff like Claude Code's local `/code-review` command.

```bash
/code-review
/code-review high
/code-review --fix
/code-review main...feature
/code-review high --comment 123
```

What it does:

- Reviews the current branch diff plus staged and unstaged changes by default
- Accepts file, directory, PR, branch, or ref-range targets
- Reads repo `REVIEW.md` guidance when present
- Reports findings with Claude Code-style severity markers: 🔴 Important, 🟡 Nit, 🟣 Pre-existing
- Runs read-only by default
- Supports `--fix` for focused safe fixes
- Supports `--comment` for GitHub PR review comments when `gh` is available, otherwise produces drafts

The package also registers `/review` as a short alias for PR or target review.

### Claude-style image placeholders

When you paste an image with Pi's image-paste keybinding, the editor now inserts a Claude Code-style placeholder instead of the temporary image path:

```text
[Image #1]
[Image #2]
```

What it does:

- Keeps incrementing placeholders for pasted images during the session
- Hides local temporary image paths from the editor
- Sends the corresponding image attachments with the next prompt
- Also converts readable raw image paths in submitted text into placeholders when possible
- Supports PNG, JPEG, GIF, and WebP files

This follows Claude Code's image UX: paths are an implementation detail; the prompt shows numbered image attachments.

### `/simplify [target]`

Review changed code for cleanup opportunities and apply safe fixes, modeled on Claude Code's current `/simplify` behavior.

```bash
/simplify
/simplify src/components/Button.tsx
/simplify main...feature
/simplify 123
```

What it does:

- Reviews the changed-code scope by default, or a file, directory, PR, branch, or ref-range target
- Applies fixes directly when it finds safe cleanup opportunities
- Focuses on four cleanup lenses: reuse of existing helpers, simplification, efficiency, and whether the change is at the right abstraction level
- Avoids correctness/security bug hunting; use `/code-review` for that
- Skips style-only, formatting-only, naming-only, or speculative refactors
- Runs targeted validation when practical and summarizes what changed

### `/cd <path>`

Move the current Pi session to another working directory without restarting Pi.

```bash
/cd ..
/cd ../another-repo
/cd ~/src/project
/cd "/path/with spaces"
```

What it does:

- Validates that the target exists and is a directory
- Preserves the current conversation by relocating it into the target directory's Pi session storage
- Switches Pi so future file and shell operations use the new working directory
- Adds a short context note so the assistant knows the working directory changed
- Supports directory autocompletion, `~`, `..`, relative paths, absolute paths, and paths with spaces

This is modeled after Claude Code's `/cd <path>` behavior: move the session root rather than merely granting access to an extra folder.

### `/effort`

Set Pi's thinking level with a Claude Code-style effort selector.

```bash
/effort
/effort off
/effort medium
/effort high
/effort xhigh
```

Running `/effort` with no argument opens an interactive Faster → Smarter selector. Supported levels are:

- `off`
- `minimal`
- `low`
- `medium`
- `high`
- `xhigh`

Pi may clamp the requested value if the current model does not support that thinking level.

### `/loop`

Run a task until completion, or repeat a prompt on an interval for monitoring.

```bash
/loop <task>                 # work-until-done mode
/loop --max 25 <task>        # cap continuation iterations
/loop 5m <task>              # timed mode
/loop every 2 hours <task>   # timed mode, natural interval syntax
/loop                        # use .pi/loop.md, ~/.pi/agent/loop.md, or built-in maintenance
/loop status
/loop stop
/cancel-loop
```

Work-until-done mode starts immediately and auto-continues after each assistant turn until Pi sees the assistant output:

```text
<promise>DONE</promise>
```

Timed mode starts immediately, then waits the interval and re-runs the prompt until stopped, max iterations are reached, or the assistant outputs the completion promise.

How it works:

- Stores loop state in `.pi/loop.local.md`
- Supports relative default prompts with `.pi/loop.md` and user default prompts with `~/.pi/agent/loop.md`
- Stops at the configured max iteration count, defaulting to 100
- Restores pending timed loop wakeups on `/reload` while the same Pi session is open

Only output `<promise>DONE</promise>` when the task is completely and verifiably finished.

### Claude-style line cursor

Use a vertical line cursor in Pi's editor instead of Pi's default fake block cursor.

```bash
/cursor
/cursor line
/cursor block
```

The line cursor is enabled by default when the extension loads. Use `/cursor block` if you want to temporarily return to block cursor behavior.

### Repeated large-paste expansion

A Claude Code-style paste helper for large blocks of text.

Behavior:

- First large paste: Pi inserts a compact marker such as `[paste #1 +123 lines]`
- Paste the same text again: the marker expands into the full pasted text
- Press `ctrl+c` to clear the editor: the cycle resets
- Paste the same text after clearing: it is compacted again, then expands on the next same paste

## Local development

From this repository:

```bash
pi -e .
```

Or install the local checkout:

```bash
pi install .
```

After changing extension files, run `/reload` inside Pi.

## Security

Pi extensions execute with your local user permissions. Review extension code before installing any third-party Pi package.

## Publishing

For maintainers:

```bash
npm publish --access public
```
