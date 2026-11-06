import { useAtomMount } from "@effect/atom-react";
import { use } from "react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { createThreadVisitTracker } from "@t3tools/client-runtime/state/thread-visits";
import { type ScopedThreadRef } from "@t3tools/contracts";

import { useUiStateStore } from "../../uiStateStore";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { HiddenThreadViewContext } from "./backgroundThread";

const threadVisitTracker = createThreadVisitTracker({
  threadShellAtom: environmentThreadShells.threadShellAtom,
  visit: threadEnvironment.visit,
  markLocalVisit: (ref, visitedAt) =>
    useUiStateStore.getState().markThreadVisited(scopedThreadKey(ref), visitedAt),
});

// The visit watermark is the one part of the chat view that follows the
// shell's updatedAt, which ticks while a run streams. The tracker subscribes to
// it outside React, so ChatView keeps reading the quiet shell.
export function ThreadVisitWatermark(props: { readonly threadRef: ScopedThreadRef }) {
  // A view warmed up out of sight has not been seen.
  if (use(HiddenThreadViewContext)) return null;
  return <ThreadVisitTracker threadRef={props.threadRef} />;
}

function ThreadVisitTracker(props: { readonly threadRef: ScopedThreadRef }) {
  useAtomMount(threadVisitTracker(props.threadRef));
  return null;
}
