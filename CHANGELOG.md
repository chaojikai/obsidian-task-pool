# Changelog

## 0.1.1 - 2026-09-18

- Fix: the plugin threw and failed to load when the workspace had background tabs that Obsidian had not loaded yet (deferred views, Obsidian 1.7.2 and later)
- `minAppVersion` is now 1.7.2, the release that made `Workspace.revealLeaf` awaitable
- Build DOM through Obsidian's `createEl` helpers, use cross-window safe type checks, drop the deprecated `setDynamicTooltip`, and tighten a few types

## 0.1.0 - 2026-09-15

First public release.

- Fold completed tasks: runs of completed tasks collapse behind a "N done" line, keeping the most recent ones visible; works in both editing and reading views
- Tag tabs: lines that contain only `#tags` become sections, and a note with two or more sections gets a tab bar; auto-detected, with a path list and a note property to force it on or off
- Drag blocks: list items, paragraphs, headings and fenced code blocks get a handle; drop them anywhere or onto a tab to move them into that section. Select several blocks first and they move together. Paragraphs keep a blank line on each side, and a list item dropped next to plain text never swallows it
- Commands: move list item up / down (with children), move to section, switch tab, next / previous tab, expand / collapse completed tasks
- Re-sort on check: a checked task joins the end of the completed run and an unchecked one returns to the top of the open tasks, so skipping a task never splits the fold in two; clicking a checkbox leaves the cursor and scroll position alone
- Persistent tabs: listed notes are pinned automatically, shrink to an icon-only tab and stay first in their tab group; "Go to pinned note" jumps back to them
- Motion: a moved block flashes where it lands and the fold line fades in when its count changes; both respect the system's reduced-motion setting
- English and Chinese UI, following Obsidian's language
