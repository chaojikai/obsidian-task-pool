import { Editor, FileView, MarkdownView, Notice, Plugin, SuggestModal, TAbstractFile, TFile, TFolder, debounce } from "obsidian";
import { EditorView } from "@codemirror/view";
import { DEFAULT_SETTINGS, Scope, TaskPoolSettingTab, TaskPoolSettings } from "./settings";
import { anyExpanded, flashField, getConfig, getModel, setAllExpandedEffect, setConfigEffect, taskPoolField } from "./editor";
import { createDragPlugin } from "./drag";
import { TabBar } from "./tabs";
import { readingPostProcessor } from "./reading";
import { PinManager } from "./pin";
import { DocModel, ListItem, Section, itemAtLine, parseDoc, parseListLine, sectionAtLine, sectionByKey } from "./model";
import { insertTask, moveItem, moveItemToSection, moveSection, sectionAppendTarget } from "./moves";
import { t } from "./i18n";

const AUTO_MIN_SECTIONS = 2;

export default class TaskPoolPlugin extends Plugin {
  settings: TaskPoolSettings = DEFAULT_SETTINGS;
  private tabBars = new WeakMap<MarkdownView, TabBar>();
  private readingExpanded = new Set<string>();
  private pins!: PinManager;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new TaskPoolSettingTab(this.app, this));
    this.pins = new PinManager(this, {
      pinnedPaths: () => this.settings.pinnedPaths,
      style: () => this.settings.pinnedTabStyle,
      keepFront: () => this.settings.pinnedTabFront,
      styleAll: () => this.settings.pinnedTabStyleAll,
      icon: () => this.settings.pinnedTabIcon,
      onUserUnpin: (path) => {
        // The user unpinned the tab inside Obsidian: respect that and drop it from settings
        const i = this.settings.pinnedPaths.indexOf(path);
        if (i < 0) return;
        this.settings.pinnedPaths.splice(i, 1);
        void this.saveSettings();
        new Notice(t.unpinned(basename(path)));
      },
    });

    const refreshEditor = debounce((view: EditorView) => {
      const md = this.markdownViewFor(view);
      if (md) this.syncView(md);
    }, 150, true);

    this.registerEditorExtension([
      taskPoolField,
      flashField,
      createDragPlugin({
        isDragEnabled: (view) => this.scopeAllows(this.settings.dragScope, this.markdownViewFor(view)),
        isQuickAddEnabled: (view) => this.scopeAllows(this.settings.quickAddScope, this.markdownViewFor(view)),
        dropOnTab: (view, model, range, key, opts) => {
          const section = sectionByKey(model, key);
          if (!section) return;
          if (moveItemToSection(view, model, range, section, opts)) new Notice(t.movedTo(section.key));
        },
      }),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        refreshEditor(u.view);
        if (this.settings.autoArchive) this.detectToggle(u.startState.doc, u);
      }),
    ]);

    this.registerMarkdownPostProcessor(
      readingPostProcessor({
        isTabsEnabled: (p) => this.isTabsEnabledForPath(p),
        isFoldEnabled: (p) => this.scopeAllowsPath(this.settings.foldScope, p),
        keepLast: () => this.settings.keepLast,
        activeTab: (p) => this.settings.activeTabs[p] ?? null,
        sectionSurface: () => this.settings.sectionSurface,
        expanded: this.readingExpanded,
      })
    );

    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refreshAll()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.refreshAll()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.refreshAll()));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => this.refreshFile(file)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onRename(file, oldPath)));
    this.app.workspace.onLayoutReady(() => this.refreshAll());

    this.addCommands();
  }

  onunload(): void {
    this.pins.destroy();
    for (const view of this.markdownViews()) {
      this.tabBars.get(view)?.destroy();
      this.tabBars.delete(view);
    }
    document.body.classList.remove("tp-dragging", "tp-tab-dragging");
    document.querySelectorAll(".tp-drag-ghost").forEach((el) => el.remove());
  }

  // ---- Settings ----
  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<TaskPoolSettings> & { foldEverywhere?: boolean; dragEverywhere?: boolean };
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    // Migrate the boolean switches from 0.1
    if (data && typeof data.foldEverywhere === "boolean" && !data.foldScope) this.settings.foldScope = data.foldEverywhere ? "all" : "tabs";
    if (data && typeof data.dragEverywhere === "boolean" && !data.dragScope) this.settings.dragScope = data.dragEverywhere ? "all" : "tabs";
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Whether the tab bar applies to a path: frontmatter first, then the path list, then auto-detection by content */
  isTabsEnabledForPath(path: string, model?: DocModel): boolean {
    if (this.settings.tabsMode === "off") return false;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return false;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const v: unknown = fm?.[this.settings.frontmatterKey];
    if (v === true || v === "true" || v === 1) return true;
    if (v === false || v === "false" || v === 0) return false;
    if (this.settings.enabledPaths.includes(path)) return true;
    if (this.settings.tabsMode !== "auto") return false;
    const sections = model ? model.sections.length : this.countSectionsFromCache(file);
    return sections >= AUTO_MIN_SECTIONS;
  }

  private countSectionsFromCache(file: TFile): number {
    // Without an editor model (reading view and so on), estimate from the open view's text
    for (const view of this.markdownViews()) {
      if (view.file?.path === file.path) return parseDoc(view.getViewData().split("\n")).sections.length;
    }
    return 0;
  }

  private scopeAllowsPath(scope: Scope, path: string, model?: DocModel): boolean {
    if (scope === "all") return true;
    if (scope === "off") return false;
    return this.isTabsEnabledForPath(path, model);
  }

  private scopeAllows(scope: Scope, view: MarkdownView | null): boolean {
    if (scope === "all") return true;
    if (scope === "off" || !view?.file) return false;
    const cm = this.cmOf(view);
    const model = cm && cm.state.field(taskPoolField, false) ? getModel(cm) : undefined;
    return this.isTabsEnabledForPath(view.file.path, model);
  }

  // ---- View sync ----
  /** Loaded markdown views only; a deferred leaf's view is a placeholder without editor methods */
  private markdownViews(): MarkdownView[] {
    const out: MarkdownView[] = [];
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view instanceof MarkdownView) out.push(leaf.view);
    }
    return out;
  }

  private markdownViewFor(cm: EditorView): MarkdownView | null {
    for (const view of this.markdownViews()) {
      if (this.cmOf(view) === cm) return view;
    }
    return null;
  }

  private cmOf(view: MarkdownView): EditorView | null {
    return (view.editor as unknown as { cm?: EditorView } | undefined)?.cm ?? null;
  }

  refreshAll(): void {
    for (const view of this.markdownViews()) this.syncView(view);
    this.pins.sync();
  }

  /** Keep recorded paths in sync when a file or folder is renamed */
  private onRename(file: TAbstractFile, oldPath: string): void {
    const remap = (p: string): string => {
      if (p === oldPath) return file.path;
      if (file instanceof TFolder && p.startsWith(oldPath + "/")) return file.path + p.slice(oldPath.length);
      return p;
    };
    const s = this.settings;
    let changed = false;
    const remapList = (list: string[]) => list.map((p) => { const n = remap(p); if (n !== p) changed = true; return n; });
    s.pinnedPaths = remapList(s.pinnedPaths);
    s.enabledPaths = remapList(s.enabledPaths);
    const activeTabs: Record<string, string> = {};
    for (const [p, key] of Object.entries(s.activeTabs)) { const n = remap(p); if (n !== p) changed = true; activeTabs[n] = key; }
    s.activeTabs = activeTabs;
    if (!changed) return;
    void this.saveSettings().then(() => this.refreshAll());
  }

  // ---- Persistent tabs ----
  private async togglePin(view: FileView): Promise<void> {
    const path = view.file?.path;
    if (!path) return;
    const i = this.settings.pinnedPaths.indexOf(path);
    if (i >= 0) this.settings.pinnedPaths.splice(i, 1); else this.settings.pinnedPaths.push(path);
    await this.saveSettings();
    this.pins.sync();
    new Notice(i >= 0 ? t.unpinned(basename(path)) : t.pinned(basename(path)));
  }

  /** Go to a pinned note; when already on one, go to the next in the list */
  private async gotoPinned(): Promise<void> {
    const paths = this.settings.pinnedPaths;
    if (paths.length === 0) { new Notice(t.noPinned); return; }
    const current = this.app.workspace.getActiveViewOfType(FileView)?.file?.path ?? null;
    const idx = current ? paths.indexOf(current) : -1;
    const target = paths[(idx + 1) % paths.length];
    if (!(await this.pins.open(target))) new Notice(t.fileNotFound(target));
  }

  private refreshFile(file: TFile): void {
    for (const view of this.markdownViews()) {
      if (view.file?.path === file.path) this.syncView(view);
    }
  }

  syncView(view: MarkdownView): void {
    const file = view.file;
    const cm = this.cmOf(view);
    const path = file?.path ?? "";
    const hasField = !!cm && !!cm.state.field(taskPoolField, false);
    const model = hasField && cm ? getModel(cm) : parseDoc(view.getViewData().split("\n"));
    const tabsEnabled = !!file && this.isTabsEnabledForPath(path, model);
    const foldEnabled = !!file && this.scopeAllowsPath(this.settings.foldScope, path, model);
    let activeTab = tabsEnabled ? this.settings.activeTabs[path] ?? null : null;
    if (activeTab && !sectionByKey(model, activeTab)) activeTab = null; // back to "All" when the section is gone

    if (hasField && cm) {
      const cur = getConfig(cm);
      const sectionSurface = this.settings.sectionSurface;
      if (cur.tabsEnabled !== tabsEnabled || cur.foldEnabled !== foldEnabled || cur.keepLast !== this.settings.keepLast || cur.activeTab !== activeTab || cur.sectionSurface !== sectionSurface) {
        cm.dispatch({ effects: setConfigEffect.of({ tabsEnabled, foldEnabled, keepLast: this.settings.keepLast, activeTab, sectionSurface }) });
      }
    }

    let bar = this.tabBars.get(view);
    if (!tabsEnabled) {
      if (bar) { bar.destroy(); this.tabBars.delete(view); }
      return;
    }
    if (!bar) {
      bar = new TabBar(view, {
        onSelect: (v, key) => void this.setActiveTab(v, key),
        onAdd: (v) => this.addTaskToActive(v),
        onReorder: (v, key, beforeKey) => this.reorderSection(v, key, beforeKey),
        canReorder: (v) => v.getMode() !== "preview" && !!this.cmOf(v)?.state.field(taskPoolField, false),
        showCounts: () => this.settings.showCounts,
      });
      this.tabBars.set(view, bar);
    }
    bar.render(model, activeTab);
  }

  async setActiveTab(view: MarkdownView, key: string | null): Promise<void> {
    const path = view.file?.path;
    if (!path) return;
    if (key) this.settings.activeTabs[path] = key; else delete this.settings.activeTabs[path];
    await this.saveSettings();
    this.syncView(view);
    const cm = this.cmOf(view);
    if (cm && key && cm.state.field(taskPoolField, false)) {
      const model = getModel(cm);
      const section = sectionByKey(model, key);
      if (section) {
        const head = cm.state.selection.main.head;
        const line = cm.state.doc.lineAt(head).number - 1;
        if (line < section.start || line > section.end) {
          const target = sectionAppendTarget(model, section);
          const pos = target.line < cm.state.doc.lines ? cm.state.doc.line(target.line + 1).from : cm.state.doc.length;
          cm.dispatch({ selection: { anchor: Math.max(0, pos - 1) }, scrollIntoView: true });
        }
      }
    }
    if (view.getMode() === "preview") view.previewMode.rerender(true);
  }

  /** Dragging a tab rewrites the note so the sections end up in the tab bar's new order */
  private reorderSection(view: MarkdownView, key: string, beforeKey: string | null): void {
    const cm = this.cmOf(view);
    if (!cm || !cm.state.field(taskPoolField, false) || view.getMode() === "preview") {
      new Notice(t.reorderNeedsSource);
      return;
    }
    const model = getModel(cm);
    const from = sectionByKey(model, key);
    if (!from) return;
    if (moveSection(cm, model, from, sectionByKey(model, beforeKey))) {
      this.syncView(view);
      new Notice(t.sectionMoved(key));
    }
  }

  private addTaskToActive(view: MarkdownView): void {
    const cm = this.cmOf(view);
    const path = view.file?.path;
    if (!cm || !path) return;
    if (view.getMode() === "preview") {
      new Notice(t.switchToSource);
      return;
    }
    const model = getModel(cm);
    const section = sectionByKey(model, this.settings.activeTabs[path] ?? null);
    let line: number;
    let indent = 0;
    if (section) {
      const tg = sectionAppendTarget(model, section);
      line = tg.line;
      indent = tg.indent;
    } else {
      line = cm.state.doc.lines;
      while (line > 0 && cm.state.doc.line(line).text.trim() === "") line--;
    }
    insertTask(cm, { line, indent });
  }

  // ---- Re-sort on check ----
  private detectToggle(before: import("@codemirror/state").Text, u: { view: EditorView; state: import("@codemirror/state").EditorState; changes: import("@codemirror/state").ChangeSet; transactions: readonly import("@codemirror/state").Transaction[] }): void {
    if (u.transactions.some((tr) => tr.isUserEvent("move.task-pool"))) return;
    const md = this.markdownViewFor(u.view);
    if (!md?.file || !this.scopeAllowsPath(this.settings.foldScope, md.file.path)) return;
    const after = u.state.doc;
    // One line can carry several changed ranges (checking plus appended text), so dedupe by line
    const toggled = new Set<number>();
    u.changes.iterChangedRanges((fa, ta, fb, tb) => {
      const lineB = after.lineAt(fb);
      if (after.lineAt(tb).number !== lineB.number) return;
      const lineA = before.lineAt(fa);
      if (before.lineAt(ta).number !== lineA.number) return;
      const pa = parseListLine(lineA.text);
      const pb = parseListLine(lineB.text);
      if (!pa || !pb || pa.task === null || pb.task === null) return;
      if ((pa.task === " ") === (pb.task === " ")) return;
      // Allow one side to have a trailing addition (for example a done date appended by the Tasks plugin)
      if (pa.text !== pb.text && !pa.text.startsWith(pb.text) && !pb.text.startsWith(pa.text)) return;
      toggled.add(lineB.number - 1);
    });
    if (toggled.size !== 1) return;
    const [line] = toggled;
    window.setTimeout(() => this.archiveToggled(u.view, line), 0);
  }

  private archiveToggled(view: EditorView, line: number): void {
    if (!view.state.field(taskPoolField, false)) return;
    const model = getModel(view);
    const item = model.items.find((it) => it.start === line);
    if (!item || item.task === null) return;
    const block = model.blocks.find((b) => b.items.includes(item));
    if (!block) return;
    const others = block.items.filter((it) => it !== item);
    if (others.length === 0) return;
    let k = 0;
    while (k < others.length && others[k].checked) k++;
    // Boundary: after the completed run, before the open tasks
    const target = k > 0 ? { line: others[k - 1].end + 1, indent: item.indent } : { line: others[0].start, indent: item.indent };
    // Follow the item when the cursor is on it (keyboard toggle); a mouse click usually has the cursor elsewhere, so keep it still and do not scroll
    const headLine = view.state.doc.lineAt(view.state.selection.main.head).number - 1;
    const follow = headLine >= item.start && headLine <= item.end;
    moveItem(view, model, item, target, { follow });
  }

  // ---- Commands ----
  private currentItem(editor: Editor): { cm: EditorView; model: DocModel; item: ListItem } | null {
    const cm = (editor as unknown as { cm?: EditorView }).cm;
    if (!cm || !cm.state.field(taskPoolField, false)) return null;
    const model = getModel(cm);
    const item = itemAtLine(model, editor.getCursor().line);
    if (!item) { new Notice(t.notOnItem); return null; }
    return { cm, model, item };
  }

  private addCommands(): void {
    this.addCommand({
      id: "move-item-up",
      name: t.cmdMoveUp,
      editorCallback: (editor) => {
        const ctx = this.currentItem(editor);
        if (!ctx) return;
        const block = ctx.model.blocks.find((b) => b.items.includes(ctx.item));
        const idx = block ? block.items.indexOf(ctx.item) : -1;
        if (!block || idx <= 0) return;
        moveItem(ctx.cm, ctx.model, ctx.item, { line: block.items[idx - 1].start, indent: ctx.item.indent });
      },
    });
    this.addCommand({
      id: "move-item-down",
      name: t.cmdMoveDown,
      editorCallback: (editor) => {
        const ctx = this.currentItem(editor);
        if (!ctx) return;
        const block = ctx.model.blocks.find((b) => b.items.includes(ctx.item));
        const idx = block ? block.items.indexOf(ctx.item) : -1;
        if (!block || idx < 0 || idx >= block.items.length - 1) return;
        moveItem(ctx.cm, ctx.model, ctx.item, { line: block.items[idx + 1].end + 1, indent: ctx.item.indent });
      },
    });
    this.addCommand({
      id: "move-item-to-section",
      name: t.cmdMoveToSection,
      editorCallback: (editor) => {
        const ctx = this.currentItem(editor);
        if (!ctx) return;
        if (ctx.model.sections.length === 0) { new Notice(t.noSections); return; }
        const current = sectionAtLine(ctx.model, ctx.item.start);
        new SectionSuggest(this, ctx.model.sections, current, (s) => {
          if (moveItemToSection(ctx.cm, ctx.model, ctx.item, s)) new Notice(t.movedTo(s.key));
        }).open();
      },
    });
    this.addCommand({
      id: "toggle-folds",
      name: t.cmdToggleFolds,
      editorCallback: (editor) => {
        const cm = (editor as unknown as { cm?: EditorView }).cm;
        if (!cm || !cm.state.field(taskPoolField, false)) return;
        cm.dispatch({ effects: setAllExpandedEffect.of(!anyExpanded(cm)) });
      },
    });
    this.addCommand({
      id: "switch-tab",
      name: t.cmdSwitchTab,
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file || !this.tabBars.has(view)) return false;
        if (checking) return true;
        const model = parseDoc(view.getViewData().split("\n"));
        const current = sectionByKey(model, this.settings.activeTabs[view.file.path] ?? null);
        new SectionSuggest(this, model.sections, current, (s) => void this.setActiveTab(view, s.key), true).open();
        return true;
      },
    });
    this.addCommand({
      id: "toggle-pin-note",
      name: t.cmdTogglePin,
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(FileView);
        if (!view?.file) return false;
        if (checking) return true;
        void this.togglePin(view);
        return true;
      },
    });
    this.addCommand({
      id: "goto-pinned-note",
      name: t.cmdGotoPinned,
      callback: () => void this.gotoPinned(),
    });
    for (const dir of [1, -1] as const) {
      this.addCommand({
        id: dir === 1 ? "next-tab" : "prev-tab",
        name: dir === 1 ? t.cmdNextTab : t.cmdPrevTab,
        checkCallback: (checking) => {
          const view = this.app.workspace.getActiveViewOfType(MarkdownView);
          if (!view?.file || !this.tabBars.has(view)) return false;
          if (checking) return true;
          const model = parseDoc(view.getViewData().split("\n"));
          const keys = [null, ...model.sections.map((s) => s.key)];
          const cur = keys.indexOf(this.settings.activeTabs[view.file.path] ?? null);
          void this.setActiveTab(view, keys[(cur + dir + keys.length) % keys.length]);
          return true;
        },
      });
    }
  }
}

function basename(path: string): string {
  return path.split("/").pop()?.replace(/\.md$/i, "") ?? path;
}

class SectionSuggest extends SuggestModal<Section | null> {
  constructor(
    private plugin: TaskPoolPlugin,
    private sections: Section[],
    private current: Section | null,
    private onPick: (s: Section) => void,
    private allowAll = false
  ) {
    super(plugin.app);
    this.setPlaceholder(t.pickSection);
  }

  getSuggestions(query: string): Array<Section | null> {
    const q = query.trim().toLowerCase();
    const list: Array<Section | null> = this.sections.filter((s) => s !== this.current && (!q || s.key.toLowerCase().includes(q)));
    if (this.allowAll && (!q || t.all.toLowerCase().includes(q))) list.unshift(null);
    return list;
  }
  renderSuggestion(s: Section | null, el: HTMLElement): void {
    if (!s) { el.setText(t.all); return; }
    el.createSpan({ text: s.key });
    el.createSpan({ cls: "tp-suggest-count", text: t.openCount(s.open, s.done) });
  }
  onChooseSuggestion(s: Section | null): void {
    if (s) this.onPick(s);
    else {
      const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
      if (view) void this.plugin.setActiveTab(view, null);
    }
  }
}
