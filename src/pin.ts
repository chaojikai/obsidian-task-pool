// Persistent tabs: pin the workspace tab of listed notes (so other files never replace them), shrink it and keep it at the front of the tab bar
// Pinning reuses Obsidian's built-in pin; styling and ordering rely on a few undocumented internals and are skipped when those are missing
import { Plugin, TFile, WorkspaceLeaf, WorkspaceTabs, setIcon } from "obsidian";

export type PinnedTabStyle = "icon" | "compact" | "default";

export interface PinHost {
  pinnedPaths(): string[];
  style(): PinnedTabStyle;
  keepFront(): boolean;
  /** Whether hand-pinned tabs get the same style and ordering */
  styleAll(): boolean;
  icon(): string;
  /** Called when the user unpins a listed note inside Obsidian, so settings can follow */
  onUserUnpin(path: string): void;
}

interface LeafInternal {
  tabHeaderEl?: HTMLElement;
  tabHeaderInnerIconEl?: HTMLElement;
}

interface TabsInternal {
  children?: WorkspaceLeaf[];
  currentTab?: number;
  insertChild?(index: number, leaf: WorkspaceLeaf): void;
  removeChild?(leaf: WorkspaceLeaf): void;
  selectTab?(leaf: WorkspaceLeaf): void;
  updateTabDisplay?(): void;
}

const BASE_CLASS = "tp-pinned-tab";
const STYLE_CLASSES: Record<PinnedTabStyle, string> = {
  icon: "tp-pinned-tab--icon",
  compact: "tp-pinned-tab--compact",
  default: "",
};

export class PinManager {
  private hooked = new WeakSet<WorkspaceLeaf>();
  private marked = new Set<WorkspaceLeaf>();   // tabs currently styled by us
  private listed = new WeakSet<WorkspaceLeaf>(); // the subset pinned because of the settings list
  private suppress = 0;
  private busy = false;

  constructor(private plugin: Plugin, private host: PinHost) {}

  private get workspace() {
    return this.plugin.app.workspace;
  }

  /** File path of a tab, read from the view state so lazily loaded tabs are recognised too */
  static pathOf(leaf: WorkspaceLeaf): string | null {
    const state = leaf.getViewState();
    const file = (state.state as { file?: unknown } | undefined)?.file;
    return typeof file === "string" && file.length > 0 ? file : null;
  }

  private tabLeaves(): WorkspaceLeaf[] {
    const out: WorkspaceLeaf[] = [];
    this.workspace.iterateAllLeaves((leaf) => {
      if (leaf.parent instanceof WorkspaceTabs) out.push(leaf);
    });
    return out;
  }

  private fileLeaves(): WorkspaceLeaf[] {
    return this.tabLeaves().filter((leaf) => PinManager.pathOf(leaf));
  }

  /**
   * Bring the workspace in line with the settings: pin and style listed notes, style hand-pinned tabs
   * the same way, restore tabs that are no longer pinned, then move pinned tabs to the front
   */
  sync(): void {
    if (this.busy) return;
    this.busy = true;
    try {
      const paths = this.host.pinnedPaths();
      const styleAll = this.host.styleAll();
      const seen = new Set<WorkspaceLeaf>();
      const byParent = new Map<WorkspaceTabs, WorkspaceLeaf[]>();
      const collect = (leaf: WorkspaceLeaf) => {
        const parent = leaf.parent as WorkspaceTabs;
        const list = byParent.get(parent) ?? [];
        list.push(leaf);
        byParent.set(parent, list);
      };
      for (const leaf of this.tabLeaves()) {
        seen.add(leaf);
        const path = PinManager.pathOf(leaf);
        if (path && paths.includes(path)) {
          this.apply(leaf);
          collect(leaf);
        } else if (this.listed.has(leaf)) {
          this.release(leaf, true); // removed from the list: unpin
        } else if (styleAll && leaf.getViewState().pinned) {
          this.mark(leaf, false);
          collect(leaf);
        } else if (this.marked.has(leaf)) {
          this.release(leaf, false);
        }
      }
      for (const leaf of this.marked) if (!seen.has(leaf)) this.marked.delete(leaf);
      if (this.host.keepFront()) {
        for (const [parent, leaves] of byParent) this.moveToFront(parent, leaves, paths);
      }
    } finally {
      this.busy = false;
    }
  }

  /** Open (or switch to) a pinned note; returns whether the file exists */
  async open(path: string): Promise<boolean> {
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return false;
    const root = this.workspace.rootSplit;
    const existing = this.fileLeaves().filter((l) => PinManager.pathOf(l) === path);
    let leaf =
      existing.find((l) => this.marked.has(l) && l.getRoot() === root) ??
      existing.find((l) => l.getRoot() === root) ??
      existing[0];
    if (!leaf) {
      leaf = this.workspace.getLeaf("tab");
      await leaf.openFile(file, { active: true });
      this.sync();
    }
    await this.workspace.revealLeaf(leaf);
    this.workspace.setActiveLeaf(leaf, { focus: true });
    return true;
  }

