# Changelog

All notable changes to the **Overleaf GitLive** extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-04-15

### Added

- **Two-way Git sync** — auto-detect local edits, commit & push after a configurable quiet period; auto-pull when Overleaf has new commits.
- **Smart conflict resolution** — interactive merge editor with VS Code's native Accept / Reject buttons; supports `smart-merge`, `always-ask`, `local-first`, and `remote-first` strategies.
- **Remote PDF preview** — triggers Overleaf compilation after push and displays the PDF inside VS Code.
- **One-click project clone** — fetches your Overleaf project list via cookie and clones the selected project.
- **Secure credential storage** — Git token and cookie stored in VS Code SecretStorage.
- **Sidebar control panel** — start/stop sync, trigger PDF compile, resolve conflicts, and browse commit diffs.
- **Commit diff viewer** — sidebar or QuickPick mode with four status labels (`current`, `partial`, `overwritten`, `orphaned`); whitespace-only changes are treated as non-meaningful.
- **Built-in LaTeX formatter** — Prettier + unified-latex with configurable line width and auto-wrap.
- **Configurable ignore patterns** — glob-based file exclusion during sync (`.output*` always excluded).
- **Auto-start mode** — optionally start sync automatically when an Overleaf project is detected.
