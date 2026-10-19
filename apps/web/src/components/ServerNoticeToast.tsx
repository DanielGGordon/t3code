import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef } from "react";

import { primaryServerNoticeAtom } from "../state/server";
import { toastManager } from "./ui/toast";

/** A notice usually announces a restart, so it should outlast the reconnect that follows. */
const NOTICE_TOAST_TIMEOUT_MS = 30_000;

/** Shows each operator notice (`t3 notice`) published to the server once. */
export function ServerNoticeToast() {
  const notice = useAtomValue(primaryServerNoticeAtom);
  const lastShownIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (notice === null || lastShownIdRef.current === notice.id) {
      return;
    }
    lastShownIdRef.current = notice.id;
    toastManager.add({
      type: "warning",
      title: notice.message,
      timeout: NOTICE_TOAST_TIMEOUT_MS,
    });
  }, [notice]);

  return null;
}
