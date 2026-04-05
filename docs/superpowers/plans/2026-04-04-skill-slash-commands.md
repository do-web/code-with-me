# Skill Slash Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show Claude Code skills as autocomplete suggestions in the slash-command menu so users can invoke them as normal chat messages.

**Architecture:** Server reads SKILL.md frontmatter (name + description) from `~/.claude/skills/` and plugin paths, exposes them via `skills.list` / `skills.refresh` RPC. Web client fetches on mount, merges into the existing ComposerCommandMenu. Selection inserts `/{name} ` as prefix — sent as a plain message.

**Tech Stack:** Effect.js schemas + RPC, React, `yaml` package (already in lockfile via effect), TypeScript

---

## File Structure

| Action | File                                                   | Responsibility                                         |
| ------ | ------------------------------------------------------ | ------------------------------------------------------ |
| Create | `packages/contracts/src/skill.ts`                      | SkillEntry schema, error types                         |
| Modify | `packages/contracts/src/rpc.ts`                        | WS_METHODS + RPC definitions + WsRpcGroup registration |
| Modify | `packages/contracts/src/ipc.ts`                        | NativeApi `skills` section                             |
| Modify | `packages/contracts/src/index.ts`                      | Re-export skill module                                 |
| Create | `apps/server/src/skillDiscovery.ts`                    | Filesystem scan + frontmatter parse + caching          |
| Modify | `apps/server/src/ws.ts`                                | RPC handlers for skills.list / skills.refresh          |
| Modify | `apps/web/src/wsRpcClient.ts`                          | WsRpcClient `skills` section                           |
| Modify | `apps/web/src/wsNativeApi.ts`                          | NativeApi adapter `skills` section                     |
| Modify | `apps/web/src/composer-logic.ts`                       | Always trigger on `/` prefix (not just known commands) |
| Modify | `apps/web/src/components/chat/ComposerCommandMenu.tsx` | `type: "skill"` in union + rendering                   |
| Modify | `apps/web/src/components/ChatView.tsx`                 | Fetch skills, merge into menu items, handle selection  |

---

### Task 1: Contracts — SkillEntry Schema + Error Types

**Files:**

- Create: `packages/contracts/src/skill.ts`
- Modify: `packages/contracts/src/index.ts`

- [ ] **Step 1: Create skill.ts with SkillEntry schema and error types**

```typescript
// packages/contracts/src/skill.ts
import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

export const SkillSource = Schema.Literal("user", "plugin");
export type SkillSource = typeof SkillSource.Type;

export const SkillEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  source: SkillSource,
});
export type SkillEntry = typeof SkillEntry.Type;

export const SkillsListResult = Schema.Struct({
  skills: Schema.Array(SkillEntry),
});
export type SkillsListResult = typeof SkillsListResult.Type;

export class SkillsListError extends Schema.TaggedError<SkillsListError>()("SkillsListError", {
  message: Schema.String,
}) {}

export class SkillsRefreshError extends Schema.TaggedError<SkillsRefreshError>()(
  "SkillsRefreshError",
  { message: Schema.String },
) {}
```

- [ ] **Step 2: Re-export from contracts index**

Add to `packages/contracts/src/index.ts`:

```typescript
export * from "./skill";
```

- [ ] **Step 3: Run typecheck**

Run: `bun typecheck`
Expected: PASS — no errors

- [ ] **Step 4: Commit**

```bash
git add packages/contracts/src/skill.ts packages/contracts/src/index.ts
git commit -m "feat: add SkillEntry schema and error types to contracts"
```

---

### Task 2: Contracts — RPC Definitions

**Files:**

- Modify: `packages/contracts/src/rpc.ts:73-117` (WS_METHODS)
- Modify: `packages/contracts/src/rpc.ts:324-359` (WsRpcGroup)

- [ ] **Step 1: Add skill imports to rpc.ts**

Add to imports in `packages/contracts/src/rpc.ts`:

```typescript
import { SkillsListError, SkillsListResult, SkillsRefreshError } from "./skill";
```

- [ ] **Step 2: Add skill methods to WS_METHODS**

Add inside `WS_METHODS` object, after the server meta section:

```typescript
  // Skill methods
  skillsList: "skills.list",
  skillsRefresh: "skills.refresh",
```

- [ ] **Step 3: Add RPC definitions**

Add after `WsServerUpdateSettingsRpc` (line ~146):

