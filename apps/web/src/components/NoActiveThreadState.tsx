import { useEffect, useRef } from "react";
import { PanelLeftIcon } from "lucide-react";

import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset, useSidebar, useSidebarVisibility } from "./ui/sidebar";
import { isElectron } from "../env";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

export function NoActiveThreadState() {
  const { isMobile, setOpen, setOpenMobile } = useSidebar();
  const sidebarVisible = useSidebarVisibility();
  // On mobile the sidebar is an off-canvas sheet that defaults closed, which
  // leaves a phone user staring at an empty pane with no visible project list.
  // Open it once on arrival so the projects/threads list is the primary
  // surface; if the user dismisses it we don't force it back open.
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (!isMobile || autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    setOpenMobile(true);
  }, [isMobile, setOpenMobile]);

  const openSidebar = () => {
    if (isMobile) {
      setOpenMobile(true);
    } else {
      void setOpen(true);
    }
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header
          className={cn(
            "border-b border-border px-3 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
            isElectron ? "workspace-topbar drag-region" : "workspace-topbar",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          {isElectron ? (
            <span className="text-xs text-muted-foreground/50 wco:pr-[var(--workspace-native-controls-inset)]">
              No active thread
            </span>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
                No active thread
              </span>
            </div>
          )}
        </header>

        <Empty className="flex-1">
          <div className="w-full max-w-lg px-8 py-12">
            <EmptyHeader className="max-w-none">
              <EmptyTitle className="text-foreground text-xl">Pick a thread to continue</EmptyTitle>
              <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
                Select an existing thread or create a new one to get started.
              </EmptyDescription>
            </EmptyHeader>
            {!sidebarVisible && (
              <div className="mt-6 flex justify-center">
                <Button variant="outline" data-testid="browse-projects" onClick={openSidebar}>
                  <PanelLeftIcon />
                  Browse projects
                </Button>
              </div>
            )}
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
