# Skill Slash Commands

Slash-Command-Autocomplete fuer Claude Code Skills in der CodeWithMe Web-UI.

## Anforderungen

- Skills aus `~/.claude/skills/` (User) und Plugin-Skills (`~/.claude/plugins/cache/`) im Slash-Command-Autocomplete anzeigen
- Auswahl fuegt Skill-Name als Prefix ins Textfeld ein (z.B. `/commit`), User ergaenzt optional Args, Enter sendet als normale Nachricht
- Server laedt Skills beim Start, manueller Refresh ueber RPC
- Nur Name + Description aus YAML-Frontmatter noetig

## Architektur

```
┌─────────────┐     skills.list RPC      ┌──────────────────┐
│   Web App   │ ◄──────────────────────── │     Server       │
│             │     skills.refresh RPC    │                  │
│ Composer    │ ──────────────────────── ► │ SkillDiscovery   │
│ CommandMenu │                           │ Service          │
└─────────────┘                           └──────────────────┘
                                                  │
                                          ┌───────┴────────┐
                                          │  Filesystem     │
                                          │  ~/.claude/     │
                                          │   skills/       │
                                          │   plugins/      │
                                          └────────────────┘
```

## 1. Contracts (`packages/contracts`)

Neues Modul `src/skill.ts`:

```typescript
export const SkillEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  source: Schema.Literals(["user", "plugin"]),
});
export type SkillEntry = typeof SkillEntry.Type;

export const SkillsListResult = Schema.Struct({
  skills: Schema.Array(SkillEntry),
});

export const SkillsListError = Schema.TaggedError<SkillsListError>()("SkillsListError", {
  message: Schema.String,
});

export const SkillsRefreshError = Schema.TaggedError<SkillsRefreshError>()("SkillsRefreshError", {
  message: Schema.String,
});
```

Neue RPC-Definitionen in `src/rpc.ts`:

```typescript
export const WS_METHODS = {
  // ... existing
  skillsList: "skills.list",
  skillsRefresh: "skills.refresh",
};

export const WsSkillsListRpc = Rpc.make("skills.list", {
  payload: Schema.Struct({}),
  success: SkillsListResult,
  error: SkillsListError,
});

export const WsSkillsRefreshRpc = Rpc.make("skills.refresh", {
  payload: Schema.Struct({}),
  success: SkillsListResult,
  error: SkillsRefreshError,
});
```

Beide RPCs in `WsRpcGroup` registrieren.

## 2. Server (`apps/server`)

Neues Modul `src/skillDiscovery.ts`:

### Skill-Quellen

1. **User-Skills:** `~/.claude/skills/*/SKILL.md`
2. **Plugin-Skills:** `~/.claude/plugins/installed_plugins.json` lesen → JSON-Objekt mit Plugin-Eintraegen, jeder hat `installPath` → `{installPath}/skills/*/SKILL.md` scannen

### Frontmatter-Parsing

Nur den YAML-Block zwischen `---` Markern lesen. Felder `name` und `description` extrahieren. Kein Full-Content-Parsing noetig.

### Service-Design

```typescript
export class SkillDiscoveryService extends Effect.Service<SkillDiscoveryService>()("SkillDiscoveryService", {
  effect: Effect.gen(function* () {
    let cache: SkillEntry[] = [];

    const scanSkills = (): Effect.Effect<SkillEntry[]> => // ...
    const list = (): SkillEntry[] => cache;
    const refresh = (): Effect.Effect<SkillEntry[]> => // scanSkills + update cache

    // Initial load
    cache = yield* scanSkills();

    return { list, refresh };
  }),
}) {}
```

### Verhalten

- Fehlerhafte/unlesbare Skill-Dateien: loggen + ueberspringen
- Duplikate (gleicher Name): User-Skills gewinnen ueber Plugin-Skills
- Symlinks aufloesen (`fs.realpath`)

### RPC-Handler in `ws.ts`

```typescript
[WS_METHODS.skillsList]: (_input) =>
  observeRpcEffect("skills.list",
    Effect.succeed({ skills: skillDiscovery.list() })
  ),

[WS_METHODS.skillsRefresh]: (_input) =>
  observeRpcEffect("skills.refresh",
    skillDiscovery.refresh().pipe(
      Effect.map((skills) => ({ skills }))
    )
  ),
```

## 3. Web Client (`apps/web`)

### RPC-Client (`wsRpcClient.ts`)

```typescript
export interface WsRpcClient {
  // ... existing
  readonly skills: {
    readonly list: RpcUnaryNoArgMethod<typeof WS_METHODS.skillsList>;
    readonly refresh: RpcUnaryNoArgMethod<typeof WS_METHODS.skillsRefresh>;
  };
}
```

### Skill-State in ChatView

- Skills beim Mount ueber `skills.list` laden
- In `useState` oder `useRef` cachen
- Optional: Refresh-Button in der UI

### Composer-Logic (`composer-logic.ts`)

Keine Aenderung an `ComposerSlashCommand` Type noetig. Skills werden separat behandelt:

- `detectComposerTrigger()` liefert weiterhin `kind: "slash-command"` fuer `/`-Eingaben
- Die Filterung in `composerMenuItems` matcht gegen geladene Skills zusaetzlich zu den built-in Commands

### ComposerCommandItem erweitern

```typescript
export type ComposerCommandItem =
  | { type: "path"; ... }
  | { type: "slash-command"; ... }
  | { type: "model"; ... }
  | { type: "skill"; id: string; name: string; label: string; description: string; };
```

### composerMenuItems (ChatView.tsx)

Im `slash-command` Branch die Skill-Items anhaengen:

```typescript
if (composerTrigger.kind === "slash-command") {
  const builtInItems = [
    { id: "slash:model", type: "slash-command", command: "model", ... },
    { id: "slash:plan", type: "slash-command", command: "plan", ... },
    { id: "slash:default", type: "slash-command", command: "default", ... },
  ];

  const skillItems = skills.map((s) => ({
    id: `skill:${s.name}`,
    type: "skill",
    name: s.name,
    label: `/${s.name}`,
    description: s.description,
  }));

  const allItems = [...builtInItems, ...skillItems];
  // filter by query...
}
```

### onSelectComposerItem (ChatView.tsx)

Neuer Handler fuer `type: "skill"`:

```typescript
if (item.type === "skill") {
  const replacement = `/${item.name} `;
  applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, replacement);
  setComposerHighlightedItemId(null);
  return;
}
```

Der User sieht `/{skillname} ` im Textfeld, ergaenzt optional Args, Enter sendet als normale Nachricht.

### ComposerCommandMenu Rendering

Skill-Items mit eigenem Icon (z.B. `ZapIcon` oder `SparklesIcon`) rendern, visuell von built-in Commands unterscheidbar.

## 4. Abgrenzung

- Kein Skill-Content-Parsing ueber Frontmatter hinaus
- Kein Skill-Execution im Server – der Provider (Codex/Claude) handhabt Skills
- Kein File-Watcher – nur manueller Refresh
- Keine Projekt-lokalen Skills (`.claude/skills/`) in dieser Iteration
