import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { RefreshCw, Search, SunMoon } from "lucide-react";
import * as Schema from "effect/Schema";
import { useEffect, useMemo, useRef, useState } from "react";

import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { T3_PIERRE_ICONS } from "~/pierre-icons";

import { useProjectEntriesQuery } from "./projectFilesQueryState";

interface FileBrowserPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  onOpenFile: (relativePath: string) => void;
}

const TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 7%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 12px;
  }
  button[data-type='item'] { border-radius: 5px; }
`;

const FILE_EXPLORER_INVERT_THEME_STORAGE_KEY = "t3code.fileExplorerInvertTheme";

function initialInvertExplorerTheme(): boolean {
  try {
    return getLocalStorageItem(FILE_EXPLORER_INVERT_THEME_STORAGE_KEY, Schema.Boolean) ?? false;
  } catch (error) {
    console.error(error);
    return false;
  }
}

function treePath(entry: ProjectEntry): string {
  return entry.kind === "directory" ? `${entry.path}/` : entry.path;
}

export default function FileBrowserPanel({
  environmentId,
  cwd,
  projectName,
  onOpenFile,
}: FileBrowserPanelProps) {
  const { resolvedTheme } = useTheme();
  const [invertTheme, setInvertTheme] = useState(initialInvertExplorerTheme);
  /* Theme applied to the file explorer: matches the app theme by default, or
   * the opposite mode of the active color scheme when inversion is toggled on. */
  const explorerTheme: "light" | "dark" = invertTheme
    ? resolvedTheme === "dark"
      ? "light"
      : "dark"
    : resolvedTheme;
  const entriesQuery = useProjectEntriesQuery(environmentId, cwd);
  const entries = entriesQuery.data?.entries ?? [];
  const entryKinds = useMemo(
    () => new Map(entries.map((entry) => [entry.path, entry.kind] as const)),
    [entries],
  );
  const entryKindsRef = useRef<ReadonlyMap<string, ProjectEntry["kind"]>>(entryKinds);
  const treePaths = useMemo(() => entries.map(treePath), [entries]);
  const previousTreePathsRef = useRef<readonly string[]>([]);

  const { model } = useFileTree({
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    initialExpansion: "closed",
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      const selectedPath = selectedPaths.at(-1)?.replace(/\/$/, "");
      if (selectedPath && entryKindsRef.current.get(selectedPath) === "file") {
        onOpenFile(selectedPath);
      }
    },
    paths: [],
    search: true,
    unsafeCSS: TREE_UNSAFE_CSS,
  });

  useEffect(() => {
    if (previousTreePathsRef.current === treePaths) return;
    entryKindsRef.current = entryKinds;
    previousTreePathsRef.current = treePaths;
    model.resetPaths(treePaths);
  }, [entryKinds, model, treePaths]);

  const fileCount = useMemo(
    () => entries.reduce((count, entry) => count + (entry.kind === "file" ? 1 : 0), 0),
    [entries],
  );

  const toggleInvertTheme = () => {
    setInvertTheme((current) => {
      const next = !current;
      try {
        setLocalStorageItem(FILE_EXPLORER_INVERT_THEME_STORAGE_KEY, next, Schema.Boolean);
      } catch (error) {
        console.error(error);
      }
      return next;
    });
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-file-browser-panel={`${environmentId}:${cwd}`}
      data-file-explorer-inverted={invertTheme ? "" : undefined}
      style={{ colorScheme: explorerTheme }}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-foreground">{projectName}</div>
          <div className="truncate text-[10px] leading-none text-muted-foreground">
            {entriesQuery.isPending && entriesQuery.data === null
              ? "Indexing…"
              : `${fileCount.toLocaleString()} files`}
            {entriesQuery.data?.truncated ? " · partial" : ""}
          </div>
        </div>
        <button
          type="button"
          className={cn(
            "rounded-md p-1.5 hover:bg-accent hover:text-foreground",
            invertTheme ? "text-foreground" : "text-muted-foreground",
          )}
          aria-label={invertTheme ? "Match app theme" : "Invert file explorer theme"}
          aria-pressed={invertTheme}
          title={invertTheme ? "Match app theme" : "Invert file explorer theme"}
          onClick={toggleInvertTheme}
        >
          <SunMoon className="size-3.5" />
        </button>
        <button
          type="button"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Search workspace files"
          onClick={() => model.openSearch()}
        >
          <Search className="size-3.5" />
        </button>
        <button
          type="button"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Refresh workspace files"
          onClick={entriesQuery.refresh}
        >
          <RefreshCw className={cn("size-3.5", entriesQuery.isPending && "animate-spin")} />
        </button>
      </div>
      {entriesQuery.error && entriesQuery.data === null ? (
        <div className="p-4 text-xs leading-relaxed text-destructive">{entriesQuery.error}</div>
      ) : (
        <FileTree
          model={model}
          aria-label={`${projectName} files`}
          className="min-h-0 flex-1 overflow-hidden"
          style={{
            colorScheme: explorerTheme,
            ["--trees-fg-override" as string]: "var(--foreground)",
          }}
        />
      )}
    </div>
  );
}
