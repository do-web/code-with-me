import { Layer } from "effect";

import { SessionDiscoveryService, makeSessionDiscoveryService } from "./SessionDiscoveryService.ts";

export const SessionDiscoveryServiceLive = Layer.effect(
  SessionDiscoveryService,
  makeSessionDiscoveryService,
);
