# Turn-Completion Notifications (Push + Sound)

## Ziel

Nach Abschluss eines Turns (Prozess) in CodeWithMe soll eine Push-Notification mit Sound auftauchen, Titel = Thread-Name. Standardmäßig aktiv, in den Settings an/aus schaltbar.

## Architektur-Entscheidungen (nach Plan-Review)

1. **Client-only Setting**: Benachrichtigungspräferenz ist per-Gerät (Notification-Permission ist ohnehin pro Origin). Feld `turnCompletionNotifications: Schema.Boolean` in `ClientSettingsSchema` (Default `true`). Konvention analog zu `confirmThreadArchive` (kein Enabled-Suffix).
2. **Wo triggert der Listener?** In den **bestehenden** `applyEventBatch`-Flow in `apps/web/src/routes/__root.tsx` einklinken (nach `applyOrchestrationEvents`). Kein paralleles `onDomainEvent`-Abo — das würde beim Replay/Recovery doppelte Notifications feuern (vom Review-Agent identifiziert).
3. **Sound**: Web Audio API (Oscillator, zwei kurze Sinus-Töne) als **MVP**. Kein Asset, funktioniert überall. Späteres Upgrade auf echtes Audio-Asset ist Follow-up. Try/catch um AudioContext.
4. **Notification-API**: Standard `Notification` (Browser). Permission beim Einschalten des Toggles lazy anfordern. Wenn denied → nur Sound als Fallback. Tag `threadId` setzen, damit mehrere Events pro Thread die vorherige Notification ersetzen statt stapeln.
5. **Skip-Bedingung** (abgeschwächt): Notification+Sound nur skippen, wenn `document.visibilityState === "visible"` UND `document.hasFocus()` UND aktuelle Route-Thread-ID === event.threadId. User-Intent: Bescheid bekommen, wenn man nicht direkt hinschaut.
6. **Aktive Thread-ID**: aus TanStack-Router lesen (`useLocation`/`useParams`), **nicht** aus `threadSelectionStore` (das ist Multi-Select für Sidebar). In einem Ref spiegeln, damit der Listener nicht re-subscribed werden muss.
7. **Enabled-Flag in Ref spiegeln**: damit Toggle keinen Re-Mount des Listeners triggert.
8. **Thread-Titel-Fallback**: Wenn `useStore.getState().threads.find(...)` `undefined` liefert (Race mit frischem Thread), Fallback-Titel `"Turn completed"`.
9. **Dedup**: Nicht nötig, weil wir in `applyEventBatch` nur neue Events (nach `recovery.markEventBatchApplied`) sehen. Das ist per Konstruktion dedupliziert.

## Umsetzungsschritte

### Step 1 – Contract (`packages/contracts/src/settings.ts`)

- [x] Feld `turnCompletionNotifications: Schema.Boolean.pipe(Schema.withDecodingDefault(() => true))` in `ClientSettingsSchema` ergänzen.

### Step 2 – Notification-Utility (`apps/web/src/lib/turnCompletionNotification.ts`, neu)

- [x] `ensureNotificationPermission(): Promise<NotificationPermission>` — fragt Permission bei `"default"` an, gibt aktuelle zurück. No-op wenn `Notification`-API nicht verfügbar.
- [x] `playCompletionSound(status: ThreadTurnCompletionStatus): void` — Web Audio. Success = aufsteigende 2 Töne (660 → 880 Hz), sonst abfallend (660 → 440 Hz). Lazy-initialisierter AudioContext, try/catch um alles.
- [x] **Pure-Function** `buildNotificationContent(status, threadTitle): { title: string; body: string }` — testbar isoliert. Title = `threadTitle`, Body = status-abhängiger Text: `"Turn completed"`, `"Turn failed"`, `"Turn interrupted"`, `"Turn cancelled"`.
- [x] **Pure-Function** `shouldSuppressNotification(params: { visibilityState: DocumentVisibilityState; hasFocus: boolean; activeThreadId: string | null; eventThreadId: string }): boolean` — testbar isoliert. `true` wenn alle drei Skip-Bedingungen erfüllt.
- [x] `showCompletionNotification({ threadTitle, status, threadId }): void` — ruft `buildNotificationContent`, setzt `new Notification(title, { body, tag: threadId })` wenn `Notification.permission === "granted"`. Alle Fehler verschlucken.

### Step 3 – Integration in `applyEventBatch` (`apps/web/src/routes/__root.tsx`)

- [x] In `EventRouter`: neuer Ref `turnNotificationsEnabledRef = useRef(settings.turnCompletionNotifications)`. Sync per `useEffect`.
- [x] Aktive-Thread-ID als Ref: `activeThreadIdRef`, gefüllt aus `useParams({ strict: false, select: p => p.threadId ?? null })` (oder via `useLocation`, wenn `useParams` in Root-Route nicht zuverlässig greift) + `useEffect`.
- [x] In `applyEventBatch` (Zeile ~360): nach `applyOrchestrationEvents(uiEvents)` zusätzlich:
  ```ts
  for (const event of nextEvents) {
    if (event.type !== "thread.turn-completed") continue;
    if (!turnNotificationsEnabledRef.current) continue;
    if (
      shouldSuppressNotification({
        visibilityState: document.visibilityState,
        hasFocus: document.hasFocus(),
        activeThreadId: activeThreadIdRef.current,
        eventThreadId: event.payload.threadId,
      })
    )
      continue;
    const thread = useStore.getState().threads.find((t) => t.id === event.payload.threadId);
    const threadTitle = thread?.title ?? "Turn completed";
    playCompletionSound(event.payload.status);
    showCompletionNotification({
      threadTitle,
      status: event.payload.status,
      threadId: event.payload.threadId,
    });
  }
  ```
