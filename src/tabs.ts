// Tab bar: mounted above both the editing and reading views, rendering one state into two DOM trees
import { MarkdownView, setIcon } from "obsidian";
import { DocModel } from "./model";
import { t } from "./i18n";

export interface TabBarHost {
  onSelect(view: MarkdownView, key: string | null): void;
  onAdd(view: MarkdownView): void;
  showCounts(): boolean;
}

export class TabBar {
  private els: HTMLElement[] = [];

  constructor(private view: MarkdownView, private host: TabBarHost) {
    for (const sel of [".markdown-source-view", ".markdown-reading-view"]) {
      const container = view.containerEl.querySelector<HTMLElement>(sel);
      if (!container) continue;
      const el = createDiv({ cls: "tp-tabbar" });
      container.insertBefore(el, container.firstChild);
      this.els.push(el);
    }
  }

  render(model: DocModel, activeKey: string | null): void {
    const totalOpen = model.sections.reduce((n, s) => n + s.open, 0);
    for (const el of this.els) {
      el.empty();
      const inner = el.createDiv({ cls: "tp-tabbar-inner" });
      const all = inner.createDiv({ cls: "tp-tab tp-tab-all" });
      all.dataset.key = "";
      all.createSpan({ cls: "tp-tab-label", text: t.all });
      if (this.host.showCounts()) all.createSpan({ cls: "tp-tab-count", text: String(totalOpen) });
      if (!activeKey) all.addClass("is-active");
      all.addEventListener("click", () => this.host.onSelect(this.view, null));

      for (const s of model.sections) {
        const tab = inner.createDiv({ cls: "tp-tab" });
        tab.dataset.key = s.key;
        tab.setAttribute("aria-label", `${s.key}\n${t.openCount(s.open, s.done)}`);
        tab.createSpan({ cls: "tp-tab-label", text: s.tags[0] });
        if (s.tags.length > 1) tab.createSpan({ cls: "tp-tab-sub", text: s.tags.slice(1).join(" ") });
        if (this.host.showCounts()) {
          const c = tab.createSpan({ cls: "tp-tab-count", text: String(s.open) });
          if (s.open === 0) c.addClass("is-zero");
        }
        if (activeKey === s.key) tab.addClass("is-active");
        tab.addEventListener("click", () => this.host.onSelect(this.view, s.key));
      }

      const add = inner.createDiv({ cls: "tp-tab-add clickable-icon" });
      setIcon(add, "plus");
      add.setAttribute("aria-label", activeKey ? t.addTaskToSection : t.addTaskToEnd);
      add.addEventListener("click", () => this.host.onAdd(this.view));
    }
  }

  destroy(): void {
    for (const el of this.els) el.remove();
    this.els = [];
  }
}
