# Orphan-Process-Fix: Codex/Claude/Gemini/PTY

## Problem

Beim harten Beenden des Servers (Crash, `kill -9`, Cmd+Q, OOM) bleiben langlebige
Kind-Prozesse (`codex app-server`, PTY-Shells) als Orphans zurück. Sie werden von
init (PID 1) adoptiert und belegen weiterhin Datei-Deskriptoren und PTY-Devices
auf macOS. Nach wenigen harten Restarts ist das System-PTY-Limit erschöpft — der
User meldet: "ab und an werden alle terminal sessions von mac benutzt".

## Root-Causes (bestaetigt via Code-Inspektion)

1. **Kein Shutdown-Hook im Server-Entry** (`apps/server/src/bin.ts`,
   `server.ts`, `cli.ts`): Es existiert kein `process.on('SIGINT' | 'SIGTERM' |
'SIGHUP' | 'uncaughtException' | 'unhandledRejection')`-Handler, der
   garantiert laufende Children killt. Effect-Scopes helfen nur bei sauberem
   Runtime-Shutdown, nicht bei Crash.
2. **Kein Startup-Cleanup**: Beim Neustart werden verwaiste Children aus dem
   vorherigen Lauf nicht erkannt und akkumulieren.
3. **Double-Start-Race im Codex-Manager**
   (`codexAppServerManager.ts:496`): `this.sessions.set(threadId, context)`
   ueberschreibt einen bestehenden Context ohne den alten Child zu killen.
   Gleiches Risiko im Claude-Adapter (`ClaudeAdapter.ts:2775`).
4. **SIGTERM -> 3s -> SIGKILL-Eskalation via `setTimeout`**
   (`provider/codexAppServer.ts:46`): Beim Shutdown ist der Event-Loop zu diesem
   Zeitpunkt oft schon tot -> SIGKILL-Timer feuert nie.
5. **Keine Process-Group-Isolation**: Children laufen in der gleichen PGID wie
   der Server. `kill(-pid)` waere eine zuverlaessigere Gruppen-Kill-Option als
   einzelne PIDs.

## Architektur-Entscheidungen (nach Plan-Review)

- **Zentrale Registry** statt Adapter-lokaler Listen: `ChildProcessRegistry`
  als Singleton (kein Effect-Service, weil Signal-Handler synchron und
  Service-unabhaengig laufen muessen).
- **In-Memory-SSOT, debounced Persist**: Map als Single Source of Truth,
  PID-File wird async via `setImmediate`-Debounce (50ms) geschrieben. Vermeidet
  Sync-I/O-Hotpath bei PTY-Resize-Bursts. Startup-Cleanup liest sync.
- **Synchroner Kill-Pfad** in Signal-Handlern: direkt `process.kill(pid,
'SIGKILL')` ohne Umweg. Alle `console.log`-Calls in `try/catch`, weil
  stderr/stdout bei Crash geschlossen sein koennen.
- **Startup-Cleanup via PID-File mit `startTime`-Guard**: Wir schreiben beim
  Spawn `{ pid, pgid?, label, startTime }`. `startTime` ist `ps -o lstart= -p
<pid>` beim Register (ein `spawnSync` pro Spawn). Beim Startup-Cleanup:
  `process.kill(pid, 0)` + `ps -o lstart=`-Vergleich; nur bei Match wird
  gekillt. Schuetzt vor PID-Recycling.
- **PGID-basierter Kill** (nur non-Windows): `spawn(..., { detached: true })`
  erzeugt eigene Process-Group. Kill via `process.kill(-pgid, 'SIGKILL')`
  erwischt das Child **und** alle Sub-Tools. Fallback: `process.kill(pid)`.
  `child.unref()` NICHT setzen.
- **Windows-Pfad bleibt `taskkill /T /F`**: kein `detached`, keine PGID-Logik.
  Registry trackt nur PID.
- **Claude ist in-process**: kein separater Prozess. Trotzdem Double-Start-Guard
  implementieren. Claude-Sessions werden in parallele
  `claudeCleanupHooks`-Liste eingetragen, damit Signal-Handler
  `query.close()`-basierten Cleanup best-effort triggert (bei SIGINT/SIGTERM
  noch erreichbar, bei SIGKILL nicht).
