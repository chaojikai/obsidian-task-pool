# Changelog

## Unreleased

- The empty strip that closes a section card is now a target too: the gutter `+` appears next to it and adds a task at the end of that section
- Adding a task on the blank line between two sections keeps the blank line, so the two cards no longer run together
- Fix: the padding inside a section card never applied, because Obsidian's own `.cm-line` rules out-specified it; the last task sat on the card's border

## 0.2.0 - 2026-09-22

- Reorder sections by dragging their tabs: drop a tab between two others and the section moves with it in the note
- A plus appears in the gutter of a blank line; clicking it turns the line into a task, indented like the list above, for when the cursor did not arrive there from another task
- Tasks with no text are left out of the tab counts, so a checkbox you are still writing does not show up as an open task
- Each tag section is drawn on a light surface with a border, so the groups read apart in the All view; the fold line inside a section is part of the same card. Turn it off with "Section background"
- The tab bar now sits on a tinted surface with the active tab lifted off it, so it reads as one block instead of floating over the note

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
