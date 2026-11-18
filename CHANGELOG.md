# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.0.2] - 2026-11-18

### Added

- The popup shows its version and a live status line for the current tab
  ("Watching this tab · 16 log lines on screen · 42 saved", or a warning when the
  tab needs a refresh), so it is obvious whether capture is running.
- "Copy details" button that copies troubleshooting information (version, what
  was found on the page, a sample of the log markup) to the clipboard.

## [1.0.1] - 2026-11-18

### Fixed

- **Nothing was captured on the real site.** RiftAtlas renders a row's time and text
  as separate elements spaced with CSS, so a row read `22:38Moved…` and never matched
  the line pattern. Capture now reads RiftAtlas's own log rows
  (`[data-match-log-group] li`) and restores the space.
- Rows that RiftAtlas draws again — when you scroll its log, when a repeat counter
  changes, or after a resync — are recognised instead of being saved twice. The log
  on screen is merged into the saved history by sequence alignment.
- Lines already on screen at page load are saved oldest-first (RiftAtlas lists the
  newest line first).

### Changed

- New `rowSelector` and `newestFirst` settings in `CONFIG`. The previous
  whole-page detection remains as an automatic fallback when the row selector
  matches nothing.

## [1.0.0] - 2026-11-17

First repository release, replacing the v0.1 prototype.

### Added

- **Log capture** on `https://play.riftatlas.com/*`: starts automatically on
  every page load, sweeps lines already on screen, then records each new line
  the moment it renders — so the page's rolling buffer can no longer lose it.
- In-place amendments (`Drew 1 card.` → `Drew 1 card.×2` → `×3`) update the
  stored line instead of duplicating it; recycled DOM nodes append a new line;
  identical lines from different nodes are both kept.
- Optional `logContainerSelector` scoping with automatic fallback to the whole
  page when the selector matches nothing.
- Persistence to `chrome.storage.local`, debounced and flushed when the tab is
  hidden or closed. One page load is one session.
- **Popup**: sessions newest-first with per-session `.txt` / `.json` export and
  delete, plus "Export all (.txt)" and "Delete all".
- **Match recording**: one click (or `Alt+Shift+R`) records the tab's video and
  audio to a local `.webm`, keeps the game audible while recording, and saves
  cleanly if the tab is closed mid-match.
- **Badge**: live per-tab entry count, and a `REC?` reminder while a match is
  being logged but not recorded (can be switched off in the popup).
- Unit tests for line detection and export formats, and a GitHub Actions
  workflow that publishes a ready-to-load zip on every version tag.

[1.0.2]: https://github.com/ding-harrison/RiftAtlasWatcher/releases/tag/v1.0.2
[1.0.1]: https://github.com/ding-harrison/RiftAtlasWatcher/releases/tag/v1.0.1
[1.0.0]: https://github.com/ding-harrison/RiftAtlasWatcher/releases/tag/v1.0.0
