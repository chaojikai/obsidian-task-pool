// Live Preview side: a StateField providing block-level replace decorations for "fold completed" and "tab filtering"
import { EditorState, RangeSetBuilder, StateEffect, StateField, Transaction } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { DocModel, parseDoc, sectionByKey, sectionContentEnd } from "./model";
import { t } from "./i18n";

export interface EditorConfig {
  foldEnabled: boolean;
  tabsEnabled: boolean;
  keepLast: number;
  activeTab: string | null;
  /** Draw each tag section on its own surface so the groups read apart */
  sectionSurface: boolean;
}

export const setConfigEffect = StateEffect.define<Partial<EditorConfig>>();
export const toggleRunEffect = StateEffect.define<string>();
export const setAllExpandedEffect = StateEffect.define<boolean>();
/** Highlight the lines of a block that was just moved so the eye can follow it; positions are in the post-change document */
export const flashEffect = StateEffect.define<{ from: number; to: number }>();
export const clearFlashEffect = StateEffect.define<null>();

interface FieldValue {
  config: EditorConfig;
  expanded: Set<string>;
  model: DocModel;
  decos: DecorationSet;
  sectionDecos: DecorationSet;
}

const DEFAULT_CONFIG: EditorConfig = { foldEnabled: false, tabsEnabled: false, keepLast: 3, activeTab: null, sectionSurface: false };

class FoldToggleWidget extends WidgetType {
  constructor(readonly runKey: string, readonly total: number, readonly hidden: number, readonly collapsed: boolean, readonly surface: string) {
    super();
  }
  eq(other: FoldToggleWidget): boolean {
    return other.runKey === this.runKey && other.total === this.total && other.hidden === this.hidden && other.collapsed === this.collapsed && other.surface === this.surface;
  }
  toDOM(view: EditorView): HTMLElement {
    const el = createDiv({ cls: "tp-fold-toggle " + (this.collapsed ? "is-collapsed" : "is-expanded") + this.surface });
    const arrow = el.createSpan({ cls: "tp-fold-arrow" });
    arrow.setText(this.collapsed ? "▸" : "▾");
    const label = el.createSpan({ cls: "tp-fold-label" });
    label.setText(this.collapsed ? t.foldCollapsed(this.total, this.hidden) : t.foldExpanded(this.total));
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      view.dispatch({ effects: toggleRunEffect.of(this.runKey) });
    });
    return el;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

function docLines(state: EditorState): string[] {
  const out: string[] = [];
  for (let i = 1; i <= state.doc.lines; i++) out.push(state.doc.line(i).text);
  return out;
}

function buildDecorations(state: EditorState, model: DocModel, config: EditorConfig, expanded: Set<string>): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const doc = state.doc;
  type Range = { from: number; to: number; deco: Decoration; side: number };
  const ranges: Range[] = [];
  const lineFrom = (l: number) => doc.line(l + 1).from;
  const lineTo = (l: number) => doc.line(l + 1).to;

  // Tab filtering: hide every other section
  const hiddenLineRanges: Array<[number, number]> = [];
  if (config.tabsEnabled && config.activeTab) {
    const active = sectionByKey(model, config.activeTab);
    if (active) {
      for (const s of model.sections) {
        if (s === active) continue;
        const last = hiddenLineRanges[hiddenLineRanges.length - 1];
        if (last && last[1] + 1 === s.start) last[1] = s.end; else hiddenLineRanges.push([s.start, s.end]);
      }
    }
  }
  const inHidden = (line: number) => hiddenLineRanges.some(([a, b]) => line >= a && line <= b);
  for (const [a, b] of hiddenLineRanges) {
    ranges.push({ from: lineFrom(a), to: lineTo(b), deco: Decoration.replace({ block: true }), side: 0 });
  }

  // Fold completed runs
  const surfaced = config.tabsEnabled && config.sectionSurface;
  if (config.foldEnabled && config.keepLast >= 0) {
    for (const run of model.runs) {
      if (run.items.length <= config.keepLast) continue;
      if (inHidden(run.items[0].start)) continue;
      const hiddenItems = run.items.slice(0, run.items.length - config.keepLast);
      const from = lineFrom(hiddenItems[0].start);
      const to = lineTo(hiddenItems[hiddenItems.length - 1].end);
      // The widget stands in for lines inside a section, so it carries the same surface
      const last = hiddenItems[hiddenItems.length - 1].end;
      const surface = !surfaced || !run.section ? "" : " tp-sec" + (last === sectionContentEnd(model, run.section) ? " tp-sec-bottom" : "");
      let cursorInside = false;
      for (const r of state.selection.ranges) {
        if (r.to >= from && r.from <= to) { cursorInside = true; break; }
      }
      const isExpanded = expanded.has(run.key) || cursorInside;
      if (isExpanded) {
        ranges.push({
          from,
          to: from,
          deco: Decoration.widget({ widget: new FoldToggleWidget(run.key, run.items.length, hiddenItems.length, false, surfaced && run.section ? " tp-sec" : ""), block: true, side: -1 }),
          side: -1,
        });
      } else {
        ranges.push({
          from,
          to,
          deco: Decoration.replace({ widget: new FoldToggleWidget(run.key, run.items.length, hiddenItems.length, true, surface), block: true }),
          side: 0,
        });
      }
    }
  }

  ranges.sort((a, b) => a.from - b.from || a.side - b.side);
  for (const r of ranges) builder.add(r.from, r.to, r.deco);
  return builder.finish();
}

