# Overleaf GitLive

<p align="center">
  <img src="resources/icon.png" width="128" height="128" alt="Overleaf GitLive">
</p>

<p align="center">
  <strong>Two-way Git sync + remote PDF preview for Overleaf projects in VS Code</strong>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=RhysWang0405-vsc-studio.overleaf-gitlive">
    <img src="https://img.shields.io/visual-studio-marketplace/v/RhysWang0405-vsc-studio.overleaf-gitlive?label=VS%20Code%20Marketplace" alt="VS Marketplace Version">
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=RhysWang0405-vsc-studio.overleaf-gitlive">
    <img src="https://img.shields.io/visual-studio-marketplace/i/RhysWang0405-vsc-studio.overleaf-gitlive?label=Installs" alt="Installs">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/github/license/Rhys-Wang-wannaLearnMath/Overleaf-GitLive" alt="License">
  </a>
</p>

<p align="center">
  <a href="README.zh-CN.md">中文文档</a>
</p>

---

## Features

- **Automatic two-way Git sync** — Detects local file changes, auto commits & pushes after a quiet period; auto pulls when Overleaf has new commits
- **Smart conflict resolution** — When local and remote edits overlap, opens an interactive merge editor with VS Code's native Accept / Reject buttons
- **Remote PDF preview** — After push, automatically triggers Overleaf compilation and displays the PDF inside VS Code
- **One-click project clone** — Fetches your Overleaf project list via cookie, clones the selected project, and opens it in a new window
- **Secure credential storage** — Git token and cookie stored in VS Code SecretStorage; configure once, use persistently
- **Sidebar control panel** — Start/stop sync, trigger PDF compile, resolve conflicts — all from a dedicated sidebar
- **LaTeX formatter** — Built-in Prettier + unified-latex formatter with configurable line width

## Quick Start

### 1. Configure credentials

Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and run:

- **`Overleaf GitLive: Configure Git Token`** — Enter your Overleaf Git token (from Account Settings → Git Integration)
- **`Overleaf GitLive: Configure Cookie`** — Enter your `overleaf_session2` cookie value

### 2. Clone a project

Run **`Overleaf GitLive: Clone Project`**:

1. The extension fetches your project list using the saved cookie
2. Pick a project → choose a local folder
3. The project is cloned and opened in a new VS Code window

### 3. Start syncing

Inside an Overleaf project folder, run **`Overleaf GitLive: Start Git Sync`** (`Cmd+Alt+S`):

- Local edits are auto-committed & pushed after the quiet period (default 30 s)
- Remote commits from collaborators are auto-pulled
- Status bar shows real-time sync state with countdown

### 4. Start PDF preview

Run **`Overleaf GitLive: Start PDF Preview`**:

- PDF compiles automatically after each push
- Manual refresh: **`Overleaf GitLive: Refresh PDF`** (`Cmd+Alt+R`)

## Conflict Resolution

When both you and a collaborator edit the same file:

1. The sidebar shows a **conflict panel** with action buttons
2. Click **Merge in Editor** to open the file with conflict markers
3. Use VS Code's inline **Accept Current / Accept Incoming / Accept Both** buttons
4. Save the file (`Cmd+S`)
5. Click **Mark Resolved** — the extension commits and pushes immediately

Other options: **Pull & Merge** (auto-merge), **Force Push** (overwrite remote), **Terminal** (manual git).

## Commit Labels & Diff Semantics

The sidebar uses exactly four labels:

| Label | Meaning | Typical scenario |
|-------|---------|------------------|
| `current` | Meaningful added content is fully preserved in current `HEAD` | Commit content is still fully effective |
| `partial` | Meaningful added content is only partially preserved | Later commits rewrote part of this commit |
| `overwritten` | Meaningful added content is fully replaced by later commits | Same branch continued, but this commit's added content no longer survives |
| `orphaned` | Commit is no longer on the current `HEAD` ancestor chain | Restore / rebase / force-push rewrote branch history |

Quick distinction:

- `overwritten`: history still contains the commit, but its meaningful added content is gone.
- `orphaned`: the commit itself is no longer in current branch history.

Additional diff behavior:

- **Whitespace/newline-only changes are treated as non-meaningful** in status classification and file-diff selection.
- If a selected range contains only whitespace/newline changes, the extension reports that they were ignored.
- When multiple files changed, a file picker is shown so you can choose which diffs to open.
- Selected files open as separate pinned diff tabs (not preview-overwritten).
- In single-commit diff mode, overwritten added lines are annotated on the right side with ` [OVERWRITTEN LATER] `.
- If all meaningful added lines in that file were replaced later, the diff title is tagged as `overwritten`; partial replacement is tagged as `partial`.

## Commands

| Command | Description |
|---------|-------------|
| `Clone Project` | Clone an Overleaf project to local |
| `Configure Git Token` | Set Overleaf Git authentication token |
| `Configure Cookie` | Set Overleaf session cookie |
| `Clear All Credentials` | Remove all stored credentials |
| `Start Git Sync` | Start automatic two-way sync |
| `Stop Git Sync` | Stop syncing |
| `Start PDF Preview` | Start PDF compilation & preview |
| `Stop PDF Preview` | Stop PDF preview |
| `Refresh PDF` | Manually trigger compilation + preview |
| `Show Output Log` | Open the extension output log |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `serverUrl` | `https://www.overleaf.com` | Overleaf server URL |
| `quietSeconds` | `30` | Seconds to wait after last edit before auto-commit |
| `pollSeconds` | `2` | Git status polling interval (seconds) |
| `pdfPollSeconds` | `0` | PDF polling interval; `0` = only after push |
| `conflictStrategy` | `smart-merge` | Conflict handling: `smart-merge`, `always-ask`, `local-first`, `remote-first` |
| `ignorePatterns` | `[".*"]` | Glob patterns to exclude from sync (`.output*` is always excluded) |
| `formatter.enabled` | `true` | Enable built-in LaTeX formatter |
| `formatter.lineBreak` | `true` | Auto-wrap lines at print width |
| `formatter.printWidth` | `80` | Line width for formatting |

All settings are prefixed with `overleaf-gitlive.`.

## How to Obtain Credentials

### Git Token

1. Log in to Overleaf → **Account Settings** → **Git Integration**
2. Generate or copy the token

### Cookie

1. Log in to Overleaf in your browser
2. Open DevTools → **Application** → **Cookies**
3. Copy the value of `overleaf_session2`

## Development

```bash
npm install
npm run compile
# Press F5 to launch Extension Development Host
```

### Build VSIX

```bash
npm install -g @vscode/vsce
npm install
vsce package
```

This produces a `.vsix` file in the project root. Install it in VS Code via:

```
Extensions panel → ··· → Install from VSIX…
```

or from the terminal:

```bash
code --install-extension overleaf-gitlive-*.vsix
```

## License

MIT
