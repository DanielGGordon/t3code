import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { ArchiveIcon, ArchiveRestoreIcon, PinIcon, PinOffIcon } from "lucide-react";
import type { KeyboardEvent } from "react";

import { resolveShortcutCommand } from "../keybindings";

import { cn } from "~/lib/utils";
import { Button } from "./ui/button";

/** The thread pin shortcut, which pins the highlighted row in a project list. */
export function isProjectPinShortcut(
  event: KeyboardEvent,
  keybindings: ResolvedKeybindingsConfig,
): boolean {
  return (
    resolveShortcutCommand(event.nativeEvent, keybindings, {
      platform: navigator.platform,
      context: { modelPickerOpen: false, editableFocus: true },
    }) === "thread.pin"
  );
}

/** The settle shortcut, which archives or unarchives the highlighted row in a project list. */
export function isProjectArchiveShortcut(
  event: KeyboardEvent,
  keybindings: ResolvedKeybindingsConfig,
): boolean {
  return (
    resolveShortcutCommand(event.nativeEvent, keybindings, {
      platform: navigator.platform,
      context: { modelPickerOpen: false, editableFocus: true },
    }) === "thread.settle"
  );
}

/**
 * Pin toggle for a project row in a menu or list. A pinned project always shows its pin;
 * an unpinned one shows it only on the highlighted row. Keyboard users get a shortcut
 * from the list that hosts it, so the button stays out of the tab order.
 */
export function ProjectPinButton(props: {
  readonly name: string;
  readonly pinned: boolean;
  readonly onToggle: () => void;
  readonly shortcutLabel?: string | null;
}) {
  const action = `${props.pinned ? "Unpin" : "Pin"} ${props.name}`;
  return (
    <span
      className={cn(
        "group/pin ml-auto flex",
        !props.pinned && "opacity-0 in-data-highlighted:opacity-100 pointer-coarse:opacity-100",
      )}
    >
      <Button
        size="icon-xs"
        variant="ghost-muted"
        tabIndex={-1}
        aria-hidden="true"
        title={props.shortcutLabel ? `${action} (${props.shortcutLabel})` : action}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          props.onToggle();
        }}
      >
        {props.pinned ? (
          <>
            <PinIcon className="size-3.5 group-hover/pin:hidden" />
            <PinOffIcon className="hidden size-3.5 group-hover/pin:block" />
          </>
        ) : (
          <PinIcon className="size-3.5" />
        )}
      </Button>
    </span>
  );
}

/**
 * Archive toggle for a project row, beside the pin. An archived row always shows its
 * unarchive button; an open one shows archive only on the highlighted row.
 */
export function ProjectArchiveButton(props: {
  readonly name: string;
  readonly archived: boolean;
  readonly onToggle: () => void;
  readonly shortcutLabel?: string | null;
}) {
  const action = `${props.archived ? "Unarchive" : "Archive"} ${props.name}`;
  return (
    <span
      className={cn(
        "flex",
        props.archived
          ? "ml-auto"
          : "opacity-0 in-data-highlighted:opacity-100 pointer-coarse:opacity-100",
      )}
    >
      <Button
        size="icon-xs"
        variant="ghost-muted"
        tabIndex={-1}
        aria-hidden="true"
        title={props.shortcutLabel ? `${action} (${props.shortcutLabel})` : action}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          props.onToggle();
        }}
      >
        {props.archived ? (
          <ArchiveRestoreIcon className="size-3.5" />
        ) : (
          <ArchiveIcon className="size-3.5" />
        )}
      </Button>
    </span>
  );
}