- **Gemini ist one-shot pro Turn**: Effect.scoped + Timeout ist schon robust.
  Falls die `ChildProcess`-Instanz via Framework-Abstraktion erreichbar ist:
  registrieren. Sonst: Code-Notiz, keine Aenderung.
- **`claudeUsageProbe.ts`**: PTY-Spawn, eindeutig langlebig-genug fuer Orphan.
  MUSS registriert werden + hartes Timeout absichern.
- **Single-Instance-Lock via Port-Bind**: WebSocket-Port ist natuerliches Mutex.
  Falls Port belegt: klar scheitern (kein Port-Stealing). Kein zusaetzlicher
  File-Lock noetig. Doppelstart ist User-Fehler, wird durch Port-Kollision
  offensichtlich.

## Schritte

### 1. Shared: ChildProcessRegistry (`apps/server/src/childProcessRegistry.ts` NEU)

- [ ] Singleton-Modul mit:
  - `register(entry: { pid: number; pgid?: number; label: string }): void` —
    fuegt Entry in in-memory Map, liest `startTime` via
    `readStartTime(pid)` (spawnSync `ps -o lstart= -p <pid>`), triggert
    debounced Persist.
  - `unregister(pid: number): void` — aus Map loeschen + debounced Persist.
  - `killAllSync(signal: 'SIGKILL' | 'SIGTERM'): void` — iteriert Map, kill
    via `-pgid` wenn vorhanden sonst `pid`, pro Eintrag try/catch.
  - `snapshot(): ReadonlyArray<ChildProcessEntry>`
  - `setPidFilePath(path: string): void` — einmalig vom Bootstrap gesetzt.
- [ ] Persistenz:
  - In-Memory Map ist SSOT. Persist via `setImmediate`-Debounce (50ms):
    atomic `writeFile(tmp)` + `rename`. Write-Fehler schlucken + einmal
    loggen.
  - `readPidFileSync(filePath)`: JSON-Array mit `{pid, pgid?, label,
startTime}`. Tolerant gegen kaputte Datei (leer returnen).
  - `clearPidFileSync(filePath)`: `writeFileSync("[]")`.
- [ ] Helper `readStartTime(pid): string | null` — `spawnSync("ps", ["-o",
"lstart=", "-p", String(pid)])`, Windows: fallback `null` (PID-Recycling
      tolerant dort via `taskkill` + schneller Startup).
- [ ] Path-Resolver: `childrenPidFilePath` wird ueber
      `config.ts::deriveServerPaths` (`runDir/children.pids`) eingezogen.

### 2. Startup-Cleanup (`apps/server/src/orphanCleanup.ts` NEU)

- [ ] `cleanupOrphanedChildren(pidFilePath: string): Effect.Effect<void, never>`
  - Liest PID-File via `readPidFileSync`
  - Pro Eintrag: 1. `process.kill(pid, 0)` -> wenn wirft (ESRCH): skip 2. `readStartTime(pid)` vs. gespeicherter `startTime`: wenn nicht Match
    -> PID wurde recycelt, skip (Log-Warn). 3. Match -> Kill via `process.kill(-pgid, 'SIGKILL')` wenn pgid vorhanden,
    sonst `process.kill(pid, 'SIGKILL')`. Windows: `spawnSync("taskkill",
["/PID", String(pid), "/T", "/F"])`.
  - Alle Errors (EPERM, etc.) schlucken + loggen.
  - Am Ende: `clearPidFileSync`.
- [ ] In `server.ts`: `cleanupOrphanedChildren` als allererstes Layer-Effect
      aufrufen (vor `HttpServerLive`). Layer via `Layer.effectDiscard`. Bekommt
      `childrenPidFilePath` aus `ServerConfig`. Registry via
      `ChildProcessRegistry.setPidFilePath(...)` initialisieren.

### 3. Signal-Handler (`apps/server/src/bin.ts`)

- [ ] Vor `Command.run(cli, ...)` installieren. Wrap ALLE Log-Calls in
      `try/catch` (stderr kann bei Crash dicht sein).
  ```ts
  let shutdownRan = false;
  const safeLog = (msg: string) => {
    try {
      console.error(msg);
    } catch {}
  };
  const shutdownOnce = (signal: string, exitCode: number) => {
    if (shutdownRan) return;
    shutdownRan = true;
    safeLog(`[codewithme] received ${signal}, killing children...`);
    try {
      ChildProcessRegistry.killAllSync("SIGKILL");
    } catch {}
    try {
      ClaudeCleanupHooks.runAllSync();
    } catch {}
    process.exit(exitCode);
  };
  ```
