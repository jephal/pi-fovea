// Settings overlay for pi-fovea. Deliberately mirrors pi-fabric's
// settings component structure (SettingsList in a bordered Container,
// SelectList submenus, dotted-id coercion) so both extensions feel like one
// settings surface. Persistence: fovea.json under the pi agent dir, with a
// project override at <repo>/.pi/fovea.json for trusted projects.

import {
  DynamicBorder,
  getAgentDir,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Component,
  SelectList,
  type SelectItem,
  type SelectListLayoutOptions,
  type SelectListTheme,
  SettingsList,
  type SettingItem,
  type SettingsListTheme,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import {
  buildPartialFromId,
  loadFoveaConfig,
  saveFoveaConfig,
  type FoveaConfig,
} from "../core/config.js";

const BOOLEANS = ["true", "false"] as const;
const BUDGETS = [256, 512, 1024, 2048, 4096, 8192] as const;
const THRESHOLDS = [1, 2, 3, 5, 8, 13] as const;

const SELECT_LAYOUT: SelectListLayoutOptions = {
  minPrimaryColumnWidth: 12,
  maxPrimaryColumnWidth: 32,
};

type SettingsSubmenu = (currentValue: string, done: (selectedValue?: string) => void) => Component;

const settingsListTheme = (theme: Theme): SettingsListTheme => ({
  label: (text, selected) => (selected ? theme.fg("accent", text) : text),
  value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
  description: (text) => theme.fg("dim", text),
  cursor: theme.fg("accent", "→ "),
  hint: (text) => theme.fg("dim", text),
});

const selectListTheme = (theme: Theme): SelectListTheme => ({
  selectedPrefix: (text) => theme.fg("accent", text),
  selectedText: (text) => theme.fg("accent", text),
  description: (text) => theme.fg("muted", text),
  scrollInfo: (text) => theme.fg("muted", text),
  noMatch: (text) => theme.fg("muted", text),
});

class SelectSubmenu extends Container {
  readonly selectList: SelectList;

  constructor(
    theme: Theme,
    title: string,
    description: string | undefined,
    options: SelectItem[],
    currentValue: string,
    onSelect: (value: string) => void,
    onCancel: () => void,
  ) {
    super();
    this.addChild(new Text(theme.bold(theme.fg("accent", title)), 0, 0));
    if (description) {
      this.addChild(new Spacer(1));
      this.addChild(new Text(theme.fg("muted", description), 0, 0));
    }
    this.addChild(new Spacer(1));
    this.selectList = new SelectList(
      options,
      Math.min(options.length, 10),
      selectListTheme(theme),
      SELECT_LAYOUT,
    );
    const index = options.findIndex((option) => option.value === currentValue);
    if (index !== -1) this.selectList.setSelectedIndex(index);
    this.selectList.onSelect = (item) => onSelect(item.value);
    this.selectList.onCancel = onCancel;
    this.addChild(this.selectList);
    this.addChild(new Spacer(1));
    this.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to go back"), 0, 0));
  }

  handleInput(data: string): void {
    this.selectList.handleInput(data);
  }
}

const numericSubmenu = (
  theme: Theme,
  values: readonly number[],
  title: string,
  description: string,
): SettingsSubmenu => (currentValue, done) => {
  const options: SelectItem[] = values.map((v) => ({ value: String(v), label: String(v) }));
  if (!options.some((o) => o.value === currentValue)) {
    options.unshift({ value: currentValue, label: currentValue });
  }
  return new SelectSubmenu(
    theme,
    title,
    description,
    options,
    currentValue,
    (value) => done(value),
    () => done(),
  );
};

class FoveaSettingsComponent extends Container {
  readonly settingsList: SettingsList;

  constructor(
    theme: Theme,
    items: SettingItem[],
    onChange: (id: string, newValue: string) => void,
    onCancel: () => void,
  ) {
    super();
    this.addChild(new DynamicBorder((text) => theme.fg("border", text)));
    this.settingsList = new SettingsList(items, 10, settingsListTheme(theme), onChange, onCancel, {
      enableSearch: true,
    });
    this.addChild(this.settingsList);
    this.addChild(new DynamicBorder((text) => theme.fg("border", text)));
  }

  handleInput(data: string): void {
    this.settingsList.handleInput(data);
  }
}

const setting = (
  id: string,
  label: string,
  currentValue: string,
  rest: { description?: string; values?: readonly string[]; submenu?: SettingsSubmenu } = {},
): SettingItem => {
  const item: SettingItem = { id, label, currentValue };
  if (rest.description !== undefined) item.description = rest.description;
  if (rest.values !== undefined) item.values = [...rest.values];
  if (rest.submenu !== undefined) item.submenu = rest.submenu;
  return item;
};

const coerceValue = (id: string, value: string, config: FoveaConfig): unknown => {
  const segments = id.split(".");
  let current: unknown = config;
  for (const s of segments) {
    if (typeof current !== "object" || current === null) return value;
    current = (current as Record<string, unknown>)[s];
  }
  if (typeof current === "boolean") return value === "true";
  if (typeof current === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? n : current;
  }
  return value;
};

const buildItems = (
  theme: Theme,
  config: FoveaConfig,
  apply: (id: string, value: unknown) => void,
): SettingItem[] => {
  const persist = (id: string, newValue: string): void => apply(id, coerceValue(id, newValue, config));
  return [
    setting("sync.enabled", "Turn sync", config.sync.enabled ? "true" : "false", {
      description:
        "After every turn, re-sync the graph and report anchor shifts or an unexpectedly warm blast radius. Default on; disable for quiet sessions. FOVEA_TURN_SYNC=off overrides.",
      values: BOOLEANS,
    }),
    setting("sync.budget", "Sync budget", String(config.sync.budget), {
      description: "Max tokens for the model-visible red message anchor-shift / warmed-file report.",
      submenu: numericSubmenu(theme, BUDGETS, "Sync budget", "Max tokens for the model-visible red sync report."),
    }),
    setting("sync.ackClean", "Ack clean turns", config.sync.ackClean ? "true" : "false", {
      description:
        "When true, a one-line ✓ message is shown after stable turns (still zero model tokens — display-only entry). Default off: green is silent.",
      values: BOOLEANS,
    }),
    setting("sync.warmFileThreshold", "Warm file threshold", String(config.sync.warmFileThreshold), {
      description:
        "How many undisclosed files must warm up during sync to justify a red message. Higher = fewer interruptions; route anchor shifts always escalate.",
      submenu: numericSubmenu(theme, THRESHOLDS, "Warm file threshold", "Disclosed-file warming count that escalates sync to red."),
    }),
    setting("tools.defaultBudget", "Default tool budget", String(config.tools.defaultBudget), {
      description: "Token budget applied when a fovea_* tool call omits maxTokens.",
      submenu: numericSubmenu(theme, BUDGETS, "Default tool budget", "Fallback maxTokens for fovea tools."),
    }),
  ];
};

export interface FoveaSettingsDeps {
  /** Re-read config after a change (tool executors hold a per-root cache). */
  onConfigApplied?: () => void;
}

export const openFoveaSettings = async (
  context: ExtensionContext,
  deps: FoveaSettingsDeps = {},
): Promise<void> => {
  if (context.mode !== "tui") {
    context.ui.notify("Fovea settings are available in TUI mode", "warning");
    return;
  }
  const agentDir = getAgentDir();
  const scopes = {
    cwd: context.cwd,
    agentDir,
    projectTrusted: context.isProjectTrusted(),
  };
  let config = loadFoveaConfig(scopes);
  let dirty = false;

  const apply = (id: string, value: unknown): void => {
    try {
      saveFoveaConfig(scopes, buildPartialFromId(id, value));
    } catch (error) {
      context.ui.notify(
        `Failed to save Fovea settings: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return;
    }
    config = applyPartialLocal(config, id, value);
    dirty = true;
    deps.onConfigApplied?.();
  };

  await context.ui.custom<void>((_tui, theme, _keybindings, done) => {
    const items = buildItems(theme, config, apply);
    return new FoveaSettingsComponent(
      theme,
      items,
      (id, newValue) => apply(id, coerceValue(id, newValue, config)),
      () => done(),
    );
  });

  if (dirty) context.ui.notify("Fovea settings saved.", "info");
};

// Local in-place merge so subsequent edits in the same overlay start from the
// already-saved value (config is reloaded from disk on open).
const applyPartialLocal = (config: FoveaConfig, id: string, value: unknown): FoveaConfig => {
  const next: FoveaConfig = {
    sync: { ...config.sync },
    tools: { ...config.tools },
  };
  const segments = id.split(".");
  let target: Record<string, unknown> = next as unknown as Record<string, unknown>;
  for (let i = 0; i < segments.length - 1; i++) {
    target = target[segments[i]!] as Record<string, unknown>;
  }
  target[segments[segments.length - 1]!] = value;
  return next;
};

