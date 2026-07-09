import { useCallback, useSyncExternalStore } from "react";
import { syncBrowserChromeTheme } from "./useTheme";

/**
 * Color scheme is an axis independent of the light/dark preference in
 * {@link useTheme}. A scheme provides both a light and a dark palette (see the
 * `:root[data-scheme="…"]` blocks in index.css); the active light/dark mode
 * then selects which half applies. This keeps the OS light/dark switch and the
 * desktop `setTheme` IPC contract untouched.
 */
export type ColorScheme =
  | "default"
  | "solarized"
  | "dracula"
  | "gruvbox"
  | "catppuccin"
  | "tokyo-night";

export const COLOR_SCHEME_OPTIONS = [
  { value: "default", label: "Default" },
  { value: "solarized", label: "Solarized" },
  { value: "dracula", label: "Dracula" },
  { value: "gruvbox", label: "Gruvbox" },
  { value: "catppuccin", label: "Catppuccin" },
  { value: "tokyo-night", label: "Tokyo Night" },
] as const satisfies ReadonlyArray<{ value: ColorScheme; label: string }>;

const STORAGE_KEY = "t3code:colorScheme";
const DEFAULT_COLOR_SCHEME: ColorScheme = "default";
const VALID_SCHEMES = new Set<ColorScheme>(COLOR_SCHEME_OPTIONS.map((option) => option.value));

let listeners: Array<() => void> = [];
let lastScheme: ColorScheme | null = null;

function emitChange() {
  for (const listener of listeners) listener();
}

function hasSchemeStorage() {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

function isColorScheme(value: string | null): value is ColorScheme {
  return value !== null && VALID_SCHEMES.has(value as ColorScheme);
}

function getStored(): ColorScheme {
  if (!hasSchemeStorage()) return DEFAULT_COLOR_SCHEME;
  const raw = localStorage.getItem(STORAGE_KEY);
  return isColorScheme(raw) ? raw : DEFAULT_COLOR_SCHEME;
}

function applyColorScheme(scheme: ColorScheme, suppressTransitions = false) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (suppressTransitions) {
    root.classList.add("no-transitions");
  }
  if (scheme === "default") {
    delete root.dataset.scheme;
  } else {
    root.dataset.scheme = scheme;
  }
  syncBrowserChromeTheme();
  if (suppressTransitions) {
    // Force a reflow so the no-transitions class takes effect before removal
    // oxlint-disable-next-line no-unused-expressions
    root.offsetHeight;
    requestAnimationFrame(() => {
      root.classList.remove("no-transitions");
    });
  }
}

// Apply immediately on module load to prevent a flash of the default palette.
if (typeof document !== "undefined" && hasSchemeStorage()) {
  applyColorScheme(getStored());
}

// Global cross-tab listener so scheme changes propagate even when no component
// subscribes to `useColorScheme` (e.g. chat tabs that only mount `useTheme`).
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      applyColorScheme(getStored(), true);
      emitChange();
    }
  });
}

function getSnapshot(): ColorScheme {
  if (!hasSchemeStorage()) return DEFAULT_COLOR_SCHEME;
  const scheme = getStored();
  if (lastScheme === scheme) return lastScheme;
  lastScheme = scheme;
  return lastScheme;
}

function getServerSnapshot() {
  return DEFAULT_COLOR_SCHEME;
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  listeners.push(listener);

  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

export function useColorScheme() {
  const colorScheme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setColorScheme = useCallback((next: ColorScheme) => {
    if (!hasSchemeStorage()) return;
    localStorage.setItem(STORAGE_KEY, next);
    applyColorScheme(next, true);
    emitChange();
  }, []);

  return { colorScheme, setColorScheme } as const;
}
