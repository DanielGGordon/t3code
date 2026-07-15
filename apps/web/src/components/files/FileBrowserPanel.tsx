import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { Home, RefreshCw, RotateCcw, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { T3_PIERRE_ICONS } from "~/pierre-icons";

import { useProjectEntriesQuery } from "./projectFilesQueryState";

interface FileBrowserPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  reRooted: boolean;
  onRootChange: (cwd: string) => void;
  onRootReset: () => void;
  onOpenFile: (relativePath: string, cwd: string) => void;
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

function treePath(entry: ProjectEntry): string {
  return entry.kind === "directory" ? `${entry.path}/` : entry.path;
}

export default function FileBrowserPanel({
  environmentId,
  cwd,
  projectName,
  reRooted,
  onRootChange,
  onRootReset,
  onOpenFile,
}: FileBrowserPanelProps) {
  const { resolvedTheme } = useTheme();
  const showDotfiles = useClientSettings((settings) => settings.fileExplorerShowDotfiles);
  const entriesQuery = useProjectEntriesQuery(environmentId, cwd, showDotfiles);
  const [rootInput, setRootInput] = useState(cwd);
  useEffect(() => setRootInput(cwd), [cwd]);
  const applyRoot = () => {
    const nextRoot = rootInput.trim();
    if (nextRoot) onRootChange(nextRoot);
  };
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
        onOpenFile(selectedPath, cwd);
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
  const rootLabel = useMemo(() => {
    if (!reRooted) return projectName;
    const normalized = cwd.replace(/[\\/]+$/, "");
    return normalized.split(/[\\/]/).at(-1) || cwd;
  }, [cwd, projectName, reRooted]);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-file-browser-panel={`${environmentId}:${cwd}`}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium text-foreground" title={cwd}>
            {rootLabel}
          </div>
          <div className="truncate text-[10px] leading-none text-muted-foreground">
            {entriesQuery.isPending && entriesQuery.data === null
              ? "Indexing…"
              : `${fileCount.toLocaleString()} files`}
            {entriesQuery.data?.truncated ? " · partial" : ""}
          </div>
        </div>
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
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 py-1.5">
        <input
          value={rootInput}
          onChange={(event) => setRootInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") applyRoot();
          }}
          className="min-w-0 flex-1 rounded-md border border-border/70 bg-background px-2 py-1 text-[11px] text-foreground outline-none focus:border-ring"
          aria-label="File explorer root directory"
          title={cwd}
        />
        <button
          type="button"
          className="rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={applyRoot}
        >
          Apply
        </button>
        <button
          type="button"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Browse home directory"
          title="Home"
          onClick={() => onRootChange("~")}
        >
          <Home className="size-3.5" />
        </button>
        <button
          type="button"
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          aria-label="Reset file explorer to project directory"
          title="Reset to project"
          disabled={!reRooted}
          onClick={onRootReset}
        >
          <RotateCcw className="size-3.5" />
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
            colorScheme: resolvedTheme,
            ["--trees-fg-override" as string]: "var(--foreground)",
          }}
        />
      )}
    </div>
  );
}
