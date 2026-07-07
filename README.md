# pi-claude-addons

Claude Code-inspired quality-of-life extensions for [Pi](https://pi.dev/).

This package adds a few familiar CLI behaviors while staying small, inspectable, and easy to remove.

## Install

```bash
pi install npm:pi-claude-addons
```

Restart Pi, or run `/reload` in an existing Pi session after installing/updating.

## Features

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

Run a task repeatedly until Pi truthfully signals completion.

```bash
/loop <task>
/loop --max 25 <task>
/loop
/loop status
/loop stop
/cancel-loop
```

How it works:

- Starts an autonomous continuation loop for the current Pi session
- Stores loop state in `.pi/loop.local.md`
- Auto-continues after each assistant turn until the assistant outputs `<promise>DONE</promise>`
- Stops at the configured max iteration count, defaulting to 100
- Bare `/loop` uses `.pi/loop.md`, then `~/.pi/agent/loop.md`, then a built-in maintenance prompt

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
