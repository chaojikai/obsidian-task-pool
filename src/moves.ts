// Moving list items and other blocks: dragging, commands and "move to section" share one text transformation
import { EditorView } from "@codemirror/view";
import { DocModel, LineRange, Section, isBlank, isHeadingLine, isTagLine, parseListLine, reindentItem } from "./model";
import { flashEffect } from "./editor";

export interface MoveTarget {
  line: number;    // insert before this line; equal to the line count means append at the end
  indent: number;  // target indent
}

/** Extra options for a move */
export interface MoveOptions {
  /** Whether the cursor follows the range (default true); when false the selection is mapped through the change and the view does not scroll */
  follow?: boolean;
  /** Keep the block separated by blank lines: pad the insertion and drop a blank line left behind by the removal. Used for paragraphs, headings and fenced blocks */
  separate?: boolean;
}

export function isNoopMove(range: LineRange, target: MoveTarget): boolean {
  return target.line >= range.start && target.line <= range.end + 1 && target.indent === range.indent;
}

/** Plain text line: not blank and not a list, tag or heading line. A list item placed right above one would swallow it as a lazy continuation */
function isTextLine(line: string): boolean {
  return !isBlank(line) && !parseListLine(line) && !isTagLine(line) && !isHeadingLine(line);
}

/** Move the lines of range before target; returns whether the document changed */
export function moveItem(view: EditorView, model: DocModel, range: LineRange, target: MoveTarget, opts: MoveOptions = {}): boolean {
  if (isNoopMove(range, target)) return false;
  const follow = opts.follow ?? true;
  const doc = view.state.doc;
  const nLines = doc.lines;
  const lines = model.lines;
  const textLines = reindentItem(lines, range, target.indent);
  const text = textLines.join("\n");

  // Removal; a separated block also takes one neighbouring blank line with it so no double blank is left behind
  let rmStart = range.start;
  let rmEnd = range.end;
  if (opts.separate) {
    const beforeBlank = rmStart > 0 && isBlank(lines[rmStart - 1]);
    const afterBlank = rmEnd + 1 < nLines && isBlank(lines[rmEnd + 1]);
    if (afterBlank && (beforeBlank || rmStart === 0)) rmEnd++;
    else if (beforeBlank && rmEnd + 1 >= nLines) rmStart--;
  }
  let rmFrom: number;
  let rmTo: number;
  if (rmEnd < nLines - 1) {
    rmFrom = doc.line(rmStart + 1).from;
    rmTo = doc.line(rmEnd + 2).from;
  } else {
    rmFrom = rmStart > 0 ? doc.line(rmStart).to : 0;
    rmTo = doc.length;
  }

  // Insertion, padded with blank lines where the neighbours would otherwise merge with the block
  const prev = target.line > 0 ? lines[target.line - 1] : null;
  const next = target.line < nLines ? lines[target.line] : null;
  const padBefore = prev !== null && (opts.separate ? !isBlank(prev) : isTextLine(prev));
  const padAfter = next !== null && (opts.separate ? !isBlank(next) : isTextLine(next));
  let insAt: number;
  let insert: string;
  if (target.line < nLines) {
    insAt = doc.line(target.line + 1).from;
    insert = (padBefore ? "\n" : "") + text + "\n" + (padAfter ? "\n" : "");
  } else {
    insAt = doc.length;
    insert = (doc.length > 0 && doc.sliceString(doc.length - 1) !== "\n" ? "\n" : "") + (padBefore ? "\n" : "") + text;
  }
  // A target inside the removed range is invalid
  if (insAt > rmFrom && insAt < rmTo) return false;

  const changes = [{ from: rmFrom, to: rmTo }, { from: insAt, insert }];
  const newPos = insAt <= rmFrom ? insAt : insAt - (rmTo - rmFrom);
  const textStart = newPos + (/^\n*/.exec(insert)?.[0].length ?? 0);
  // Put the cursor at the start of the first line's text (after the list marker), matching Obsidian's own move commands and keeping auto-formatting plugins from treating it as typing
  const contentOffset = (/^(\s*)([-*+]|\d+[.)])\s+(?:\[.\]\s?)?/.exec(textLines[0])?.[0] ?? "").length;
  view.dispatch({
    changes,
    selection: follow ? { anchor: textStart + contentOffset } : undefined,
    scrollIntoView: follow,
    effects: flashEffect.of({ from: textStart, to: textStart + text.length }),
    userEvent: "move.task-pool",
  });
  return true;
}

/** Insertion point at the end of a section: after the last outermost list item, or right after the tag line when there are none */
export function sectionAppendTarget(model: DocModel, section: Section, exclude?: LineRange): MoveTarget {
  const inSection = model.items.filter((it) => {
    if (it.start < section.start || it.start > section.end) return false;
    if (exclude && it.start >= exclude.start && it.end <= exclude.end) return false;
    return true;
  });
  if (inSection.length === 0) return { line: section.tagLine + 1, indent: 0 };
  const minIndent = Math.min(...inSection.map((it) => it.indent));
  const tops = inSection.filter((it) => it.indent === minIndent);
  const last = tops[tops.length - 1];
  return { line: last.end + 1, indent: last.indent };
}

/**
 * Reorder whole tag sections: move `from` (its tag line and everything up to the next tag line)
 * in front of `before`, or to the end of the note when `before` is null
 */
export function moveSection(view: EditorView, model: DocModel, from: Section, before: Section | null): boolean {
  const sections = model.sections;
  const idx = sections.indexOf(from);
  const at = before ? sections.indexOf(before) : sections.length;
  if (idx < 0 || at < 0 || at === idx || at === idx + 1) return false;
  const lines = model.lines;
  // Trailing blank lines belong to the gap between sections, not to the section being moved
  const trimmedEnd = (s: Section): number => {
    let e = s.end;
    while (e > s.start && isBlank(lines[e])) e--;
    return e;
  };
  const range: LineRange = { start: from.start, end: trimmedEnd(from), indent: 0 };
  const line = before ? before.tagLine : trimmedEnd(sections[sections.length - 1]) + 1;
  return moveItem(view, model, range, { line, indent: 0 }, { separate: true, follow: false });
}

export function moveItemToSection(view: EditorView, model: DocModel, range: LineRange, section: Section, opts: MoveOptions = {}): boolean {
  const target = sectionAppendTarget(model, section, range);
  if (opts.separate) target.indent = range.indent; // paragraphs keep their own indent
  return moveItem(view, model, range, target, opts);
}
