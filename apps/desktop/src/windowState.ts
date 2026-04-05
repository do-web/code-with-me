import * as FS from "node:fs";
import type { BrowserWindow, Rectangle } from "electron";

interface WindowState {
  bounds: Rectangle;
  isMaximized: boolean;
}

const SAVE_DEBOUNCE_MS = 500;

/**
 * Manages persisting and restoring window bounds + maximized state
 * across app restarts via a simple JSON file.
 */
export function createWindowStateManager(filePath: string, defaults: Rectangle) {
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  function load(): WindowState {
    try {
      const raw = FS.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<WindowState>;

      if (
        parsed.bounds &&
        typeof parsed.bounds.x === "number" &&
        typeof parsed.bounds.y === "number" &&
        typeof parsed.bounds.width === "number" &&
        typeof parsed.bounds.height === "number"
      ) {
        return {
          bounds: parsed.bounds,
          isMaximized: parsed.isMaximized === true,
        };
      }
    } catch {
      // File doesn't exist or is corrupt — use defaults.
    }

    return { bounds: defaults, isMaximized: false };
  }

  function save(window: BrowserWindow): void {
    const isMaximized = window.isMaximized();
    // Always store the *normal* (non-maximized) bounds so we can restore
    // to a sensible size when un-maximizing.
    const bounds = isMaximized ? window.getNormalBounds() : window.getBounds();

    const state: WindowState = { bounds, isMaximized };

    try {
      FS.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
    } catch {
      // Silently ignore write errors (e.g. read-only fs).
    }
  }

  function scheduleSave(window: BrowserWindow): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save(window), SAVE_DEBOUNCE_MS);
  }

  /**
   * Attaches move/resize/maximize/close listeners that persist state.
   * Call once after window creation.
   */
  function track(window: BrowserWindow): void {
    window.on("resize", () => scheduleSave(window));
    window.on("move", () => scheduleSave(window));
    window.on("maximize", () => save(window));
    window.on("unmaximize", () => save(window));
    window.on("close", () => {
      if (saveTimer) clearTimeout(saveTimer);
      save(window);
    });
  }

  return { load, track };
}
