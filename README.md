# artifact-viewer

A Claude Code mod that brings the Claude desktop app's artifact panel into the terminal: when Claude writes an HTML, SVG, Mermaid or Markdown file, it opens in a pane docked on the right of the session, already rendered, and reloads every time the file changes.

- **Pages** (`.html`, `.svg`, `.mmd`, plus `.pdf` and images through `/artifacts <file>`) are rendered by a headless Chrome and drawn in the pane as live pixels. The mouse wheel scrolls the page, clicks reach it and typing goes to its fields, so interactive artifacts work.
- **Markdown** (`.md`) is drawn as text, the way Claude's replies are.
- Every artifact of the session gets a tab at the top of the pane.
- Claude is told (in its system prompt) to save visual work as a self-contained file in `~/claude-artifacts/` and to stop taking screenshots of it.

## Requirements

- **macOS** with **Google Chrome** and **Node.js** (18+) on the `PATH`.
- **Ghostty** or **kitty** (0.28+) as the terminal. Claude Code only lets a mod draw pixels there; in any other terminal the pane opens but shows pages as a one-line notice (Markdown still renders).
- The fullscreen layout, which docks panes beside the conversation: `/tui fullscreen`, or `"tui": "fullscreen"` in `~/.claude/settings.json`.
- A window at least **144 columns** wide for the pane to open by itself (110 once you have opened it with `/artifacts`).

## Install

In a Claude Code session in the terminal:

```
/plugin install artifact-viewer --marketplace gnuh/artifact-viewer
```

Answer `y` to add the marketplace, then pick the **user** scope so it loads in every project.

## Use

Ask for something to look at ("make a dashboard of …", "draw the flow as a diagram") and the pane opens with it. Also:

| Command | What it does |
| --- | --- |
| `/artifacts` | Opens the pane |
| `/artifacts <file>` | Shows any file in it (html, svg, md, mmd, pdf, png, jpg, gif, webp) |

Files under `~/.claude/`, `node_modules/`, `CLAUDE.md`/`AGENTS.md`/`MEMORY.md`, and edits of a Markdown file that is not in the pane yet are left out, so routine work does not keep opening it.

## How it works

`hooks/register.tsx` watches Claude's `Write` and `Edit` calls and draws the pane. Pages go to `bin/browser.mjs`, a small Node process (one per session; Chrome starts with the first page) that drives headless Chrome over the DevTools protocol: every frame Chrome paints is saved as a PNG and swapped into the pane's image. `hooks/input.ts` lies over the image and passes clicks and keys back to the page.

## Limits

- Clicks only: no hover effects or dragging.
- Mermaid diagrams load their renderer from a CDN, so they need internet.
- Files Claude creates through the shell instead of `Write` do not open by themselves; use `/artifacts <file>`.
- In the desktop app's Code tab the pane shows tabs and Markdown only.

## Development

```
claude plugin validate .
claude plugin test .
```
