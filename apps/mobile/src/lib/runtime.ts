import { ManagedRuntime } from "effect";

import { remoteHttpClientLayer } from "@t3tools/client-runtime";

export const mobileRemoteHttpRuntime = ManagedRuntime.make(remoteHttpClientLayer(fetch));