/** Line decorations that paint each tag section as one surface; kept apart from the replace decorations above so they never join the atomic ranges */
function buildSectionDecorations(state: EditorState, model: DocModel, config: EditorConfig): DecorationSet {
  if (!config.tabsEnabled || !config.sectionSurface || model.sections.length === 0) return Decoration.none;
  const doc = state.doc;
  const builder = new RangeSetBuilder<Decoration>();
  for (const s of model.sections) {
    const end = Math.min(sectionContentEnd(model, s), doc.lines - 1);
    for (let l = s.start; l <= end; l++) {
      const cls = "tp-sec" + (l === s.start ? " tp-sec-top" : "") + (l === end ? " tp-sec-bottom" : "");
      const from = doc.line(l + 1).from;
      builder.add(from, from, Decoration.line({ class: cls }));
    }
  }
  return builder.finish();
}

export const taskPoolField = StateField.define<FieldValue>({
  create(state) {
    const model = parseDoc(docLines(state));
    const config = { ...DEFAULT_CONFIG };
    return {
      config,
      expanded: new Set(),
      model,
      decos: buildDecorations(state, model, config, new Set()),
      sectionDecos: buildSectionDecorations(state, model, config),
    };
  },
  update(value, tr: Transaction) {
    let config = value.config;
    let expanded = value.expanded;
    let changed = false;
    for (const e of tr.effects) {
      if (e.is(setConfigEffect)) { config = { ...config, ...e.value }; changed = true; }
      if (e.is(setAllExpandedEffect)) {
        expanded = e.value ? new Set(value.model.runs.map((r) => r.key)) : new Set();
        changed = true;
      }
      if (e.is(toggleRunEffect)) {
        expanded = new Set(expanded);
        if (expanded.has(e.value)) expanded.delete(e.value); else expanded.add(e.value);
        changed = true;
      }
    }
    const model = tr.docChanged ? parseDoc(docLines(tr.state)) : value.model;
    if (!tr.docChanged && !changed && !tr.selection) return value;
    return {
      config,
      expanded,
      model,
      decos: buildDecorations(tr.state, model, config, expanded),
      sectionDecos: tr.docChanged || changed ? buildSectionDecorations(tr.state, model, config) : value.sectionDecos,
    };
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.decos),
    EditorView.decorations.from(f, (v) => v.sectionDecos),
    EditorView.atomicRanges.of((view) => view.state.field(f).decos),
  ],
});

const FLASH_MS = 700;
const flashLine = Decoration.line({ class: "tp-moved" });

/** Line decorations for a just-moved block; set by flashEffect and cleared shortly after */
export const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decos, tr) {
    decos = decos.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(clearFlashEffect)) decos = Decoration.none;
      if (e.is(flashEffect)) {
        const doc = tr.state.doc;
        const first = doc.lineAt(Math.min(e.value.from, doc.length)).number;
        const last = doc.lineAt(Math.min(Math.max(e.value.from, e.value.to), doc.length)).number;
        const builder = new RangeSetBuilder<Decoration>();
        for (let n = first; n <= last; n++) builder.add(doc.line(n).from, doc.line(n).from, flashLine);
        decos = builder.finish();
      }
    }
    return decos;
  },
  provide: (f) => [
    EditorView.decorations.from(f),
    EditorView.updateListener.of((u) => {
      if (!u.transactions.some((tr) => tr.effects.some((e) => e.is(flashEffect)))) return;
      window.setTimeout(() => {
        if (u.view.dom.isConnected) u.view.dispatch({ effects: clearFlashEffect.of(null) });
      }, FLASH_MS);
    }),
  ],
});

export function getModel(view: EditorView): DocModel {
  return view.state.field(taskPoolField).model;
}

export function getConfig(view: EditorView): EditorConfig {
  return view.state.field(taskPoolField).config;
}

/** Whether any completed run is currently expanded */
export function anyExpanded(view: EditorView): boolean {
  const f = view.state.field(taskPoolField);
  return f.model.runs.some((r) => f.expanded.has(r.key));
}
