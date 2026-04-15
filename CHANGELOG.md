# Changelog

All notable changes to the **Overleaf GitBridge** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-04-15

### Added

- **Two-way Git sync** — auto-detect local edits, commit & push after quiet period; auto-pull remote changes from Overleaf
- **Smart conflict resolution** — interactive merge editor with VS Code's native Accept / Reject buttons; supports `smart-merge`, `always-ask`, `local-first`, and `remote-first` strategies
- **Remote PDF preview** — trigger Overleaf compilation after push and display the PDF inside VS Code
- **One-click project clone** — fetch Overleaf project list via cookie, clone selected project, and open in a new window
- **Secure credential storage** — Git token and session cookie stored in VS Code SecretStorage
- **Dedicated sidebar** — control sync, PDF preview, conflict resolution, and commit diff browsing from a single panel
- **Commit diff viewer** — browse commit history with `current` / `partial` / `overwritten` / `orphaned` labels; open side-by-side diffs with overwritten-line annotations
- **LaTeX formatter** — built-in Prettier + unified-latex formatter with configurable line width
- **Configurable ignore patterns** — glob-based file exclusion for sync (`.output*` always excluded)
- **Keyboard shortcuts** — `Cmd+Alt+S` (Start Sync), `Cmd+Alt+R` (Refresh PDF), `Cmd+Alt+D` (View Commit Diff)
