import type {
  GeminiSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderModel,
} from "@codewithme/contracts";
import { Effect, Equal, Layer, Option, Result, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { ServerSettingsError } from "@codewithme/contracts";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import {
  buildServerProvider,
  DEFAULT_TIMEOUT_MS,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot";
import { makeManagedServerProvider } from "../makeManagedServerProvider";
import { GeminiProvider } from "../Services/GeminiProvider";
import { ServerSettingsService } from "../../serverSettings";

const PROVIDER = "gemini" as const;

const EMPTY_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

/** Slugs to exclude from dynamic model discovery. */
const EXCLUDED_MODEL_PATTERNS = [
  "api-key",
  "privileged",
  "super-duper",
  "customtools",
  "base",
  "computer-use",
  "cli",
  "credentials",
  "oauth",
  "tool-modify",
  "browser-agent",
  "mcp-client",
  "embedding",
];

/** Resolve the real binary path (follows symlinks, resolves `which`). */
function resolveGeminiBinaryPath(binaryPath: string): string | null {
  try {
    if (path.isAbsolute(binaryPath) && fs.existsSync(binaryPath)) {
      return fs.realpathSync(binaryPath);
    }
    const resolved = execFileSync("which", [binaryPath], { encoding: "utf-8" }).trim();
    return resolved ? fs.realpathSync(resolved) : null;
  } catch {
    return null;
  }
}

/** Find the Gemini CLI bundle directory from the resolved binary path. */
function findGeminiBundleDir(binaryPath: string): string | null {
  const resolved = resolveGeminiBinaryPath(binaryPath);
  if (!resolved) return null;

  // Walk up from the binary to find the package with a bundle/ dir
  // Typical: .npm-global/lib/node_modules/@google/gemini-cli/bundle/
  let dir = path.dirname(resolved);
  for (let i = 0; i < 6; i++) {
    const bundleDir = path.join(dir, "bundle");
    if (fs.existsSync(bundleDir) && fs.statSync(bundleDir).isDirectory()) {
      return bundleDir;
    }
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Extract valid model slugs from Gemini CLI bundle JS files.
 *
 * Strategy: look for `GEMINI_MODEL` constant declarations (e.g.
 * `var DEFAULT_GEMINI_MODEL = "gemini-2.5-pro"`) which are authoritative.
 * Falls back to a broader regex scan filtered through EXCLUDED_MODEL_PATTERNS.
 */
function discoverModelsFromBundle(binaryPath: string): ServerProviderModel[] {
  const bundleDir = findGeminiBundleDir(binaryPath);
  if (!bundleDir) return [];

  const models = new Set<string>();
  try {
    const files = fs.readdirSync(bundleDir).filter((f) => f.endsWith(".js"));
    for (const file of files) {
      const content = fs.readFileSync(path.join(bundleDir, file), "utf-8");

      // Primary: extract from GEMINI*MODEL constant declarations (authoritative)
      const constMatches = content.matchAll(
        /var\s+\w*GEMINI\w*MODEL\w*\s*=\s*"(gemini-[a-z0-9.-]+)"/g,
      );
      for (const match of constMatches) {
        const slug = match[1]!;
        if (EXCLUDED_MODEL_PATTERNS.some((p) => slug.includes(p))) continue;
        models.add(slug);
      }
    }
  } catch {
    return [];
  }

  return Array.from(models)
    .sort((a, b) => {
      // Sort: newest version first, pro before flash
      const aNum = parseFloat(a.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] ?? "0");
      const bNum = parseFloat(b.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] ?? "0");
      if (bNum !== aNum) return bNum - aNum;
      const aIsPro = a.includes("pro") ? 0 : 1;
      const bIsPro = b.includes("pro") ? 0 : 1;
      return aIsPro - bIsPro;
    })
    .map((slug) => ({
      slug,
      name: formatModelName(slug),
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    }));
}

/** Convert slug like "gemini-3.1-pro-preview" to "Gemini 3.1 Pro Preview". */
function formatModelName(slug: string): string {
  return slug
    .replace(/^gemini-/, "Gemini ")
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function getGeminiModelCapabilities(_model: string | null | undefined): ModelCapabilities {
  return EMPTY_CAPABILITIES;
}

const runGeminiCommand = Effect.fn("runGeminiCommand")(function* (args: ReadonlyArray<string>) {
  const geminiSettings = yield* Effect.service(ServerSettingsService).pipe(
    Effect.flatMap((service) => service.getSettings),
    Effect.map((settings) => settings.providers.gemini),
  );
  const command = ChildProcess.make(geminiSettings.binaryPath, [...args], {
    shell: process.platform === "win32",
  });
  return yield* spawnAndCollect(geminiSettings.binaryPath, command);
});

export const checkGeminiProviderStatus = Effect.fn("checkGeminiProviderStatus")(
  function* (): Effect.fn.Return<
    ServerProvider,
    ServerSettingsError,
    ChildProcessSpawner.ChildProcessSpawner | ServerSettingsService
  > {
    const geminiSettings = yield* Effect.service(ServerSettingsService).pipe(
      Effect.flatMap((service) => service.getSettings),
      Effect.map((settings) => settings.providers.gemini),
    );
    const checkedAt = new Date().toISOString();

    // Discover models dynamically from CLI bundle
    const discoveredModels = discoverModelsFromBundle(geminiSettings.binaryPath);
    const builtInModels = discoveredModels.length > 0 ? discoveredModels : [];
    const models = providerModelsFromSettings(builtInModels, PROVIDER, geminiSettings.customModels);

    if (!geminiSettings.enabled) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Gemini is disabled in CodeWithMe settings.",
        },
      });
    }

    // ── Version check ─────────────────────────────────────────────────

    const versionProbe = yield* runGeminiCommand(["--version"]).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return buildServerProvider({
        provider: PROVIDER,
        enabled: geminiSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: !isCommandMissingCause(error),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(error)
            ? "Gemini CLI (`gemini`) is not installed or not on PATH."
            : `Failed to execute Gemini CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
        },
      });
    }

    if (Option.isNone(versionProbe.success)) {
      return buildServerProvider({
        provider: PROVIDER,
        enabled: geminiSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "Gemini CLI is installed but failed to run. Timed out while running command.",
        },
      });
    }

    const version = versionProbe.success.value;
    const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);

    if (version.code !== 0) {
      const detail = detailFromResult(version);
      return buildServerProvider({
        provider: PROVIDER,
        enabled: geminiSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version: parsedVersion,
          status: "error",
          auth: { status: "unknown" },
          message: detail
            ? `Gemini CLI is installed but failed to run. ${detail}`
            : "Gemini CLI is installed but failed to run.",
        },
      });
    }

    return buildServerProvider({
      provider: PROVIDER,
      enabled: geminiSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "ready",
        auth: { status: "unknown" },
      },
    });
  },
);

export const GeminiProviderLive = Layer.effect(
  GeminiProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const checkProvider = checkGeminiProviderStatus().pipe(
      Effect.provideService(ServerSettingsService, serverSettings),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    return yield* makeManagedServerProvider<GeminiSettings>({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.gemini),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.gemini),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      checkProvider,
    });
  }),
);
