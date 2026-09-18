// Notion-style block dragging: list items, paragraphs, headings and fenced blocks get a handle on hover (or on the cursor line on mobile);
// drag it elsewhere or onto a tab. Select several blocks first and they move together
// Pointer Events give mouse and touch a single code path
import { EditorView, ViewPlugin, ViewUpdate, PluginValue } from "@codemirror/view";
import { Platform, setIcon } from "obsidian";
import { getModel } from "./editor";
import { Block, DocModel, LineRange, blockAtLine, isBlank, sectionAtLine } from "./model";
import { MoveOptions, MoveTarget, isNoopMove, moveItem } from "./moves";
import { t } from "./i18n";

export interface DragHost {
  isDragEnabled(view: EditorView): boolean;
  dropOnTab(view: EditorView, model: DocModel, range: LineRange, tabKey: string, opts: MoveOptions): void;
}

interface DragState {
  range: LineRange;
  separate: boolean; // paragraphs and other non-list blocks keep blank lines around them and are not re-indented
  model: DocModel;
  docRef: unknown;
  pointerId: number;
  target: MoveTarget | null;
  tabKey: string | null;
  tabEl: HTMLElement | null;
}

const HANDLE_H = 20;
const HANDLE_GAP = 24;

class DragHandler implements PluginValue {
  handle: HTMLElement;
  indicator: HTMLElement;
  ghost: HTMLElement | null = null;
  hoverLine = -1;
  drag: DragState | null = null;
  scrollTimer: number | null = null;
  scrollDir = 0;

  constructor(readonly view: EditorView, readonly host: DragHost) {
    this.handle = createDiv({ cls: "tp-drag-handle", attr: { "aria-label": t.dragHandle } });
    setIcon(this.handle, "grip-vertical");
    this.indicator = createDiv({ cls: "tp-drop-indicator" });
    view.dom.appendChild(this.handle);
    view.dom.appendChild(this.indicator);

    view.dom.addEventListener("pointermove", this.onHover);
    view.dom.addEventListener("pointerleave", this.onLeave);
    view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
    this.handle.addEventListener("pointerdown", this.onHandleDown);
    this.handle.addEventListener("pointermove", this.onDragMove);
    this.handle.addEventListener("pointerup", this.onDragEnd);
    this.handle.addEventListener("pointercancel", this.onDragCancel);
  }

  update(u: ViewUpdate): void {
    // No hover on mobile: the handle follows the list item under the cursor
    if (!Platform.isMobile || this.drag) return;
    if (u.selectionSet || u.docChanged || u.viewportChanged || u.geometryChanged) {
      const line = u.state.doc.lineAt(u.state.selection.main.head).number - 1;
      u.view.requestMeasure({
        read: () => this.measureHandle(line),
        write: (m) => this.applyHandle(m),
      });
    }
  }

  destroy(): void {
    this.cancelDrag();
    this.view.dom.removeEventListener("pointermove", this.onHover);
    this.view.dom.removeEventListener("pointerleave", this.onLeave);
    this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
    this.handle.remove();
    this.indicator.remove();
  }

  // ---- Handle placement ----
  private measureHandle(lineIdx: number): { left: number; top: number; line: number } | null {
    if (!this.host.isDragEnabled(this.view)) return null;
    const model = getModel(this.view);
    const block = blockAtLine(model, lineIdx);
    // A list item only gets a handle on its first line; other blocks anchor the handle to their first line
    if (!block || (block.kind === "list" && block.start !== lineIdx)) return null;
    lineIdx = block.start;
    const doc = this.view.state.doc;
    if (lineIdx >= doc.lines) return null;
    const line = doc.line(lineIdx + 1);
    const coords = this.view.coordsAtPos(line.from);
    if (!coords) return null;
    const lineEl = this.lineElementAt(line.from);
    const lineRect = lineEl?.getBoundingClientRect();
    const editorRect = this.view.dom.getBoundingClientRect();
    let bulletX = lineRect ? lineRect.left : coords.left;
    if (lineEl) {
      const cs = getComputedStyle(lineEl);
      bulletX += (parseFloat(cs.paddingInlineStart) || 0) + (parseFloat(cs.textIndent) || 0);
    }
    const top = lineRect ? lineRect.top : coords.top;
    return {
      left: bulletX - editorRect.left - HANDLE_GAP,
      top: top - editorRect.top + (this.view.defaultLineHeight - HANDLE_H) / 2,
      line: lineIdx,
    };
  }

  private applyHandle(m: { left: number; top: number; line: number } | null): void {
    if (!m) { this.hideHandle(); return; }
    this.handle.style.left = `${m.left}px`;
    this.handle.style.top = `${m.top}px`;
    this.handle.classList.add("is-visible");
    this.hoverLine = m.line;
  }