```typescript
export const WsSkillsListRpc = Rpc.make(WS_METHODS.skillsList, {
  payload: Schema.Struct({}),
  success: SkillsListResult,
  error: SkillsListError,
});

export const WsSkillsRefreshRpc = Rpc.make(WS_METHODS.skillsRefresh, {
  payload: Schema.Struct({}),
  success: SkillsListResult,
  error: SkillsRefreshError,
});
```

- [ ] **Step 4: Register in WsRpcGroup**

Add `WsSkillsListRpc` and `WsSkillsRefreshRpc` to the `RpcGroup.make(...)` call:

```typescript
export const WsRpcGroup = RpcGroup.make(
  WsServerGetConfigRpc,
  WsServerRefreshProvidersRpc,
  WsServerUpsertKeybindingRpc,
  WsServerGetSettingsRpc,
  WsServerUpdateSettingsRpc,
  WsSkillsListRpc, // new
  WsSkillsRefreshRpc, // new
  WsProjectsSearchEntriesRpc,
  // ... rest unchanged
);
```

- [ ] **Step 5: Run typecheck**

Run: `bun typecheck`
Expected: FAIL — server ws.ts missing handler implementations (expected, we add them in Task 4)

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/rpc.ts
git commit -m "feat: add skills.list and skills.refresh RPC definitions"
```

---

### Task 3: Contracts — NativeApi Extension

**Files:**

- Modify: `packages/contracts/src/ipc.ts:125-186` (NativeApi interface)

- [ ] **Step 1: Add SkillsListResult import**

Add to imports in `packages/contracts/src/ipc.ts`:

```typescript
import { type SkillsListResult } from "./skill";
```

- [ ] **Step 2: Add skills section to NativeApi**

Add after the `server` section in `NativeApi` interface:

```typescript
skills: {
  list: () => Promise<SkillsListResult>;
  refresh: () => Promise<SkillsListResult>;
}
```

- [ ] **Step 3: Run typecheck**

Run: `bun typecheck`
Expected: FAIL — wsNativeApi.ts missing `skills` (expected, we add it in Task 6)

- [ ] **Step 4: Commit**

```bash
git add packages/contracts/src/ipc.ts
git commit -m "feat: add skills section to NativeApi interface"
```

---

### Task 4: Server — Skill Discovery Service

**Files:**

- Create: `apps/server/src/skillDiscovery.ts`

- [ ] **Step 1: Create skillDiscovery.ts**

```typescript
// apps/server/src/skillDiscovery.ts
import { Effect, Ref } from "effect";
import type { SkillEntry } from "@codewithme/contracts";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

