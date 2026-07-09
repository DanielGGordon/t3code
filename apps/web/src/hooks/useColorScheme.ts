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

function applyColorScheme(scheme: ColorScheme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (scheme === "default") {
    delete root.dataset.scheme;
  } else {
    root.dataset.scheme = scheme;
  }
  // The chrome/background surface color depends on the active palette, so keep
  // the native window chrome and the theme-color meta tag in sync.
  syncBrowserChromeTheme();
}

// Apply immediately on module load to prevent a flash of the default palette.
if (typeof document !== "undefined" && hasSchemeStorage()) {
  applyColorScheme(getStored());
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

  // Sync scheme changes made in other tabs.
  const handleStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      applyColorScheme(getStored());
      emitChange();
    }
  };
  window.addEventListener("storage", handleStorage);

  return () => {
    listeners = listeners.filter((l) => l !== listener);
    window.removeEventListener("storage", handleStorage);
  };
}

export function useColorScheme() {
  const colorScheme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setColorScheme = useCallback((next: ColorScheme) => {
    if (!hasSchemeStorage()) return;
    localStorage.setItem(STORAGE_KEY, next);
    applyColorScheme(next);
    emitChange();
  }, []);

  return { colorScheme, setColorScheme } as const;
}
