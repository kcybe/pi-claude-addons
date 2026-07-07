# pi-claude-addons

Claude Code-inspired addons for [Pi](https://pi.dev/).

This package is meant to collect small Pi extensions that make Pi feel closer to Claude Code while keeping each behavior easy to inspect and disable.

## Included extensions

### `repeat-paste-expand`

Claude Code-style repeated large-paste expansion.

Behavior:

- First large paste: Pi inserts a compact marker such as `[paste #1 +123 lines]`
- Paste the same text again: the marker expands into the full pasted text
- Press `ctrl+c` to clear the editor: the cycle resets
- Paste the same text after clearing: it is compacted again, then expands on the next same paste

## Install

After this package is published to npm:

```bash
pi install npm:pi-claude-addons
```

If published under an npm scope:

```bash
pi install npm:@your-npm-username/pi-claude-addons
```

## Local development

From this repository:

```bash
pi -e .
```

or install locally:

```bash
pi install .
```

After changing extension files, run `/reload` inside Pi.

## Publishing

```bash
npm login
npm publish --access public
```

If the unscoped npm name is taken, change the package name in `package.json` to a scoped package such as:

```json
"name": "@your-npm-username/pi-claude-addons"
```

then publish with:

```bash
npm publish --access public
```

## Security note

Pi extensions execute with your local user permissions. Review extension code before installing any third-party Pi package.