- [ ] Handler binden:
  - `SIGINT` -> exitCode 130
  - `SIGTERM` -> 143
  - `SIGHUP` -> 129
  - `uncaughtException` -> safeLog(err) + shutdown + exit 1
  - `unhandledRejection` -> safeLog(reason) + shutdown + exit 1
- [ ] `claudeCleanupHooks` = separater Singleton-Modul fuer Claude-Sessions
      (`apps/server/src/claudeCleanupHooks.ts` NEU): `add(hook: () => void)`,
      `remove(hook)`, `runAllSync()`. Hooks sollten `query.interrupt()` + `close()`
      sync attempts sein.

### 4. Codex-Manager fixen (`apps/server/src/codexAppServerManager.ts`)

- [ ] `spawn(...)` auf non-Windows mit `detached: true` aendern. Windows bleibt
      wie bisher (kein detached, taskkill-Pfad).
- [ ] Direkt nach Spawn: Guard `if (child.pid === undefined) { /* spawn
scheiterte, throw */ }`. Dann `ChildProcessRegistry.register({ pid:
child.pid, pgid: process.platform !== "win32" ? child.pid : undefined,
label: \`codex:${threadId}\` })`. (Bei `detached: true` ist pgid == pid.)
- [ ] Im `exit`-Handler: `ChildProcessRegistry.unregister(child.pid)` mit
      Guard gegen `undefined`.
- [ ] In `stopSession`: `unregister` direkt nach `killChildTree`.
- [ ] **Double-Start-Guard** in `startSession`, direkt vor dem Spawn
      (Zeile ~465):
  ```ts
  const existing = this.sessions.get(threadId);
  if (existing) {
    this.stopSession(threadId);
  }
  ```
- [ ] `killCodexChildProcess` (`provider/codexAppServer.ts`): wenn
      `process.platform !== "win32"` und pid vorhanden: `process.kill(-pid,
"SIGTERM")` zuerst, sonst `child.kill("SIGTERM")`. Grace-SIGKILL-Timer
      eskaliert auf `process.kill(-pid, "SIGKILL")` bzw. `child.kill("SIGKILL")`.

### 5. Claude-Adapter fixen (`apps/server/src/provider/Layers/ClaudeAdapter.ts`)

- [ ] **Double-Start-Guard** in `startSession` vor `sessions.set(threadId,
context)` (Zeile ~2775):
  ```ts
  const existing = sessions.get(threadId);
  if (existing && !existing.stopped) {
    yield * stopSessionInternal(existing, { emitExitEvent: false });
  }
  ```
- [ ] `stopSessionInternal` robuster: `context.query.close()` in `Effect.try` +
      `Effect.timeout(1s)` wrappen. Wenn Close haengt -> Fiber.interrupt als
      Fallback.
- [ ] Beim Claude-Adapter-Scope-Release (`Effect.acquireRelease`): sicherstellen
      dass `stopAll()` auch bei Crash laeuft. Ist bereits via
      `Effect.acquireRelease` verdrahtet — pruefen ob der Release wirklich triggert
      (ggf. Log zum Verifizieren).

### 6. Gemini-Adapter (`apps/server/src/provider/Layers/GeminiAdapter.ts`)

- [ ] `ChildProcessSpawner.spawn` (einziger Spawn-Site) dokumentieren — ist
      bereits via `Effect.scoped` + Timeout abgesichert.
- [ ] Wenn Zugriff auf die `ChildProcess`-Instanz moeglich: `register` /
      `unregister` around den Turn. Falls nicht zugaenglich wegen
      Framework-Abstraktion: nur Notiz im Code hinterlassen, keine Aenderung.

### 6a. ClaudeUsageProbe (`apps/server/src/provider/claudeUsageProbe.ts`)

- [ ] PTY-Spawn (Z. 144): nach `nodePty.spawn` -> `ChildProcessRegistry.register`
      mit `label: \`claude-probe\``.
