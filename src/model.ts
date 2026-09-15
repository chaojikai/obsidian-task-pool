// Document model: parse Markdown lines into tag sections, list items and runs of completed items
// Line numbers are 0-based array indices; end is inclusive

export interface ListItem {
  start: number;      // first line of the item
  end: number;        // last line, child lines included
  indent: number;     // indent width of the first line (a tab counts as 4)
  marker: string;     // "-", "*", "1." and so on
  task: string | null; // character inside the checkbox; null for non-task items
  checked: boolean;
  text: string;       // first-line text without marker and checkbox
}

/** A contiguous range of lines that moves as one unit: a list item, a paragraph, a fenced block or several of them */
export interface LineRange {
  start: number;
  end: number;
  indent: number;     // indent width of the first line; list moves re-indent relative to it
}

export type BlockKind = "list" | "heading" | "paragraph" | "fence";

export interface Block extends LineRange {
  kind: BlockKind;
  text: string;       // first-line text, used for the drag ghost
}

export interface Section {
  key: string;        // "#Pica #MacOS"
  tags: string[];     // ["Pica", "MacOS"]
  label: string;      // "Pica MacOS"
  tagLine: number;
  start: number;      // same as tagLine
  end: number;        // last line before the next tag line
  open: number;       // open task count
  done: number;       // completed task count
}

export interface ListBlock {
  items: ListItem[];  // consecutive list items at the same indent
  indent: number;
}

export interface DoneRun {
  items: ListItem[];  // consecutive completed items
  section: Section | null;
  key: string;
}

export interface DocModel {
  lines: string[];
  frontmatterEnd: number; // index of the last frontmatter line, -1 when absent
  sections: Section[];
  items: ListItem[];      // every list item, nested ones included, in document order
  blocks: ListBlock[];
  runs: DoneRun[];
  fences: Array<{ start: number; end: number }>; // fenced code blocks, inclusive line ranges
}

const TAG_LINE_RE = /^\s*#[^\s#][^\s]*(?:\s+#[^\s#][^\s]*)*\s*$/;
const TAG_TOKEN_RE = /^#(?=.*[^\d#])[^\s#]+$/;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(?:\[(.)\]\s?)?(.*)$/;
const HEADING_RE = /^ {0,3}#{1,6}(?:\s|$)/;

export function isTagLine(line: string): boolean {
  if (!TAG_LINE_RE.test(line)) return false;
  return line.trim().split(/\s+/).every((tok) => TAG_TOKEN_RE.test(tok));
}

export function indentWidth(ws: string): number {
  let w = 0;
  for (const ch of ws) w += ch === "\t" ? 4 : 1;
  return w;
}

export function parseListLine(line: string): { indent: number; marker: string; task: string | null; text: string } | null {
  const m = LIST_RE.exec(line);
  if (!m) return null;
  return { indent: indentWidth(m[1]), marker: m[2], task: m[3] ?? null, text: m[4] ?? "" };
}

export function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

export function isHeadingLine(line: string): boolean {
  return HEADING_RE.test(line);
}