function parseFrontmatter(content: string): { name?: string; description?: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match?.[1]) return null;
  try {
    const parsed: unknown = parseYaml(match[1]);
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    return {
      name: typeof obj.name === "string" ? obj.name.trim() : undefined,
      description: typeof obj.description === "string" ? obj.description.trim() : undefined,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Filesystem scanning
// ---------------------------------------------------------------------------

async function readSkillFile(
  skillMdPath: string,
  source: SkillEntry["source"],
): Promise<SkillEntry | null> {
  try {
    const content = await fs.readFile(skillMdPath, "utf-8");
    const fm = parseFrontmatter(content);
    if (!fm?.name || !fm?.description) return null;
    return { name: fm.name, description: fm.description, source };
  } catch {
    return null;
  }
}

async function scanDirectory(dir: string, source: SkillEntry["source"]): Promise<SkillEntry[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const results = await Promise.all(
      entries
        .filter((e) => e.isDirectory() || e.isSymbolicLink())
        .map((e) => readSkillFile(path.join(dir, e.name, "SKILL.md"), source)),
    );
    return results.filter((s): s is SkillEntry => s !== null);
  } catch {
    return [];
  }
}

async function getPluginSkillPaths(): Promise<string[]> {
  const installedPath = path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json");
  try {
    const raw = await fs.readFile(installedPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return [];
    const paths: string[] = [];
    for (const value of Object.values(parsed as Record<string, unknown>)) {
      if (typeof value === "object" && value !== null && "installPath" in value) {
        const installPath = (value as { installPath: unknown }).installPath;
        if (typeof installPath === "string") {
          paths.push(path.join(installPath, "skills"));
        }
      }
    }
    return paths;
  } catch {
    return [];
  }
}

async function scanAllSkills(): Promise<SkillEntry[]> {
  const userSkillsDir = path.join(os.homedir(), ".claude", "skills");
  const pluginSkillDirs = await getPluginSkillPaths();

  const [userSkills, ...pluginSkillArrays] = await Promise.all([
    scanDirectory(userSkillsDir, "user"),
    ...pluginSkillDirs.map((dir) => scanDirectory(dir, "plugin")),
  ]);

  // User skills win over plugin skills with the same name
  const seen = new Set<string>();
  const merged: SkillEntry[] = [];

  for (const skill of userSkills ?? []) {
    if (!seen.has(skill.name)) {
      seen.add(skill.name);
      merged.push(skill);
    }
  }
  for (const pluginSkills of pluginSkillArrays) {
    for (const skill of pluginSkills) {
      if (!seen.has(skill.name)) {
        seen.add(skill.name);
        merged.push(skill);
      }
    }
  }

  return merged.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Effect service
// ---------------------------------------------------------------------------

export class SkillDiscovery extends Effect.Service<SkillDiscovery>()("SkillDiscovery", {
  effect: Effect.gen(function* () {
    const cacheRef = yield* Ref.make<SkillEntry[]>([]);

    // Initial load
    yield* Effect.tryPromise({
      try: () => scanAllSkills(),
      catch: (error) => new Error(`Initial skill scan failed: ${String(error)}`),
    }).pipe(Effect.flatMap((skills) => Ref.set(cacheRef, skills)));

    const list = Ref.get(cacheRef);

    const refresh = Effect.gen(function* () {
      const skills = yield* Effect.tryPromise({
        try: () => scanAllSkills(),
        catch: (error) => new Error(`Skill refresh failed: ${String(error)}`),
      });
      yield* Ref.set(cacheRef, skills);
      return skills;
    });

    return { list, refresh };
  }),
}) {}

export const SkillDiscoveryLive = SkillDiscovery.Default;
```

- [ ] **Step 2: Run typecheck**

Run: `bun typecheck`
Expected: PASS for this file (server ws.ts will still fail until Task 5)

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/skillDiscovery.ts
git commit -m "feat: add SkillDiscovery service for filesystem skill scanning"
```

---

### Task 5: Server — RPC Handlers

**Files:**

- Modify: `apps/server/src/ws.ts`

- [ ] **Step 1: Add SkillDiscovery import**

Add to service imports in `apps/server/src/ws.ts`:

```typescript
import { SkillDiscovery } from "./skillDiscovery";
```

- [ ] **Step 2: Add SkillsListError and SkillsRefreshError to contract imports**

Update the `@codewithme/contracts` import to include:

```typescript
import {
  // ... existing imports
  SkillsListError,
  SkillsRefreshError,
  // ... rest
} from "@codewithme/contracts";
```

- [ ] **Step 3: Inject SkillDiscovery in WsRpcLayer**

Inside the `Effect.gen(function* () {` block at the top of `WsRpcLayer`, add:

```typescript
const skillDiscovery = yield * SkillDiscovery;
```

- [ ] **Step 4: Add RPC handlers**

Inside the `WsRpcGroup.of({...})` return object, add after the server methods:

```typescript
[WS_METHODS.skillsList]: (_input) =>
  observeRpcEffect(
    WS_METHODS.skillsList,
    skillDiscovery.list.pipe(
      Effect.map((skills) => ({ skills })),
      Effect.mapError((cause) =>
        new SkillsListError({ message: `Failed to list skills: ${String(cause)}` }),
      ),
    ),
    { "rpc.aggregate": "skills" },
  ),

[WS_METHODS.skillsRefresh]: (_input) =>
  observeRpcEffect(
    WS_METHODS.skillsRefresh,
    skillDiscovery.refresh.pipe(
      Effect.map((skills) => ({ skills })),
      Effect.mapError((cause) =>
        new SkillsRefreshError({ message: `Failed to refresh skills: ${String(cause)}` }),
      ),
    ),
    { "rpc.aggregate": "skills" },
  ),
```

- [ ] **Step 5: Provide SkillDiscoveryLive layer**

Find where `WsRpcLayer` is provided/composed (in `websocketRpcRouteLayer`). Add `SkillDiscoveryLive` to the layer composition. The exact location depends on how services are composed — look for `Layer.mergeAll` or `Layer.provide` patterns near the bottom of `ws.ts` and add the SkillDiscovery layer there.

If services are injected via the main app composition (e.g., in `main.ts` or `app.ts`), provide `SkillDiscoveryLive` there instead.

Reference: Check how other services like `ProviderRegistry` or `Keybindings` are provided.

- [ ] **Step 6: Run typecheck**

Run: `bun typecheck`
Expected: PASS for server (web will still fail until Tasks 6-7)

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/ws.ts
git commit -m "feat: add skills.list and skills.refresh RPC handlers"
```

---

### Task 6: Web Client — RPC Client + NativeApi Adapter

**Files:**

- Modify: `apps/web/src/wsRpcClient.ts:38-96` (WsRpcClient interface)
- Modify: `apps/web/src/wsRpcClient.ts:113-207` (createWsRpcClient)
- Modify: `apps/web/src/wsNativeApi.ts:22-103` (NativeApi adapter)

- [ ] **Step 1: Add skills to WsRpcClient interface**

In `apps/web/src/wsRpcClient.ts`, add after the `server` section in the `WsRpcClient` interface:

```typescript
readonly skills: {
  readonly list: RpcUnaryNoArgMethod<typeof WS_METHODS.skillsList>;
  readonly refresh: RpcUnaryNoArgMethod<typeof WS_METHODS.skillsRefresh>;
};
```

- [ ] **Step 2: Add skills implementation to createWsRpcClient**

In the `createWsRpcClient` return object, add after `server`:

```typescript
skills: {
  list: () => transport.request((client) => client[WS_METHODS.skillsList]({})),
  refresh: () => transport.request((client) => client[WS_METHODS.skillsRefresh]({})),
},
```

- [ ] **Step 3: Add skills to wsNativeApi adapter**

In `apps/web/src/wsNativeApi.ts`, add after the `server` section in the `api` object:

```typescript
skills: {
  list: rpcClient.skills.list,
  refresh: rpcClient.skills.refresh,
},
```

- [ ] **Step 4: Run typecheck**

Run: `bun typecheck`
Expected: PASS for contracts + web client

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/wsRpcClient.ts apps/web/src/wsNativeApi.ts
git commit -m "feat: add skills RPC client and NativeApi adapter"
```

---

### Task 7: Web — Composer Logic Update

**Files:**

- Modify: `apps/web/src/composer-logic.ts:187-238` (detectComposerTrigger)

- [ ] **Step 1: Make detectComposerTrigger accept any slash prefix**

Currently (line 204), the function returns `null` if the typed query doesn't match any `SLASH_COMMANDS` entry. Change this so ANY `/\S*` pattern at line start returns a `slash-command` trigger. The menu filtering handles which items appear.

Replace lines 192-213 in `detectComposerTrigger`:

```typescript
if (linePrefix.startsWith("/")) {
  const commandMatch = /^\/(\S*)$/.exec(linePrefix);
  if (commandMatch) {
    const commandQuery = commandMatch[1] ?? "";
    if (commandQuery.toLowerCase() === "model") {
      return {
        kind: "slash-model",
        query: "",
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }
    // Always return slash-command trigger for any /query
    // Menu items handle filtering (built-in commands + skills)
    return {
      kind: "slash-command",
      query: commandQuery,
      rangeStart: lineStart,
      rangeEnd: cursor,
    };
  }

  const modelMatch = /^\/model(?:\s+(.*))?$/.exec(linePrefix);
  if (modelMatch) {
    return {
      kind: "slash-model",
      query: (modelMatch[1] ?? "").trim(),
      rangeStart: lineStart,
      rangeEnd: cursor,
    };
  }
}
```

The key change: removed `if (SLASH_COMMANDS.some(...))` guard — now returns for any `/` prefix.

- [ ] **Step 2: Run typecheck**

Run: `bun typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/composer-logic.ts
git commit -m "feat: accept any slash prefix in detectComposerTrigger for skill matching"
```

---

### Task 8: Web — ComposerCommandMenu Skill Type

**Files:**

- Modify: `apps/web/src/components/chat/ComposerCommandMenu.tsx:10-33` (ComposerCommandItem type)
- Modify: `apps/web/src/components/chat/ComposerCommandMenu.tsx:119-133` (icon rendering)

- [ ] **Step 1: Add skill variant to ComposerCommandItem**

Add after the `"model"` variant in the union type:

```typescript
  | {
      id: string;
      type: "skill";
      name: string;
      label: string;
      description: string;
    };
```

- [ ] **Step 2: Add icon import**

Add `ZapIcon` to the lucide-react import:

```typescript
import { BotIcon, ZapIcon } from "lucide-react";
```

- [ ] **Step 3: Add skill icon rendering**

Add after the `model` Badge rendering block (after line ~133):

```typescript
      {props.item.type === "skill" ? (
        <ZapIcon className="size-4 text-muted-foreground/80" />
      ) : null}
```

- [ ] **Step 4: Run typecheck**

Run: `bun typecheck`
Expected: FAIL — ChatView.tsx needs updating (expected, Task 9)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/chat/ComposerCommandMenu.tsx
git commit -m "feat: add skill type to ComposerCommandMenu with ZapIcon"
```

---

### Task 9: Web — ChatView Integration

**Files:**

- Modify: `apps/web/src/components/ChatView.tsx`

This is the final integration task. Three changes needed:

1. Fetch skills on mount
2. Merge skill items into composerMenuItems
3. Handle skill selection in onSelectComposerItem

- [ ] **Step 1: Add skill state and fetch**

Find the component's state declarations area. Add:

```typescript
const [skills, setSkills] = useState<SkillEntry[]>([]);
```

Add the SkillEntry import:

```typescript
import { type SkillEntry } from "@codewithme/contracts";
```

Add a useEffect to fetch skills on mount. Use the existing `nativeApi` or `rpcClient` pattern already in the file:

```typescript
useEffect(() => {
  void nativeApi.skills
    .list()
    .then((result) => setSkills(result.skills))
    .catch(() => {});
}, [nativeApi]);
```

Find how `nativeApi` is accessed in this component — follow the existing pattern. It might be via `useNativeApi()` hook or passed as prop.

- [ ] **Step 2: Add skill items to composerMenuItems**

In the `composerMenuItems` useMemo, modify the `slash-command` branch. After building `slashCommandItems`, add skills:

```typescript
if (composerTrigger.kind === "slash-command") {
  const slashCommandItems = [
    {
      id: "slash:model",
      type: "slash-command",
      command: "model",
      label: "/model",
      description: "Switch response model for this thread",
    },
    {
      id: "slash:plan",
      type: "slash-command",
      command: "plan",
      label: "/plan",
      description: "Switch this thread into plan mode",
    },
    {
      id: "slash:default",
      type: "slash-command",
      command: "default",
      label: "/default",
      description: "Switch this thread back to normal chat mode",
    },
  ] satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>>;

  const skillItems: ComposerCommandItem[] = skills.map((s) => ({
    id: `skill:${s.name}`,
    type: "skill",
    name: s.name,
    label: `/${s.name}`,
    description: s.description,
  }));

  const allItems = [...slashCommandItems, ...skillItems];

  const query = composerTrigger.query.trim().toLowerCase();
  if (!query) return allItems;
  return allItems.filter((item) => item.label.slice(1).toLowerCase().includes(query));
}
```

Add `skills` to the useMemo dependency array.

- [ ] **Step 3: Handle skill selection in onSelectComposerItem**

In `onSelectComposerItem`, add a handler for `type: "skill"` before the model handler (the final fallthrough):

```typescript
if (item.type === "skill") {
  const replacement = `/${item.name} `;
  const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
    snapshot.value,
    trigger.rangeEnd,
    replacement,
  );
  const applied = applyPromptReplacement(trigger.rangeStart, replacementRangeEnd, replacement, {
    expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd),
  });
  if (applied) {
    setComposerHighlightedItemId(null);
  }
  return;
}
```

- [ ] **Step 4: Run typecheck**

Run: `bun typecheck`
Expected: PASS

- [ ] **Step 5: Run format and lint**

Run: `bun fmt && bun lint`
Expected: PASS (fix any issues)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/ChatView.tsx
git commit -m "feat: integrate skills into composer slash-command autocomplete"
```

---

### Task 10: Verification

- [ ] **Step 1: Full typecheck**

Run: `bun typecheck`
Expected: PASS across all packages

- [ ] **Step 2: Format + Lint**

Run: `bun fmt && bun lint`
Expected: PASS

- [ ] **Step 3: Tests**

Run: `bun run test`
Expected: PASS (existing tests should not break)

- [ ] **Step 4: Manual verification**

Start the dev server and verify:

1. Type `/` in the composer — see built-in commands + skills
2. Type `/com` — see filtered results (e.g. `/commit`, `/completeness-check`)
3. Select a skill — see `/{name} ` inserted as prefix
4. Type additional text and press Enter — message sent as `/{name} some text`
5. Empty filter shows "No matching command." when nothing matches

- [ ] **Step 5: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: address verification issues for skill slash commands"
```