- [ ] Beim Probe-Exit / Timeout: `unregister`.
- [ ] Bereits vorhandener Timeout (`PROBE_TIMEOUT_MS = 20_000`) bleibt als
      letzte Haltelinie.

### 7. Terminal-Manager (`apps/server/src/terminal/Layers/Manager.ts` +

`NodePTY.ts` / `BunPTY.ts`)

- [ ] In `NodePTY.ts::spawn`: nach `nodePty.spawn`:
      `ChildProcessRegistry.register(ptyProcess.pid, 'pty:${projectId}:${terminalId}')`.
      Label-Context via extra Param durchreichen (Signatur-Erweiterung).
- [ ] In `BunPTY.ts::spawn`: analog via `subprocess.pid`.
- [ ] Exit-Callback: `ChildProcessRegistry.unregister(pid)`.
- [ ] Double-Start: `open()` macht bereits `withProjectLock` + `existing`-Check
      (Z. 1568-1628). Aber `restartOrReplace` (Z. 1770-1797) ruft `stopProcess`
      bereits explizit -> ok. **Kein Code-Change noetig.**

### 8. Config: PID-File-Pfad (`apps/server/src/config.ts`)

- [ ] `ServerPaths` um `childrenPidFilePath: string` ergaenzen.
- [ ] In `deriveServerPaths`: `path.join(runDir, "children.pids")` wobei
      `runDir = path.join(baseDir, "run")`.
- [ ] In `ensureServerDirectories`: `runDir` mit `mkdir -p` anlegen.

### 9. Validierung

- [ ] Vitest: `apps/server/src/childProcessRegistry.test.ts` — register/
      unregister/killAllSync/PID-File-Roundtrip (mockt `process.kill` +
      `fs.writeFileSync`).
- [ ] `bun fmt`
- [ ] `bun lint`
- [ ] `bun typecheck`
- [ ] Manueller Smoke-Test:
  - Server starten, Codex-Session oeffnen, `ps -ef | grep "codex app-server"`
    zeigt 1 Child
  - Server mit `kill -9 <server-pid>` toeten
  - `ps -ef | grep "codex app-server"` zeigt immer noch 1 Orphan
  - Server neu starten
  - Nach Startup: `ps -ef | grep "codex app-server"` zeigt keine Orphans mehr
  - Neue Codex-Session oeffnen, normal Ctrl+C (SIGINT) -> kein Orphan
  - Reconnect-Test: Codex-Session laeuft, Client disconnected, Client
    reconnected mit gleicher threadId -> nur 1 Codex-Child, nicht 2

## Risiken / Out-of-Scope

- **PID-Recycling**: mitigiert durch `startTime`-Vergleich (`ps -o lstart=`)
  beim Startup-Cleanup. Auf Windows Best-Effort ohne startTime —
  `taskkill /T /F` ist dort aber ohnehin restriktiv (braucht Berechtigung),
  Fremdkill-Risiko minimal.
- **MCP-Subprozesse vom Claude SDK**: Aktuell keine MCPs im Projekt
  konfiguriert. Falls kuenftig: bei SIGKILL des Servers werden MCP-Children
  geleakt, das SDK bietet keinen Out-of-Band-Killpfad. **Out-of-Scope, aber
  dokumentiert.**
- **Breaking Change `NodePTY.spawn`**: Signatur erhaelt Pflicht-Label-Param
  (`projectId:terminalId`). Migration nur in `Manager.ts`.
- **Bun-Runtime vs. Node**: `fs.writeFileSync` + `process.on("SIGINT")`
  funktionieren in beiden. `spawnSync("ps", ...)` unter Bun verifizieren
  (sollte identisch sein, `node:child_process` ist API-kompatibel).

## Ergebnis

Implementierung abgeschlossen.

**Neue Dateien:**

- `apps/server/src/childProcessRegistry.ts` — Singleton, in-memory Map +
  debounced PID-File.
- `apps/server/src/claudeCleanupHooks.ts` — Singleton fuer in-process
  Claude-Sessions.
- `apps/server/src/orphanCleanup.ts` — Startup-Replay des PID-Files mit
  `startTime`-Guard.
- `apps/server/src/childProcessRegistry.test.ts` — 8 Vitest-Tests, alle
  gruen.

**Geaenderte Dateien:**

