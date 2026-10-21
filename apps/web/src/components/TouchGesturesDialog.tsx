import type { NewThreadProjectSlot } from "@t3tools/contracts";
import { create } from "zustand";

import { usePrimarySettings } from "../hooks/useSettings";
import { useDriveMode } from "../hooks/useTouchLayout";
import { useProjects } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

const useTouchGesturesOpen = create<{ open: boolean }>(() => ({ open: false }));

export function openTouchGestures() {
  useTouchGesturesOpen.setState({ open: true });
}

export function TouchGesturesDialogHost() {
  const open = useTouchGesturesOpen((state) => state.open);
  return open ? <TouchGesturesDialog /> : null;
}

function TouchGesturesDialog() {
  const slots = usePrimarySettings((settings) => settings.newThreadProjectSlots);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  const driveMode = useDriveMode();

  const newChatIn = (slot: NewThreadProjectSlot): string => {
    const project = projects.find(
      (candidate) =>
        candidate.environmentId === primaryEnvironmentId && candidate.id === slots[slot],
    );
    return project
      ? `New chat in ${project.title}`
      : `New chat in project slot ${slot} (not set — pick it in Settings → Keybindings)`;
  };

  const gestures: ReadonlyArray<{ gesture: string; action: string }> = [
    { gesture: "Two fingers swipe up", action: newChatIn("1") },
    { gesture: "Two fingers swipe down", action: newChatIn("2") },
    { gesture: "Three-finger tap", action: "Show or hide the project list" },
    ...(driveMode
      ? [{ gesture: "Four-finger tap", action: "Show or hide all projects, full screen" }]
      : []),
    { gesture: "Swipe a chat left", action: "Snooze it" },
    {
      gesture: "Swipe a chat right",
      action: "Settle it (or un-settle / wake a settled or snoozed one)",
    },
    { gesture: "Press and hold a chat", action: "Open its menu" },
  ];

  return (
    <Dialog open onOpenChange={(open) => useTouchGesturesOpen.setState({ open })}>
      <DialogPopup className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Touch gestures</DialogTitle>
          <DialogDescription>What your fingers can do in the touch layout.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ul className="flex flex-col gap-3">
            {gestures.map(({ gesture, action }) => (
              <li key={gesture} className="flex flex-col gap-0.5">
                <span className="font-medium text-sm">{gesture}</span>
                <span className="text-muted-foreground text-sm">{action}</span>
              </li>
            ))}
          </ul>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
