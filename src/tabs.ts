// Tab bar: mounted above both the editing and reading views, rendering one state into two DOM trees
import { MarkdownView, setIcon } from "obsidian";
import { DocModel } from "./model";
import { t } from "./i18n";

export interface TabBarHost {
  onSelect(view: MarkdownView, key: string | null): void;
  onAdd(view: MarkdownView): void;
  /** Move the section of `key` in front of `beforeKey`, or to the end of the note when it is null */
  onReorder(view: MarkdownView, key: string, beforeKey: string | null): void;
  /** Whether tabs can be dragged right now; reordering rewrites the note, so it needs the editor */
  canReorder(view: MarkdownView): boolean;
  showCounts(): boolean;
}

interface TabDrag {
  key: string;
  el: HTMLElement;
  inner: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
  beforeKey: string | null;
  marker: HTMLElement | null;
}

const DRAG_THRESHOLD = 4;

export class TabBar {
  private els: HTMLElement[] = [];
  private drag: TabDrag | null = null;
  /** A drag ends with a click on the same element; swallow that one click so the tab is not selected too */
  private swallowClick = false;

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
    this.cancelDrag(); // the elements below are about to be replaced
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
        tab.setAttribute("aria-label", `${s.key}\n${t.openCount(s.open, s.done)}\n${t.dragTab}`);
        tab.createSpan({ cls: "tp-tab-label", text: s.tags[0] });
        if (s.tags.length > 1) tab.createSpan({ cls: "tp-tab-sub", text: s.tags.slice(1).join(" ") });
        if (this.host.showCounts()) {
          const c = tab.createSpan({ cls: "tp-tab-count", text: String(s.open) });
          if (s.open === 0) c.addClass("is-zero");
        }
        if (activeKey === s.key) tab.addClass("is-active");
        tab.addEventListener("click", () => {
          if (this.swallowClick) { this.swallowClick = false; return; }
          this.host.onSelect(this.view, s.key);
        });
        tab.addEventListener("pointerdown", (e) => this.onTabDown(e, tab, inner, s.key));
        tab.addEventListener("pointermove", this.onTabMove);
        tab.addEventListener("pointerup", this.onTabUp);
        tab.addEventListener("pointercancel", () => this.cancelDrag());
      }

      const add = inner.createDiv({ cls: "tp-tab-add clickable-icon" });
      setIcon(add, "plus");
      add.setAttribute("aria-label", activeKey ? t.addTaskToSection : t.addTaskToEnd);
      add.addEventListener("click", () => this.host.onAdd(this.view));
    }
  }

  // ---- Reordering ----
  private onTabDown(e: PointerEvent, el: HTMLElement, inner: HTMLElement, key: string): void {
    if (e.button !== 0 || this.drag || !this.host.canReorder(this.view)) return;
    this.drag = { key, el, inner, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, active: false, beforeKey: null, marker: null };
    try { el.setPointerCapture(e.pointerId); } catch { /* pointer capture is unsupported in some environments */ }
  }

  private onTabMove = (e: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      if (Math.abs(e.clientX - drag.startX) < DRAG_THRESHOLD && Math.abs(e.clientY - drag.startY) < DRAG_THRESHOLD) return;
      drag.active = true;
      drag.el.addClass("is-tab-dragging");
      document.body.classList.add("tp-tab-dragging");
      drag.marker = drag.inner.createDiv({ cls: "tp-tab-marker" });
    }
    e.preventDefault();
    this.updateDropTarget(drag, e.clientX, e.clientY);
  };

  private onTabUp = (e: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const { active, key, beforeKey } = drag;
    this.cancelDrag();
    if (!active) return;
    this.swallowClick = true;
    window.setTimeout(() => { this.swallowClick = false; }, 0);
    if (beforeKey !== key) this.host.onReorder(this.view, key, beforeKey);
  };

  /** Pick the gap the pointer sits in and park the marker there; tabs wrap, so match the row first */
  private updateDropTarget(drag: TabDrag, x: number, y: number): void {
    const tabs = Array.from(drag.inner.children).filter(
      (c): c is HTMLElement => c instanceof HTMLElement && c.hasClass("tp-tab") && !!c.dataset.key
    );
    if (tabs.length === 0) return;
    const rects = tabs.map((el) => el.getBoundingClientRect());
    let idx = tabs.length;
    for (let i = 0; i < tabs.length; i++) {
      const r = rects[i];
      if (y > r.bottom) continue; // a row above the pointer
      if (y < r.top || x < r.left + r.width / 2) { idx = i; break; }
    }
    drag.beforeKey = idx < tabs.length ? tabs[idx].dataset.key ?? null : null;
    const edge = idx < tabs.length ? rects[idx] : rects[rects.length - 1];
    const innerRect = drag.inner.getBoundingClientRect();
    if (!drag.marker) return;
    drag.marker.style.left = `${(idx < tabs.length ? edge.left : edge.right) - innerRect.left - 1}px`;
    drag.marker.style.top = `${edge.top - innerRect.top}px`;
    drag.marker.style.height = `${edge.height}px`;
  }

  private cancelDrag(): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    try { drag.el.releasePointerCapture(drag.pointerId); } catch { /* already released */ }
    drag.el.removeClass("is-tab-dragging");
    drag.marker?.remove();
    document.body.classList.remove("tp-tab-dragging");
  }

  destroy(): void {
    this.cancelDrag();
    for (const el of this.els) el.remove();
    this.els = [];
  }
}
