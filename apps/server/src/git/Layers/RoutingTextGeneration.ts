/**
 * RoutingTextGeneration – Dispatches text generation requests to either the
 * Codex CLI or Claude CLI implementation based on the provider in each
 * request input.
 *
 * When `modelSelection.provider` is `"claudeAgent"` the request is forwarded to
 * the Claude layer; for any other value (including the default `undefined`) it
 * falls through to the Codex layer.
 *
 * If the primary provider fails, the request is automatically retried with the
 * other provider as a fallback.
 *
 * @module RoutingTextGeneration
 */
import { Effect, Layer, ServiceMap } from "effect";

import type { ClaudeModelSelection, CodexModelSelection } from "@codewithme/contracts";

import {
  TextGeneration,
  type TextGenerationProvider,
  type TextGenerationShape,
} from "../Services/TextGeneration.ts";
import { CodexTextGenerationLive } from "./CodexTextGeneration.ts";
import { ClaudeTextGenerationLive } from "./ClaudeTextGeneration.ts";

// ---------------------------------------------------------------------------
// Internal service tags so both concrete layers can coexist.
// ---------------------------------------------------------------------------

class CodexTextGen extends ServiceMap.Service<CodexTextGen, TextGenerationShape>()(
  "codewithme/git/Layers/RoutingTextGeneration/CodexTextGen",
) {}

class ClaudeTextGen extends ServiceMap.Service<ClaudeTextGen, TextGenerationShape>()(
  "codewithme/git/Layers/RoutingTextGeneration/ClaudeTextGen",
) {}

// ---------------------------------------------------------------------------
// Fallback model selections
// ---------------------------------------------------------------------------

const FALLBACK_CLAUDE_MODEL_SELECTION: ClaudeModelSelection = {
  provider: "claudeAgent",
  model: "claude-sonnet-4-6",
};

const FALLBACK_CODEX_MODEL_SELECTION: CodexModelSelection = {
  provider: "codex",
  model: "gpt-5-codex",
};

// ---------------------------------------------------------------------------
// Routing implementation
// ---------------------------------------------------------------------------

const makeRoutingTextGeneration = Effect.gen(function* () {
  const codex = yield* CodexTextGen;
  const claude = yield* ClaudeTextGen;

  const route = (provider?: TextGenerationProvider): TextGenerationShape =>
    provider === "claudeAgent" ? claude : codex;

  const fallbackRoute = (provider?: TextGenerationProvider): TextGenerationShape =>
    provider === "claudeAgent" ? codex : claude;

  const fallbackModelSelection = (provider?: TextGenerationProvider) =>
    provider === "claudeAgent" ? FALLBACK_CODEX_MODEL_SELECTION : FALLBACK_CLAUDE_MODEL_SELECTION;

  return {
    generateCommitMessage: (input) =>
      route(input.modelSelection.provider)
        .generateCommitMessage(input)
        .pipe(
          Effect.catchTag("TextGenerationError", () =>
            fallbackRoute(input.modelSelection.provider).generateCommitMessage({
              ...input,
              modelSelection: fallbackModelSelection(input.modelSelection.provider),
            }),
          ),
        ),
    generatePrContent: (input) =>
      route(input.modelSelection.provider)
        .generatePrContent(input)
        .pipe(
          Effect.catchTag("TextGenerationError", () =>
            fallbackRoute(input.modelSelection.provider).generatePrContent({
              ...input,
              modelSelection: fallbackModelSelection(input.modelSelection.provider),
            }),
          ),
        ),
    generateBranchName: (input) =>
      route(input.modelSelection.provider)
        .generateBranchName(input)
        .pipe(
          Effect.catchTag("TextGenerationError", () =>
            fallbackRoute(input.modelSelection.provider).generateBranchName({
              ...input,
              modelSelection: fallbackModelSelection(input.modelSelection.provider),
            }),
          ),
        ),
    generateThreadTitle: (input) =>
      route(input.modelSelection.provider)
        .generateThreadTitle(input)
        .pipe(
          Effect.catchTag("TextGenerationError", () =>
            fallbackRoute(input.modelSelection.provider).generateThreadTitle({
              ...input,
              modelSelection: fallbackModelSelection(input.modelSelection.provider),
            }),
          ),
        ),
  } satisfies TextGenerationShape;
});

const InternalCodexLayer = Layer.effect(
  CodexTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(CodexTextGenerationLive));

const InternalClaudeLayer = Layer.effect(
  ClaudeTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(ClaudeTextGenerationLive));

export const RoutingTextGenerationLive = Layer.effect(
  TextGeneration,
  makeRoutingTextGeneration,
).pipe(Layer.provide(InternalCodexLayer), Layer.provide(InternalClaudeLayer));
