import type { Notification } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { serverEnvironment } from "./server";

/**
 * Open external notifications on the primary environment, newest first, or
 * null until the first snapshot arrives. The server re-sends the whole list on
 * every change from any browser, so a dismiss elsewhere shows up here too.
 */
export const primaryNotificationsAtom = Atom.make((get): ReadonlyArray<Notification> | null => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) {
    return null;
  }
  return Option.match(
    AsyncResult.value(get(serverEnvironment.notificationsLive({ environmentId, input: {} }))),
    { onNone: () => null, onSome: (value) => value.notifications },
  );
}).pipe(Atom.withLabel("web-primary-notifications"));