export function parseDoc(lines: string[]): DocModel {
  let frontmatterEnd = -1;
  if (lines.length > 0 && lines[0].trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---" || lines[i].trim() === "...") { frontmatterEnd = i; break; }
    }
  }

  // Lines inside fenced code blocks are skipped
  const inFence: boolean[] = new Array(lines.length).fill(false);
  const fences: Array<{ start: number; end: number }> = [];
  let fence: string | null = null;
  for (let i = frontmatterEnd + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    const open = /^(```+|~~~+)/.exec(t);
    if (fence) {
      inFence[i] = true;
      fences[fences.length - 1].end = i;
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length) fence = null;
    } else if (open) {
      fence = open[1];
      inFence[i] = true;
      fences.push({ start: i, end: i });
    }
  }

  // Sections
  const sections: Section[] = [];
  for (let i = frontmatterEnd + 1; i < lines.length; i++) {
    if (inFence[i]) continue;
    if (!isTagLine(lines[i])) continue;
    const tags = lines[i].trim().split(/\s+/).map((t) => t.slice(1));
    const key = tags.map((t) => "#" + t).join(" ");
    sections.push({ key, tags, label: tags.join(" "), tagLine: i, start: i, end: lines.length - 1, open: 0, done: 0 });
  }
  for (let s = 0; s + 1 < sections.length; s++) sections[s].end = sections[s + 1].start - 1;

  // List items (top-down: an item swallows the more-indented lines that follow)
  const items: ListItem[] = [];
  const blocks: ListBlock[] = [];
  let i = frontmatterEnd + 1;
  let current: ListBlock | null = null;
  while (i < lines.length) {
    const line = lines[i];
    const parsed = inFence[i] ? null : parseListLine(line);
    if (!parsed) {
      if (!isBlank(line) || current) current = null;
      i++;
      continue;
    }
    // Work out the item's range
    let end = i;
    let j = i + 1;
    while (j < lines.length) {
      const l = lines[j];
      if (isBlank(l)) {
        // A blank line followed by a more-indented non-blank line still belongs to this item
        let k = j;
        while (k < lines.length && isBlank(lines[k])) k++;
        if (k < lines.length && !inFence[k] && indentWidth(/^\s*/.exec(lines[k])![0]) > parsed.indent && !isTagLine(lines[k])) {
          j = k;
          continue;
        }
        break;
      }
      const ind = indentWidth(/^\s*/.exec(l)![0]);
      if (ind > parsed.indent && !isTagLine(l)) { end = j; j++; continue; }
      break;
    }
    const item: ListItem = {
      start: i,
      end,
      indent: parsed.indent,
      marker: parsed.marker,
      task: parsed.task,
      checked: parsed.task !== null && parsed.task !== " ",
      text: parsed.text.trim(),
    };
    items.push(item);
    if (current && current.indent === item.indent && current.items[current.items.length - 1].end === i - 1) {
      current.items.push(item);
    } else {
      current = { items: [item], indent: item.indent };
      blocks.push(current);
    }
    i = end + 1;
  }

  // Per-section counts
  const sectionAt = (line: number): Section | null => {
    for (const s of sections) if (line >= s.start && line <= s.end) return s;
    return null;
  };
  const countTasks = (item: ListItem) => {
    const sec = sectionAt(item.start);
    if (!sec || item.task === null) return;
    if (item.checked) sec.done++; else sec.open++;
  };
  for (const item of items) countTasks(item);
  // Nested tasks count too: scan the child task lines inside each item
  for (const item of items) {
    const sec = sectionAt(item.start);
    if (!sec) continue;
    for (let l = item.start + 1; l <= item.end; l++) {
      const p = parseListLine(lines[l]);
      if (!p || p.task === null) continue;
      if (p.task !== " ") sec.done++; else sec.open++;
    }
  }

  // Completed runs: consecutive checked items within each list block
  const runs: DoneRun[] = [];
  for (const block of blocks) {
    let run: ListItem[] = [];
    const flush = () => {
      if (run.length > 0) {
        const section = sectionAt(run[0].start);
        runs.push({ items: run, section, key: `${section?.key ?? ""}::${run[0].text}` });
      }
      run = [];
    };
    for (const item of block.items) {
      if (item.checked) run.push(item); else flush();
    }
    flush();
  }

  return { lines, frontmatterEnd, sections, items, blocks, runs, fences };
}

export function itemAtLine(model: DocModel, line: number): ListItem | null {
  // Innermost list item containing the line (items already include nested ones, so pick the largest start)
  let best: ListItem | null = null;
  for (const it of model.items) {
    if (line >= it.start && line <= it.end && (!best || it.start > best.start)) best = it;
  }
  return best;
}

export function topItemAtLine(model: DocModel, line: number): ListItem | null {
  let best: ListItem | null = null;
  for (const it of model.items) {
    if (line >= it.start && line <= it.end && (!best || it.start < best.start)) best = it;
  }
  return best;
}

/**
 * The draggable block at a line: the innermost list item containing it, or for plain text the fenced block,
 * heading or paragraph (consecutive lines that are neither blank, list, tag, heading nor fenced) around it.
 * Blank lines, tag lines and frontmatter have no block.
 */
export function blockAtLine(model: DocModel, line: number): Block | null {
  const lines = model.lines;
  if (line < 0 || line >= lines.length || line <= model.frontmatterEnd) return null;
  const item = itemAtLine(model, line);
  if (item) return { kind: "list", start: item.start, end: item.end, indent: item.indent, text: item.text };
  const text = lines[line];
  if (isBlank(text) || isTagLine(text)) return null;
  const fence = model.fences.find((f) => line >= f.start && line <= f.end);
  if (fence) return { kind: "fence", start: fence.start, end: fence.end, indent: 0, text: lines[fence.start].trim() };
  if (isHeadingLine(text)) return { kind: "heading", start: line, end: line, indent: 0, text: text.replace(/^\s*#+\s*/, "").trim() };
  const plain = (l: number): boolean => {
    const s = lines[l];
    if (l <= model.frontmatterEnd || isBlank(s) || isTagLine(s) || isHeadingLine(s)) return false;
    if (model.fences.some((f) => l >= f.start && l <= f.end)) return false;
    return !itemAtLine(model, l);
  };
  let start = line;
  while (start > 0 && plain(start - 1)) start--;
  let end = line;
  while (end + 1 < lines.length && plain(end + 1)) end++;
  return { kind: "paragraph", start, end, indent: indentWidth(/^\s*/.exec(lines[start])![0]), text: lines[start].trim() };
}

export function sectionAtLine(model: DocModel, line: number): Section | null {
  for (const s of model.sections) if (line >= s.start && line <= s.end) return s;
  return null;
}

export function sectionByKey(model: DocModel, key: string | null): Section | null {
  if (!key) return null;
  return model.sections.find((s) => s.key === key) ?? null;
}

/** Re-indent a list item's lines to the target indent */
export function reindentItem(lines: string[], item: LineRange, targetIndent: number): string[] {
  const delta = targetIndent - item.indent;
  const out: string[] = [];
  for (let l = item.start; l <= item.end; l++) {
    const line = lines[l];
    if (line.trim().length === 0) { out.push(line); continue; }
    const ws = /^\s*/.exec(line)![0];
    const w = indentWidth(ws);
    const nw = Math.max(0, w + delta);
    out.push(" ".repeat(nw) + line.slice(ws.length));
  }
  return out;
}
