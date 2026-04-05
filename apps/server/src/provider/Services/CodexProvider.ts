import { ServiceMap } from "effect";

import type { ServerProviderShape } from "./ServerProvider";

export interface CodexProviderShape extends ServerProviderShape {}

export class CodexProvider extends ServiceMap.Service<CodexProvider, CodexProviderShape>()(
  "codewithme/provider/Services/CodexProvider",
) {}
