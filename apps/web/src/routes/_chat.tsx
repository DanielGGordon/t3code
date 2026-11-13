import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";

import { ThreadRouteView } from "../components/ThreadRouteView";
import { TileWallHost } from "../components/TileWall";
import { isAppModalPage } from "../components/sidebar/mainAppLocation";
import { SidebarInset } from "../components/ui/sidebar";
import { useTileWallStore } from "../tileWallStore";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { retainThreadFindForRoute } from "../components/chat/threadFindStore";
import { ThreadLinkPrompt } from "../components/promptLinks/ThreadLinkPrompt";
import { useShownThreadRouteTarget } from "../hooks/useShownThreadRouteTarget";
import { isCommandPaletteOpen } from "../commandPaletteBus";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useTouchLayout } from "../hooks/useTouchLayout";
import { useTwoFingerSwipe } from "../hooks/useTwoFingerSwipe";
import { startThreadInProjectSlot } from "../shortcuts/chatRouteCommands";
import { MyShortcutsDialogHost } from "~/components/MyShortcutsDialog";
import { TouchGesturesDialogHost } from "~/components/TouchGesturesDialog";

/**
 * Touch layout (phones by default): two fingers up starts a new thread in
 * project slot 1, two fingers down in slot 2.
 */
function ChatRouteTouchGestures() {
  const handleNewThread = useNewThreadHandler();
  const touchLayout = useTouchLayout();
  useTwoFingerSwipe(touchLayout, {
    onSwipeUp: () => {
      if (!isCommandPaletteOpen()) startThreadInProjectSlot("1", handleNewThread);
    },
    onSwipeDown: () => {
      if (!isCommandPaletteOpen()) startThreadInProjectSlot("2", handleNewThread);
    },
  });
  return null;
}

function ChatRouteLayout() {
  // Render both routes here so draft promotion keeps the same ChatView mounted.
  const { shownTarget, modalOpen } = useShownThreadRouteTarget();
  const tileWallOpen = useTileWallStore((state) => state.open);
  return (
    <>
      <ChatRouteTouchGestures />
      <MyShortcutsDialogHost />
      <TouchGesturesDialogHost />
      {shownTarget?.kind === "server" && !modalOpen ? (
        <ThreadLinkPrompt threadRef={shownTarget.threadRef} />
      ) : null}
      {shownTarget ? (
        <ThreadRouteView target={shownTarget} background={modalOpen} />
      ) : modalOpen ? (
        <SidebarInset className="h-dvh" />
      ) : (
        <Outlet />
      )}
      <TileWallHost open={tileWallOpen && !modalOpen} />
      {modalOpen ? <Outlet /> : null}
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context, location }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
    return { appModalPage: isAppModalPage(location.pathname) };
  },
  component: ChatRouteLayout,
  // Every match carries the whole location's params, so this layout sees the thread route's too.
  onEnter: ({ context, params }) => retainThreadFindForRouteMatch(context.appModalPage, params),
  onStay: ({ context, params }) => retainThreadFindForRouteMatch(context.appModalPage, params),
  onLeave: () => retainThreadFindForRoute({ modalPage: false, threadRef: null }),
});

function retainThreadFindForRouteMatch(
  modalPage: boolean,
  params: Partial<Record<"environmentId" | "threadId", string>>,
) {
  const target = resolveThreadRouteTarget(params);
  retainThreadFindForRoute({
    modalPage,
    threadRef: target?.kind === "server" ? target.threadRef : null,
  });
}
