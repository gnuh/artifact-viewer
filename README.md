# artifact-viewer

A Claude Code mod that brings the Claude desktop app's artifact panel into the terminal: when Claude writes an HTML, SVG, Mermaid or Markdown file, it opens docked on the right of the session, already rendered, and reloads every time the file changes. Works on macOS, Linux and Windows.

- **Pages** (`.html`, `.svg`, `.mmd`, plus `.pdf` and images through `/viewer <file>`) are rendered by Chromium. Interactive artifacts work: the mouse wheel scrolls the page, clicks reach it and typing goes to its fields.
- **Markdown** (`.md`) is drawn as text inside Claude Code, the way Claude's replies are.
- Every artifact of the session gets a tab at the top of the pane.
- Claude is told (in its system prompt) to save visual work as a self-contained file in `~/claude-artifacts/` and to stop taking screenshots of it.

## Where the page shows

| Terminal | Pages |
| --- | --- |
| **Ghostty** or **kitty** 0.28+ (macOS, Linux) | Inside Claude Code, in the pane, as live pixels |
| Anything else (Windows Terminal, iTerm2, WezTerm, VS Code, tmux, …) | In an app window docked on the right half of the screen; the pane keeps the tabs and the Markdown |

Claude Code only lets a mod draw pictures on Ghostty and kitty, so that is a limit of the terminal, not of the mod. The window is picked automatically.

## Requirements

Nothing to install by hand:

- **Browser:** an installed Chrome, Edge or Chromium is used when there is one. Otherwise Chrome for Testing (about 200 MB) is downloaded once into `~/.cache/artifact-viewer` (`%LOCALAPPDATA%\artifact-viewer` on Windows).
- **Node.js 22+:** the one on the `PATH` is used when it is new enough. Otherwise the current LTS (about 30 MB) is downloaded once into the same cache.

Also:

- **Fullscreen layout** docks the pane beside the conversation: run `/tui fullscreen` once, or set `"tui": "fullscreen"` in `~/.claude/settings.json`.
- The pane opens by itself when the window is at least **144 columns** wide (110 once you have opened it with `/viewer`).
- **Linux:** the downloaded Chromium needs the usual desktop libraries (`libnss3`, `libgbm1`, GTK…). Every desktop distribution has them; on a bare server install the distribution's `chromium` package, which brings them. Snap builds of Chromium cannot read the run folder and are skipped.

Set `ARTIFACT_VIEWER_BROWSER` to a browser's path to use that one, or to `download` to always use Chrome for Testing.

The page is drawn at the display's density, guessed from the terminal's font size. If it looks blurred or half its size, set `ARTIFACT_VIEWER_SCALE` to `1` (a regular display) or `2` (a HiDPI one).

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
| `/viewer` | Opens the pane |
| `/viewer <file>` | Shows any file in it (html, svg, md, mmd, pdf, png, jpg, gif, webp) |

Files under `~/.claude/`, `node_modules/`, `CLAUDE.md`/`AGENTS.md`/`MEMORY.md`, and edits of a Markdown file that is not in the pane yet are left out, so routine work does not keep opening it.

## How it works

`hooks/register.tsx` watches Claude's `Write` and `Edit` calls and draws the pane. Pages go to `bin/browser.mjs`, a small Node process (one per session; the browser starts with the first page) that drives Chromium over the DevTools protocol on a random localhost port guarded by a token. In the pane, Chromium runs headless and every frame it paints is saved as a PNG and swapped into the pane's image; `hooks/input.ts` lies over the image and passes clicks and keys back to the page. In window mode the same process opens the page in an app window instead.

## Limits

- Clicks only in the pane: no hover effects or dragging.
- Mermaid diagrams load their renderer from a CDN, so they need internet.
- Files Claude creates through the shell instead of `Write` do not open by themselves; use `/viewer <file>`.

## Development

```
claude plugin validate .
claude plugin test .
```