- [x] Keine zusätzliche Subscription; keine neuen Dependencies im `useEffect`-Array (Refs handhaben Updates).

### Step 4 – Settings UI (`apps/web/src/components/settings/SettingsPanels.tsx`)

- [x] Neuer `SettingsRow` "Completion notifications" in `GeneralSettingsPanel` zwischen "Assistant output" und "New threads" (sinnvolle Nachbarschaft).
- [x] Switch bindet an `settings.turnCompletionNotifications`, `onCheckedChange`:
  - Wenn `true`: `updateSettings({ turnCompletionNotifications: true })` **und** `void ensureNotificationPermission()`. Wenn Permission danach `denied` ist, ein `toastManager.add({ type: "warning", title: "Notifications blocked", description: "Turn completions will still play a sound." })`.
  - Wenn `false`: `updateSettings({ turnCompletionNotifications: false })`.
- [x] Reset-Button wenn `settings.turnCompletionNotifications !== DEFAULT_UNIFIED_SETTINGS.turnCompletionNotifications`.
- [x] `useSettingsRestore.changedSettingLabels`: neuen Eintrag `...(settings.turnCompletionNotifications !== DEFAULT_UNIFIED_SETTINGS.turnCompletionNotifications ? ["Completion notifications"] : [])`.

### Step 5 – Unit-Tests (`apps/web/src/lib/turnCompletionNotification.test.ts`, neu)

- [x] Vitest-Suite, führt via `bun run test`:
  - `buildNotificationContent` für alle 4 Status → korrekter Titel + Body.
  - `shouldSuppressNotification`: Tabelle aus Visibility × Focus × ThreadMatch → Skip ja/nein.
  - Thread-Title-Fallback: `buildNotificationContent("completed", "")` → sauberer String.

### Step 6 – Validierung

- [x] `bun fmt`
- [x] `bun lint`
- [x] `bun typecheck`
- [x] `bun run test`
- [x] Manueller Smoke-Test:
  - Turn starten, auf anderen Thread wechseln → Notification+Sound kommen.
  - Turn starten, Tab minimieren/unfokussieren → Notification+Sound kommen.
  - Turn starten, im aktiven Thread-Tab bleiben mit Fokus → **keine** Notification/Sound (Skip).
  - Toggle off → nichts mehr.
  - Toggle on bei vorher abgelehnter Permission → Toast mit Hinweis, trotzdem Sound-Only-Modus aktiv.
  - Electron-Build (apps/desktop): Notification erscheint mit App-Name, nicht "Electron".

## Risiken (verbleibend)

- **AudioContext autoplay**: try/catch verschluckt; User hat bereits interagiert (Turn gestartet).
- **Electron Permission-Handler**: aktuell nicht gesetzt (Default-Allow). Falls irgendwann `setPermissionRequestHandler` hinzugefügt wird, muss `notifications` erlaubt bleiben.
- **Race beim Thread-Titel**: Fallback-String abgedeckt.
- **Mehrere Turns auf demselben Thread hintereinander**: `tag: threadId` ersetzt die vorherige Notification – akzeptabel.

## Follow-ups (bewusst nicht in diesem Task)

- Echtes Audio-Asset statt Oscillator.
- Separate Sounds pro Status.
- Server-seitige Preference-Sync (falls jemand 2+ Clients hat).
- Anklickbare Notification → aktiviert Browser-Tab + navigiert zum Thread.

## Ergebnis

- **Geänderte/Neue Dateien:**
  - `packages/contracts/src/settings.ts` — Feld `turnCompletionNotifications` in `ClientSettingsSchema` (Default `true`).
  - `apps/web/src/lib/turnCompletionNotification.ts` — neu, Pure-Functions (`buildNotificationContent`, `shouldSuppressNotification`) + Side-Effects (`playCompletionSound`, `ensureNotificationPermission`, `showCompletionNotification`).
  - `apps/web/src/lib/turnCompletionNotification.test.ts` — neu, 11 Vitest-Tests.
  - `apps/web/src/routes/__root.tsx` — `useEffectEvent`-Handler `notifyTurnCompletionsFromBatch` im `EventRouter`, eingehängt am Ende von `applyEventBatch` (nach Recovery-Dedup).
  - `apps/web/src/components/settings/SettingsPanels.tsx` — neuer `SettingsRow` "Completion notifications" inkl. Reset, plus Eintrag in `useSettingsRestore.changedSettingLabels`.
- **Validierung:**
  - `bun fmt` ✓, `bun lint` ✓ (keine neuen Warnings in geänderten Dateien), `bun typecheck` ✓, `npx turbo run test --filter=@codewithme/web` → 15/15 Tests grün (davon 11 neu).
  - Manueller Smoke-Test: durch den User zu verifizieren (Electron + Browser, Permissions-Dialog, Skip-Verhalten).
- **Bewertung:** Implementierung pragmatisch und in-Pattern. Pure-Logik ist testbar isoliert, Side-Effects sind schmale Wrapper. Keine neue Event-Subscription (an bestehenden `applyEventBatch` angedockt), daher kein Replay-Duplikat-Risiko. Sound via Web Audio Oscillator ist MVP – Upgrade auf echtes Audio-Asset bewusst als Follow-up vermerkt.

## Notizen (wird beim Umsetzen gefüllt)

- …