- `apps/server/src/bin.ts`: SIGINT/SIGTERM/SIGHUP/uncaughtException/
  unhandledRejection-Handler, die `killAllSync("SIGKILL")` + Claude-Hooks
  synchron ausfuehren.
- `apps/server/src/server.ts`: `cleanupOrphanedChildren` als erstes
  Layer-Effect vor dem HTTP-Server.
- `apps/server/src/config.ts`: `runDir` + `childrenPidFilePath` in
  `ServerDerivedPaths`.
- `apps/server/src/codexAppServerManager.ts`: Double-Start-Guard vor
  `sessions.set`, `spawn({ detached: !IS_WINDOWS })`, Registry-`register`/
  `unregister` an allen Lifecycle-Punkten.
- `apps/server/src/provider/codexAppServer.ts`: `killCodexChildProcess`
  nutzt `process.kill(-pid, ...)` fuer Process-Group-Kill auf POSIX mit
  Fallback auf per-PID-Kill.
- `apps/server/src/provider/Layers/ClaudeAdapter.ts`: Double-Start-Guard
  vor `sessions.set`, `cleanupHook`-Feld im Context, Hook-Registrierung/
  -Deregistrierung in `startSession` + `stopSessionInternal`.
- `apps/server/src/provider/claudeUsageProbe.ts`: Registry-Integration um
  den PTY-Probe.
- `apps/server/src/terminal/Services/PTY.ts`: `PtySpawnInput.label`
  (Pflicht, breaking intern).
- `apps/server/src/terminal/Layers/NodePTY.ts`, `BunPTY.ts`: `register`
  beim Spawn, `unregister` im `kill`/`onExit`.
- `apps/server/src/terminal/Layers/Manager.ts`: `label:
"pty:${projectId}:${terminalId}"` beim `ptyAdapter.spawn`.

**Validierung:**

- `bun fmt`: clean.
- `bun lint`: 0 errors (24 warnings, alle pre-existing im Projekt).
- `bun typecheck`: clean (1 pre-existing `tryCatchInEffectGen`-message in
  `GeminiAdapter.ts:285`, nicht meine Baustelle).
- `bun run test childProcessRegistry`: 8/8 gruen.
- `bun run test` gesamt: 1 pre-existing Failure in
  `providerAccountStatsNormalization.test.ts:104` (via `git stash`
  verifiziert — nicht durch diese Aenderung).

**Bewertung:**

Die Loesung adressiert alle drei identifizierten Orphan-Quellen:

1. **Crash-Survivor-Cleanup**: Beim naechsten Startup werden verwaiste
   Kinder ueber das PID-File erkannt und mit SIGKILL abgeraeumt.
   `startTime`-Vergleich verhindert versehentliches Abschiessen eines
   PID-Recyclers.
2. **Shutdown-Kill-Garantie**: Signal-Handler direkt auf `process.on`,
   nicht ueber Effect-Scopes. Laeuft selbst bei `uncaughtException` durch.
3. **Double-Start-Race**: Sowohl Codex als auch Claude stoppen die alte
   Session synchron bevor die neue im Map-Slot landet — keine
   dangling-Referenzen mehr.

**Bekannte Grenzen:**

- Bei `SIGKILL` des CodeWithMe-Prozesses selbst (OOM, Force-Quit) laufen
  Signal-Handler nicht — dafuer existiert der Startup-Cleanup als
  Backstop.
- Windows-Pfad nutzt `taskkill /T /F` ohne `startTime`-Guard
  (PID-Recycling dort laut Plan-Review akzeptabel).
- Falls Claude kuenftig stdio-MCPs via SDK spawnt, werden diese bei
  `SIGKILL` geleakt — aktuell nicht konfiguriert, nicht in Scope.

**Smoke-Test-Anleitung (vom User auszufuehren):**

1. `bun run dev` (oder Produktions-Start).
2. Codex-Session oeffnen, `ps -ef | grep "codex app-server"` -> 1 Child.
3. `kill -9 <server-pid>` (simuliert Crash).
4. `ps -ef | grep "codex app-server"` -> Orphan sichtbar.
5. Server neu starten.
6. `ps -ef | grep "codex app-server"` -> Orphan weg. Log-Zeile
   `orphan cleanup complete` mit `killed: 1` erscheint.
7. Reconnect-Test: Client hart reloaden -> nur 1 Codex-Child pro Thread.