  onHover = (e: PointerEvent): void => {
    if (this.drag || e.pointerType !== "mouse") return;
    if (!this.host.isDragEnabled(this.view)) { this.hideHandle(); return; }
    if ((e.target as HTMLElement).closest?.(".tp-drag-handle")) return;
    const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
    if (pos == null) { this.hideHandle(); return; }
    const line = this.view.state.doc.lineAt(pos);
    const lineIdx = line.number - 1;
    const lineEl = this.lineElementAt(line.from);
    const rect = lineEl?.getBoundingClientRect() ?? this.view.coordsAtPos(line.from);
    if (!rect) { this.hideHandle(); return; }
    const bottom = Math.min(rect.bottom, rect.top + this.view.defaultLineHeight * 1.6);
    if (e.clientY < rect.top - 2 || e.clientY > bottom + 2) { this.hideHandle(); return; }
    this.applyHandle(this.measureHandle(lineIdx));
  };

  onLeave = (): void => {
    if (!this.drag && !Platform.isMobile) this.hideHandle();
  };

  onScroll = (): void => {
    // Scrolling invalidates the handle position, so only hide it visually; keep hoverLine so an async scroll event cannot interrupt a press that just started
    if (!this.drag && !Platform.isMobile) this.handle.classList.remove("is-visible");
  };

  hideHandle(): void {
    this.handle.classList.remove("is-visible");
    this.hoverLine = -1;
  }

  lineElementAt(pos: number): HTMLElement | null {
    const dom = this.view.domAtPos(pos);
    const node = dom.node.instanceOf(HTMLElement) ? dom.node : dom.node.parentElement;
    return (node?.closest(".cm-line") as HTMLElement | null) ?? null;
  }

  // ---- Dragging ----
  onHandleDown = (e: PointerEvent): void => {
    if (e.button !== 0 || this.hoverLine < 0) return;
    e.preventDefault();
    e.stopPropagation();
    const model = getModel(this.view);
    const block = blockAtLine(model, this.hoverLine);
    if (!block) return;
    const { range, separate, count } = this.dragRange(model, block);
    this.drag = { range, separate, model, docRef: this.view.state.doc, pointerId: e.pointerId, target: null, tabKey: null, tabEl: null };
    try { this.handle.setPointerCapture(e.pointerId); } catch { /* pointer capture is unsupported in some environments */ }
    document.body.classList.add("tp-dragging");
    this.handle.classList.add("is-dragging");
    this.ghost = createDiv({ cls: "tp-drag-ghost" });
    const label = (blockAtLine(model, range.start)?.text ?? block.text).trim();
    const short = label.length > 60 ? label.slice(0, 60) + "…" : label || "…";
    this.ghost.setText(count > 1 ? `${short}  +${count - 1}` : short);
    document.body.appendChild(this.ghost);
    this.moveGhost(e.clientX, e.clientY);
    document.addEventListener("keydown", this.onKey, true);
    this.scrollTimer = window.setInterval(() => {
      if (this.scrollDir !== 0) this.view.scrollDOM.scrollTop += this.scrollDir * 8;
    }, 30);
  };

  /** The lines that move: the hovered block alone, or every block the selection touches when the hovered block is one of them */
  private dragRange(model: DocModel, block: Block): { range: LineRange; separate: boolean; count: number } {
    const sel = this.view.state.selection.main;
    const doc = this.view.state.doc;
    let start = block.start;
    let end = block.end;
    if (!sel.empty) {
      let a = doc.lineAt(sel.from).number - 1;
      let b = doc.lineAt(sel.to).number - 1;
      if (b > a && doc.lineAt(sel.to).from === sel.to) b--; // a selection ending at a line start does not include that line
      while (a < b && isBlank(model.lines[a])) a++;
      while (b > a && isBlank(model.lines[b])) b--;
      if (block.start <= b && block.end >= a) {
        start = Math.min(start, blockAtLine(model, a)?.start ?? a);
        end = Math.max(end, blockAtLine(model, b)?.end ?? b);
        // Stay inside the hovered block's section so tag lines never travel with a selection
        const section = sectionAtLine(model, block.start);
        const lo = section ? section.tagLine + 1 : model.frontmatterEnd + 1;
        const hi = section ? section.end : (model.sections[0]?.tagLine ?? model.lines.length) - 1;
        start = Math.max(start, lo);
        end = Math.min(end, hi);
      }
    }
    let count = 0;
    let allList = true;
    for (let l = start; l <= end; ) {
      const bl = blockAtLine(model, l);
      if (!bl) { l++; continue; }
      count++;
      if (bl.kind !== "list") allList = false;
      l = bl.end + 1;
    }
    const first = blockAtLine(model, start) ?? block;
    return { range: { start, end, indent: first.indent }, separate: !allList, count: Math.max(count, 1) };
  }

