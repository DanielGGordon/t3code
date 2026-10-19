import type { KeybindingCommand } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useMemo } from "react";
import { create } from "zustand";

import { usePrimarySettings } from "../hooks/useSettings";
import { formatShortcutLabel } from "../keybindings";
import { useProjects } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { primaryServerKeybindingsAtom } from "../state/server";
import { collectMyShortcuts, commandLabel } from "./settings/KeybindingsSettings.logic";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Kbd } from "./ui/kbd";

const useMyShortcutsOpen = create<{ open: boolean }>(() => ({ open: false }));

/** Opens the list of shortcuts the user bound themselves; toggles when already open. */
export function toggleMyShortcuts() {
  useMyShortcutsOpen.setState((state) => ({ open: !state.open }));
}

export function MyShortcutsDialogHost() {
  const open = useMyShortcutsOpen((state) => state.open);
  return open ? <MyShortcutsDialog /> : null;
}

function MyShortcutsDialog() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const slots = usePrimarySettings((settings) => settings.newThreadProjectSlots);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  const shortcuts = useMemo(() => collectMyShortcuts(keybindings), [keybindings]);

  const describe = (command: KeybindingCommand): string => {
    const raw = String(command);
    if (raw.startsWith("chat.newInProject.")) {
      const slot = raw.slice("chat.newInProject.".length) as keyof typeof slots;
      const project = projects.find(
        (candidate) =>
          candidate.environmentId === primaryEnvironmentId && candidate.id === slots[slot],
      );
      return project
        ? `New thread in ${project.title}`
        : `New thread in project slot ${slot} (unset)`;
    }
    return commandLabel(command);
  };

  return (
    <Dialog open onOpenChange={(open) => useMyShortcutsOpen.setState({ open })}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>My shortcuts</DialogTitle>
          <DialogDescription>
            Shortcuts you added or changed. Edit them in Settings → Keybindings.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {shortcuts.length === 0 ? (
            <p className="text-sm text-muted-foreground">You have no custom shortcuts yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {shortcuts.map((shortcut) => (
                <li key={shortcut.command} className="flex items-center justify-between gap-4">
                  <span className="min-w-0 truncate text-sm">{describe(shortcut.command)}</span>
                  <span className="flex shrink-0 gap-1">
                    {shortcut.keys.map((key, index) => (
                      <Kbd key={key}>{formatShortcutLabel(shortcut.shortcuts[index]!)}</Kbd>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
