// Reading view: a post-processor that hides sections outside the active tab and folds runs of completed items
import { MarkdownPostProcessorContext } from "obsidian";
import { DocModel, parseDoc, sectionByKey } from "./model";
import { t } from "./i18n";

export interface ReadingHost {
  isTabsEnabled(path: string): boolean;
  isFoldEnabled(path: string): boolean;
  keepLast(): number;
  activeTab(path: string): string | null;
  expanded: Set<string>;
}

let cache: { text: string; model: DocModel } | null = null;
function modelFor(text: string): DocModel {
  if (cache && cache.text === text) return cache.model;
  const model = parseDoc(text.split("\n"));
  cache = { text, model };
  return model;
}

export function readingPostProcessor(host: ReadingHost) {
  return (el: HTMLElement, ctx: MarkdownPostProcessorContext): void => {
    const path = ctx.sourcePath;
    const tabs = host.isTabsEnabled(path);
    const fold = host.isFoldEnabled(path);
    if (!tabs && !fold) return;

    if (tabs) {
      const info = ctx.getSectionInfo(el);
      const active = host.activeTab(path);
      if (info && active) {
        const model = modelFor(info.text);
        const section = sectionByKey(model, active);
        if (section) {
          const hidden = !(info.lineEnd >= section.start && info.lineStart <= section.end);
          el.classList.toggle("tp-hidden", hidden);
        }
      }
    }

    if (fold) {
      const keep = host.keepLast();
      const lists = el.querySelectorAll("ul.contains-task-list, ol.contains-task-list");
      lists.forEach((ul) => {
        const items = Array.from(ul.children).filter((c) => c.tagName === "LI") as HTMLElement[];
        let run: HTMLElement[] = [];
        const flush = () => {
          if (run.length > keep) {
            const hiddenItems = run.slice(0, run.length - keep);
            const key = `${path}::${hiddenItems[0].textContent?.trim().slice(0, 80) ?? ""}`;
            const expanded = host.expanded.has(key);
            const toggle = createEl("li", {
              cls: "tp-fold-toggle tp-fold-toggle-reading " + (expanded ? "is-expanded" : "is-collapsed"),
            });
            const render = () => {
              const isExp = host.expanded.has(key);
              toggle.empty();
              toggle.createSpan({ cls: "tp-fold-arrow", text: isExp ? "▾" : "▸" });
              toggle.createSpan({
                cls: "tp-fold-label",
                text: isExp ? t.foldExpanded(run.length) : t.foldCollapsed(run.length, hiddenItems.length),
              });
              for (const li of hiddenItems) li.classList.toggle("tp-hidden", !isExp);
              toggle.classList.toggle("is-expanded", isExp);
              toggle.classList.toggle("is-collapsed", !isExp);
            };
            toggle.addEventListener("click", (e) => {
              e.preventDefault();
              if (host.expanded.has(key)) host.expanded.delete(key); else host.expanded.add(key);
              render();
            });
            ul.insertBefore(toggle, hiddenItems[0]);
            render();
          }
          run = [];
        };
        for (const li of items) {
          if (li.classList.contains("is-checked")) run.push(li); else flush();
        }
        flush();
      });
    }
  };
}