  moveGhost(x: number, y: number): void {
    if (!this.ghost) return;
    this.ghost.style.left = `${x + 14}px`;
    this.ghost.style.top = `${y + 10}px`;
  }

  onDragMove = (e: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.preventDefault();
    this.moveGhost(e.clientX, e.clientY);

    const sr = this.view.scrollDOM.getBoundingClientRect();
    this.scrollDir = e.clientY < sr.top + 36 ? -1 : e.clientY > sr.bottom - 36 ? 1 : 0;

    // Tabs as drop targets
    const leaf = this.view.dom.closest(".workspace-leaf");
    const under = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const tab = under?.closest(".tp-tab[data-key]") as HTMLElement | null;
    this.setTabTarget(null);
    if (tab && tab.dataset.key && leaf && leaf.contains(tab)) {
      this.setTabTarget(tab);
      drag.target = null;
      this.indicator.classList.remove("is-visible");
      return;
    }

    // Drop position inside the editor
    const pos = this.view.posAtCoords({ x: e.clientX, y: e.clientY }, false);
    if (pos == null) { drag.target = null; this.indicator.classList.remove("is-visible"); return; }
    const doc = this.view.state.doc;
    const line = doc.lineAt(pos);
    const lineIdx = line.number - 1;
    const over = blockAtLine(drag.model, lineIdx);
    let target: MoveTarget;
    let indicatorY: number;
    if (over) {
      const topC = this.view.coordsAtPos(doc.line(over.start + 1).from);
      const botC = this.view.coordsAtPos(doc.line(over.end + 1).to);
      const top = topC?.top ?? 0;
      const bottom = botC?.bottom ?? top + this.view.defaultLineHeight;
      const indent = over.kind === "list" ? over.indent : 0;
      if (e.clientY < (top + bottom) / 2) { target = { line: over.start, indent }; indicatorY = top; }
      else { target = { line: over.end + 1, indent }; indicatorY = bottom; }
    } else {
      const c = this.view.coordsAtPos(line.from);
      const top = c?.top ?? 0;
      const bottom = c?.bottom ?? top + this.view.defaultLineHeight;
      if (e.clientY < (top + bottom) / 2) { target = { line: lineIdx, indent: 0 }; indicatorY = top; }
      else { target = { line: lineIdx + 1, indent: 0 }; indicatorY = bottom; }
    }
    if (drag.separate) target.indent = drag.range.indent;
    if (isNoopMove(drag.range, target) || (target.line > drag.range.start && target.line <= drag.range.end + 1)) {
      drag.target = null;
      this.indicator.classList.remove("is-visible");
      return;
    }
    drag.target = target;
    const editorRect = this.view.dom.getBoundingClientRect();
    const lr = this.lineElementAt(line.from)?.getBoundingClientRect();
    this.indicator.style.left = `${(lr ? lr.left : editorRect.left + 40) - editorRect.left}px`;
    this.indicator.style.width = `${lr ? lr.width : editorRect.width - 80}px`;
    this.indicator.style.top = `${indicatorY - editorRect.top - 1}px`;
    this.indicator.classList.add("is-visible");
  };

  setTabTarget(el: HTMLElement | null): void {
    const drag = this.drag;
    if (!drag) return;
    if (drag.tabEl && drag.tabEl !== el) drag.tabEl.classList.remove("is-drop-target");
    drag.tabEl = el;
    drag.tabKey = el?.dataset.key ?? null;
    if (el) el.classList.add("is-drop-target");
  }

  onDragEnd = (e: PointerEvent): void => {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    const sameDoc = this.view.state.doc === drag.docRef;
    const { range, separate, model, target, tabKey } = drag;
    this.cancelDrag();
    if (!sameDoc) return;
    if (tabKey) this.host.dropOnTab(this.view, model, range, tabKey, { separate });
    else if (target) moveItem(this.view, model, range, target, { separate });
  };

  onDragCancel = (): void => {
    this.cancelDrag();
  };

  onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.drag) {
      e.preventDefault();
      e.stopPropagation();
      this.cancelDrag();
    }
  };

  cancelDrag(): void {
    if (!this.drag) return;
    const { pointerId } = this.drag;
    this.setTabTarget(null);
    this.drag = null;
    try { this.handle.releasePointerCapture(pointerId); } catch { /* already released */ }
    document.body.classList.remove("tp-dragging");
    this.handle.classList.remove("is-dragging");
    this.indicator.classList.remove("is-visible");
    this.ghost?.remove();
    this.ghost = null;
    this.scrollDir = 0;
    if (this.scrollTimer != null) { window.clearInterval(this.scrollTimer); this.scrollTimer = null; }
    document.removeEventListener("keydown", this.onKey, true);
    if (!Platform.isMobile) this.hideHandle();
  }
}

export function createDragPlugin(host: DragHost) {
  return ViewPlugin.define((view) => new DragHandler(view, host));
}
