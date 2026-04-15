# Overleaf GitBridge

<p align="center">
  <img src="resources/icon.png" width="128" height="128" alt="Overleaf GitBridge">
</p>

<p align="center">
  <strong>Two-way Git sync + remote PDF preview for Overleaf projects in VS Code</strong>
</p>

<p align="center">
  <a href="README.zh-CN.md">中文文档</a>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=RhysWang0405-vsc-studio.overleaf-gitbridge">
    <img src="https://img.shields.io/visual-studio-marketplace/v/RhysWang0405-vsc-studio.overleaf-gitbridge?label=VS%20Code%20Marketplace" alt="VS Code Marketplace">
  </a>
  <a href="https://marketplace.visualstudio.com/items?itemName=RhysWang0405-vsc-studio.overleaf-gitbridge">
    <img src="https://img.shields.io/visual-studio-marketplace/i/RhysWang0405-vsc-studio.overleaf-gitbridge" alt="Installs">
  </a>
  <a href="https://github.com/Rhys-Wang-wannaLearnMath/Overleaf-GitBridge/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/Rhys-Wang-wannaLearnMath/Overleaf-GitBridge" alt="License">
  </a>
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

## Requirements

- **VS Code** ≥ 1.80.0
- **Git** installed and available in `PATH`
- An **Overleaf** account (free or paid) with Git Integration enabled

## Quick Start

### 1. Configure credentials

Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and run:

- **`Overleaf GitBridge: Configure Git Token`** — Enter your Overleaf Git token (from Account Settings → Git Integration)
- **`Overleaf GitBridge: Configure Cookie`** — Enter your `overleaf_session2` cookie value

### 2. Clone a project

Run **`Overleaf GitBridge: Clone Project`**:

1. The extension fetches your project list using the saved cookie
2. Pick a project → choose a local folder
3. The project is cloned and opened in a new VS Code window

### 3. Start syncing

Inside an Overleaf project folder, run **`Overleaf GitBridge: Start Git Sync`** (`Cmd+Alt+S`):

- Local edits are auto-committed & pushed after the quiet period (default 30 s)
- Remote commits from collaborators are auto-pulled
- Status bar shows real-time sync state with countdown

### 4. Start PDF preview

Run **`Overleaf GitBridge: Start PDF Preview`**:

- PDF compiles automatically after each push
- Manual refresh: **`Overleaf GitBridge: Refresh PDF`** (`Cmd+Alt+R`)

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

All commands are prefixed with `Overleaf GitBridge:`.

| Command | Shortcut | Description |
|---------|----------|-------------|
| `Clone Project` | — | Clone an Overleaf project to local |
| `Configure Git Token` | — | Set Overleaf Git authentication token |
| `Configure Cookie` | — | Set Overleaf session cookie |
| `Clear All Credentials` | — | Remove all stored credentials |
| `Start Git Sync` | `Cmd+Alt+S` | Start automatic two-way sync |
| `Stop Git Sync` | — | Stop syncing |
| `Start PDF Preview` | — | Start PDF compilation & preview |
| `Stop PDF Preview` | — | Stop PDF preview |
| `Refresh PDF` | `Cmd+Alt+R` | Manually trigger compilation + preview |
| `View Commit Diff` | `Cmd+Alt+D` | Browse commit history and open side-by-side diffs |
| `Show Output Log` | — | Open the extension output log |
| `Open Settings` | — | Jump to extension settings |

## Settings

All settings are prefixed with `overleaf-gitbridge.`.

| Setting | Default | Description |
|---------|---------|-------------|
| `serverUrl` | `https://www.overleaf.com` | Overleaf server URL (change for self-hosted instances) |
| `pollSeconds` | `1` | Git status polling interval in seconds |
| `pdfPollSeconds` | `0` | PDF periodic polling interval in seconds; `0` = only compile after push |
| `autoStart` | `off` | Behavior on activation: `off`, `ask`, or `sync` |
| `conflictStrategy` | `smart-merge` | Conflict handling: `smart-merge`, `always-ask`, `local-first`, `remote-first` |
| `diffViewMode` | `sidebar` | Where to browse commit diffs: `sidebar` or `quickpick` |
| `ignorePatterns` | `[".*"]` | Glob patterns to exclude from sync (`.output*` is always excluded) |
| `formatter.enabled` | `true` | Enable built-in LaTeX formatter |
| `formatter.lineBreak` | `true` | Auto-wrap lines at print width |
| `formatter.printWidth` | `80` | Line width for LaTeX formatting |

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
code --install-extension overleaf-gitbridge-*.vsix
```

## Contributing

Bug reports and pull requests are welcome on [GitHub](https://github.com/Rhys-Wang-wannaLearnMath/Overleaf-GitBridge/issues).

## License

[MIT](LICENSE) © Rhys Wang