  destroy(): void {
    for (const leaf of Array.from(this.marked)) this.release(leaf, false);
  }

  // ---- Single tab ----
  /** Listed note: make sure it is pinned, then style it */
  private apply(leaf: WorkspaceLeaf): void {
    if (!leaf.getViewState().pinned) this.setPinned(leaf, true);
    this.listed.add(leaf);
    this.mark(leaf, true);
  }

  /** Style the tab and watch its pinned state; customIcon applies to listed notes only */
  private mark(leaf: WorkspaceLeaf, customIcon: boolean): void {
    if (!this.hooked.has(leaf)) {
      this.hooked.add(leaf);
      this.plugin.registerEvent(
        leaf.on("pinned-change", (pinned) => {
          if (this.suppress > 0) return;
          if (pinned) {
            // Obsidian refreshes the tab header after firing the event; sync later to override the icon it resets
            window.setTimeout(() => this.sync(), 0);
            return;
          }
          if (!this.marked.has(leaf)) return;
          const wasListed = this.listed.has(leaf);
          const path = PinManager.pathOf(leaf);
          this.release(leaf, false);
          if (wasListed && path) this.host.onUserUnpin(path);
        })
      );
    }
    this.marked.add(leaf);
    this.decorate(leaf, customIcon);
  }

  private decorate(leaf: WorkspaceLeaf, customIcon: boolean): void {
    const { tabHeaderEl, tabHeaderInnerIconEl } = leaf as unknown as LeafInternal;
    if (!tabHeaderEl) return;
    tabHeaderEl.classList.add(BASE_CLASS);
    const style = this.host.style();
    for (const [key, cls] of Object.entries(STYLE_CLASSES)) if (cls) tabHeaderEl.classList.toggle(cls, key === style);
    if (tabHeaderInnerIconEl) {
      const icon = customIcon ? this.host.icon().trim() : "";
      if (icon) setIcon(tabHeaderInnerIconEl, icon);
      // Fall back to the view's own icon when the name is empty or unknown
      if (!icon || !tabHeaderInnerIconEl.querySelector("svg")) setIcon(tabHeaderInnerIconEl, leaf.getIcon());
    }
  }

  private release(leaf: WorkspaceLeaf, unpin: boolean): void {
    this.marked.delete(leaf);
    this.listed.delete(leaf);
    const { tabHeaderEl, tabHeaderInnerIconEl } = leaf as unknown as LeafInternal;
    tabHeaderEl?.classList.remove(BASE_CLASS, ...Object.values(STYLE_CLASSES).filter(Boolean));
    if (tabHeaderInnerIconEl) setIcon(tabHeaderInnerIconEl, leaf.getIcon());
    if (unpin && leaf.getViewState().pinned) this.setPinned(leaf, false);
  }

  private setPinned(leaf: WorkspaceLeaf, pinned: boolean): void {
    this.suppress++;
    try {
      leaf.setPinned(pinned);
    } finally {
      this.suppress--;
    }
  }

  // ---- Ordering ----
  /** Move pinned tabs to the front of their tab group in settings order; other tabs keep their relative order */
  private moveToFront(parent: WorkspaceTabs, leaves: WorkspaceLeaf[], order: string[]): void {
    const tabs = parent as unknown as TabsInternal;
    const kids = tabs.children;
    if (!kids || kids.length < 2 || typeof tabs.insertChild !== "function" || typeof tabs.removeChild !== "function") return;
    // Listed notes come first in list order; other pinned tabs keep their existing relative order
    const rank = (leaf: WorkspaceLeaf) => {
      const i = order.indexOf(PinManager.pathOf(leaf) ?? "");
      return i < 0 ? order.length + kids.indexOf(leaf) : i;
    };
    const desired = [...leaves].sort((a, b) => rank(a) - rank(b));
    if (desired.every((leaf, i) => kids[i] === leaf)) return;
    const active = tabs.currentTab != null ? kids[tabs.currentTab] : undefined;
    try {
      for (let i = 0; i < desired.length; i++) {
        if (kids[i] === desired[i]) continue;
        tabs.removeChild(desired[i]);
        tabs.insertChild(i, desired[i]);
      }
      if (active && typeof tabs.selectTab === "function") tabs.selectTab(active);
      tabs.updateTabDisplay?.();
    } catch (e) {
      console.warn("[task-pool] failed to reorder pinned tabs", e);
    }
  }
}
