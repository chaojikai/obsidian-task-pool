import { App, PluginSettingTab, Setting } from "obsidian";
import type TaskPoolPlugin from "./main";
import type { PinnedTabStyle } from "./pin";
import { t } from "./i18n";

export type Scope = "all" | "tabs" | "off";
export type TabsMode = "auto" | "list" | "off";

export interface TaskPoolSettings {
  keepLast: number;
  foldScope: Scope;
  tabsMode: TabsMode;
  enabledPaths: string[];
  frontmatterKey: string;
  showCounts: boolean;
  dragScope: Scope;
  autoArchive: boolean;
  activeTabs: Record<string, string>;
  pinnedPaths: string[];
  pinnedTabStyle: PinnedTabStyle;
  pinnedTabFront: boolean;
  pinnedTabStyleAll: boolean;
  pinnedTabIcon: string;
}

export const DEFAULT_SETTINGS: TaskPoolSettings = {
  keepLast: 3,
  foldScope: "all",
  tabsMode: "auto",
  enabledPaths: [],
  frontmatterKey: "task-tabs",
  showCounts: true,
  dragScope: "all",
  autoArchive: true,
  activeTabs: {},
  pinnedPaths: [],
  pinnedTabStyle: "icon",
  pinnedTabFront: true,
  pinnedTabStyleAll: true,
  pinnedTabIcon: "list-todo",
};

export class TaskPoolSettingTab extends PluginSettingTab {
  plugin: TaskPoolPlugin;
  constructor(app: App, plugin: TaskPoolPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = async () => {
      await this.plugin.saveSettings();
      this.plugin.refreshAll();
    };
    const scopeOptions = { all: t.scopeAll, tabs: t.scopeTabs, off: t.scopeOff };

    new Setting(containerEl).setName(t.sFold).setHeading();
    new Setting(containerEl)
      .setName(t.sKeepLast)
      .setDesc(t.sKeepLastDesc)
      .addSlider((sl) =>
        sl.setLimits(0, 10, 1).setValue(s.keepLast).onChange(async (v) => {
          s.keepLast = v;
          await save();
        })
      );
    new Setting(containerEl)
      .setName(t.sFoldScope)
      .setDesc(t.sFoldScopeDesc)
      .addDropdown((d) =>
        d.addOptions(scopeOptions).setValue(s.foldScope).onChange(async (v) => {
          s.foldScope = v as Scope;
          await save();
        })
      );
    new Setting(containerEl)
      .setName(t.sAutoArchive)
      .setDesc(t.sAutoArchiveDesc)
      .addToggle((tg) =>
        tg.setValue(s.autoArchive).onChange(async (v) => {
          s.autoArchive = v;
          await save();
        })
      );

    new Setting(containerEl).setName(t.sTabs).setHeading();
    new Setting(containerEl)
      .setName(t.sTabsMode)
      .setDesc(t.sTabsModeDesc)
      .addDropdown((d) =>
        d.addOptions({ auto: t.modeAuto, list: t.modeList, off: t.modeOff }).setValue(s.tabsMode).onChange(async (v) => {
          s.tabsMode = v as TabsMode;
          await save();
        })
      );
    new Setting(containerEl)
      .setName(t.sTabsPaths)
      .setDesc(t.sTabsPathsDesc)
      .addTextArea((ta) => {
        ta.inputEl.rows = 4;
        ta.inputEl.cols = 40;
        ta.setValue(s.enabledPaths.join("\n")).onChange(async (v) => {
          s.enabledPaths = v.split("\n").map((x) => x.trim()).filter(Boolean);
          await save();
        });
      });
    new Setting(containerEl)
      .setName(t.sTabsKey)
      .setDesc(t.sTabsKeyDesc)
      .addText((tx) =>
        tx.setValue(s.frontmatterKey).onChange(async (v) => {
          s.frontmatterKey = v.trim() || "task-tabs";
          await save();
        })
      );
    new Setting(containerEl).setName(t.sShowCounts).addToggle((tg) =>
      tg.setValue(s.showCounts).onChange(async (v) => {
        s.showCounts = v;
        await save();
      })
    );

    new Setting(containerEl).setName(t.sPin).setHeading();
    new Setting(containerEl)
      .setName(t.sPinPaths)
      .setDesc(t.sPinPathsDesc)
      .addTextArea((ta) => {
        ta.inputEl.rows = 3;
        ta.inputEl.cols = 40;
        ta.setValue(s.pinnedPaths.join("\n")).onChange(async (v) => {
          s.pinnedPaths = v.split("\n").map((x) => x.trim()).filter(Boolean);
          await save();
        });
      });
    new Setting(containerEl)
      .setName(t.sPinStyle)
      .setDesc(t.sPinStyleDesc)
      .addDropdown((d) =>
        d.addOptions({ icon: t.pinStyleIcon, compact: t.pinStyleCompact, default: t.pinStyleDefault }).setValue(s.pinnedTabStyle).onChange(async (v) => {
          s.pinnedTabStyle = v as PinnedTabStyle;
          await save();
        })
      );
    new Setting(containerEl)
      .setName(t.sPinFront)
      .setDesc(t.sPinFrontDesc)
      .addToggle((tg) =>
        tg.setValue(s.pinnedTabFront).onChange(async (v) => {
          s.pinnedTabFront = v;
          await save();
        })
      );
    new Setting(containerEl)
      .setName(t.sPinStyleAll)
      .setDesc(t.sPinStyleAllDesc)
      .addToggle((tg) =>
        tg.setValue(s.pinnedTabStyleAll).onChange(async (v) => {
          s.pinnedTabStyleAll = v;
          await save();
        })
      );
    new Setting(containerEl)
      .setName(t.sPinIcon)
      .setDesc(t.sPinIconDesc)
      .addText((tx) =>
        tx.setPlaceholder("list-todo").setValue(s.pinnedTabIcon).onChange(async (v) => {
          s.pinnedTabIcon = v.trim();
          await save();
        })
      );

    new Setting(containerEl).setName(t.sDrag).setHeading();
    new Setting(containerEl)
      .setName(t.sDragScope)
      .setDesc(t.sDragScopeDesc)
      .addDropdown((d) =>
        d.addOptions(scopeOptions).setValue(s.dragScope).onChange(async (v) => {
          s.dragScope = v as Scope;
          await save();
        })
      );
  }
}
