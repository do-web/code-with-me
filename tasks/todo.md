# Document-Attachments (PDF/DOCX/etc.) im Composer

## Ziel

User kann PDF / Word / beliebige unterstützte Binär-Dokumente per Drag&Drop (oder Paste/File-Picker) in den Chat-Composer ziehen. Der Server speichert die Datei im `attachmentsDir` (persistent, identisch zum Images-Flow). Beim Turn-Dispatch wird ein Hinweis mit dem absoluten Dateipfad **in den User-Prompt injiziert** (provider-agnostisch), damit der jeweilige Coding-Agent die Datei mit seinen eigenen Tools (`cat`, Read, `pdftotext`, …) öffnen kann.

## Architektur-Entscheidungen (nach Plan-Review)

1. **Prompt-Injection im `ProviderCommandReactor.sendTurnForThread`** (nicht im CodexAdapter). Provider-agnostisch; Claude/Gemini-Adapter filtern `attachment.type !== "image"` eh schon heraus → automatisch Cross-Provider-kompatibel.
2. **Separater Attachment-Typ `"document"`** neben `"image"`; Union in `ChatAttachment`.
3. **Server-seitige Persistenz** in `attachmentsDir` wie bei Images. `Normalizer.ts` macht das zentral.
4. **10 MB Document-Limit**, nicht 25 MB — der Bun-WS-Server hat `maxPayloadLength` Default 16 MB, Base64-Overhead ≈ 33 %, damit passt eine 10-MB-PDF sicher in eine einzelne RPC-Message. Größere Uploads sind Follow-up (dedizierter HTTP-Endpoint).
5. **Magic-Byte-Sniffing** im Normalizer gegen Mime-Spoofing, weil `danger-full-access`-Sandbox default ist.
6. **Separates `documents[]`-Array** im composerDraftStore (nicht Union), weil Image-Laufzeitfelder (`previewUrl`, Blob-URL-Revocation) nicht auf Docs passen.
7. **Store-Migration per `withDecodingDefault(() => [])`** statt version-bump.
8. **Cleanup**: Wenn der Dispatch nach File-Write scheitert, bereits geschriebene Dateien löschen. (Bestehender Bug bei Images wird mitgefixt.)
9. **Full-access only**: Dokumente setzen `runtimeMode = "full-access"` voraus. Im `approval-required`-Mode: UI deaktiviert Document-Upload mit Tooltip. Lazy-Copy-to-Workspace ist Follow-up.

## Ist-Zustand

- Images: `UploadChatImageAttachment` → `Normalizer.ts:49-112` dekodiert Base64, schreibt Datei, produziert `ChatImageAttachment` → `ProviderCommandReactor.sendTurnForThread` reicht sie via `providerService.sendTurn` weiter → `CodexAdapter.resolveAttachment` liest sie zurück, re-encoded zu Data-URL und übergibt an Codex-native `attachments`-Feld.
- Claude/Gemini-Adapter: filtern `attachment.type !== "image"` (`ClaudeAdapter.ts:570-572`), Dokumente werden heute stillschweigend verworfen.
- Web: `composerFiles` im `ChatView.tsx:2904-2954` akzeptiert beliebige Nicht-Image-Files und macht `file.text()` → Plaintext-Prefix vor den Prompt. PDFs liefern Binär-Garbage.
- Default runtime mode: `full-access` → `danger-full-access`-Sandbox → Codex liest absolute Pfade überall.

## Schritte

### 1. Contracts (`packages/contracts/src/orchestration.ts`)

- [ ] Limits ergänzen:
  - `PROVIDER_SEND_TURN_MAX_DOCUMENT_BYTES = 10 * 1024 * 1024` (10 MB)
  - `PROVIDER_SEND_TURN_MAX_DOCUMENT_DATA_URL_CHARS = 14_000_000` (passt zum Image-Cap)
- [ ] `CHAT_DOCUMENT_MIME_PATTERN` (RegExp) exportieren. Whitelist (Anker `^…$`): `application/pdf`, `application/msword`, `application/vnd.openxmlformats-officedocument.(wordprocessingml|spreadsheetml|presentationml).*`, `application/vnd.ms-(excel|powerpoint)`, `application/rtf`, `application/vnd.oasis.opendocument.*`, `text/(plain|csv|tab-separated-values|markdown|x-log)`.
- [ ] `ChatDocumentAttachment` (persistiert): `type: "document"`, `id: ChatAttachmentId`, `name` (max 255), `mimeType` (pattern-gecheckt, max 150), `sizeBytes` (≤ DOCUMENT-limit).
- [ ] `UploadChatDocumentAttachment` (transport): analog + `dataUrl`.
- [ ] `ChatAttachment = Union([ChatImageAttachment, ChatDocumentAttachment])` und `UploadChatAttachment` analog.
- [ ] Re-Validieren: `OrchestrationMessage.attachments` (Zeile 170) nimmt die Union → bleibt kompatibel.

### 2. Server MIME helper

- [ ] `apps/server/src/attachmentMime.ts` **neu** anlegen, konsolidiert image+document:
  - `IMAGE_EXTENSION_BY_MIME_TYPE` (aus `imageMime.ts` übernehmen)
  - `DOCUMENT_EXTENSION_BY_MIME_TYPE` (neu)
  - `SAFE_IMAGE_FILE_EXTENSIONS` + `SAFE_DOCUMENT_FILE_EXTENSIONS`
  - `inferImageExtension`, `inferDocumentExtension`
  - `parseBase64DataUrl` (MIME-agnostisch, bleibt zentral)
  - `sniffDocumentKind(bytes): "pdf" | "office-zip" | "text" | null` — Magic-Byte-Sniffing
    - PDF: startsWith `%PDF-`
    - OOXML/ZIP-basiert: startsWith `PK\x03\x04`
    - Legacy Office: `D0 CF 11 E0` (CFB-Header)
    - RTF: `{\rtf`
    - Plain Text: keine NUL-Bytes in ersten 4 KB
- [ ] Alte `imageMime.ts` entfernen; alle Importe auf `attachmentMime.ts` umstellen (Grep-Ziele: `imageMime` → 3 Fundstellen max).

### 3. Attachment Store (`apps/server/src/attachmentStore.ts`)

- [ ] `ATTACHMENT_FILENAME_EXTENSIONS` um `SAFE_DOCUMENT_FILE_EXTENSIONS` erweitern (bleibt ein Set, keine separaten Dirs).
- [ ] `attachmentRelativePath`-Switch um `case "document"` (nutzt `inferDocumentExtension`).

### 4. Normalizer (`apps/server/src/orchestration/Normalizer.ts`)

Zentrale Erweiterung, Zeilen 49-112 ersetzen:

- [ ] Vorab: `persistAttachmentBytes(bytes, attachment)`-Helper extrahieren (gemeinsame `createAttachmentId` + `resolveAttachmentPath` + `makeDirectory` + `writeFile`-Logik).
- [ ] Switch auf `UploadChatAttachment`-Union:
  - **Image-Branch** (unverändert, nur gerefactored): `parseBase64DataUrl` → MIME startsWith `image/` → size-check gegen `PROVIDER_SEND_TURN_MAX_IMAGE_BYTES` → `persistAttachmentBytes`.
  - **Document-Branch** (neu):
    - `parseBase64DataUrl` → MIME gegen `CHAT_DOCUMENT_MIME_PATTERN`
    - Size-Check gegen `PROVIDER_SEND_TURN_MAX_DOCUMENT_BYTES`
    - **Magic-Byte-Sniffing** (`sniffDocumentKind(bytes)`): muss zur MIME-Kategorie passen (PDF-MIME → `"pdf"`, Office-OOXML → `"office-zip"`, RTF → `"text"`-oder-`"office-zip"` tolerant, Plaintext-MIME → `"text"`). Mismatch ⇒ Error.
    - `persistAttachmentBytes`
- [ ] **Cleanup-Pfad**: In einem `Effect.acquireRelease` / `Effect.onError`-Wrapper: Wenn ein späteres Attachment fehlschlägt, bereits geschriebene Dateien dieses Turns löschen. Betrifft Images retroaktiv mit.

### 5. Prompt-Injection (neu: `apps/server/src/orchestration/promptDocumentReferences.ts`)

- [ ] Reine Text-Transformation, keine I/O:
  ```ts
  appendDocumentReferencesToPrompt(input: {
    prompt: string | undefined;
    attachments: ReadonlyArray<ChatAttachment>;
    attachmentsDir: string;
  }): string
  ```
- [ ] Nur `attachment.type === "document"` filtern, via `resolveAttachmentPath` zu absolutem Pfad auflösen.
- [ ] Format:

  ```
  <original prompt>

  [Attached documents for this turn — read them with your tools:]
  - <name> (<mimeType>, <sizeHuman>) → <absoluter pfad>
  ```

- [ ] Falls prompt leer und >0 Dokumente: `"Please read the attached documents:"` als seed.
- [ ] Falls 0 Dokumente: Rückgabe unverändert (`prompt ?? ""`).

### 6. ProviderCommandReactor-Integration (`apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:362-412`)

- [ ] In `sendTurnForThread` **vor** `providerService.sendTurn`:
  ```ts
  const finalInput = appendDocumentReferencesToPrompt({
    prompt: normalizedInput,
    attachments: normalizedAttachments,
    attachmentsDir: serverConfig.attachmentsDir,
  });
  ```
- [ ] `serverConfig` (`ServerConfig`) als Dependency bereits im Reactor verfügbar? Falls nicht: im `Effect.gen`-Setup injecten (analog zu `providerService`).
- [ ] `providerService.sendTurn` nimmt `finalInput` statt `normalizedInput`.

### 7. CodexAdapter (`apps/server/src/provider/Layers/CodexAdapter.ts`)

- [ ] `resolveAttachment` um Early-Return ergänzen: `if (attachment.type === "document") return null`.
- [ ] `sendTurn` (Zeile 1495): `Effect.forEach` mit `Option.filter` / nachgelagertem `codexAttachments.filter(Boolean)`, damit nur Images an Codex gehen.
- [ ] **Keine** Prompt-Manipulation hier; alles via Reactor erledigt.

### 8. Claude + Gemini Adapter

- [ ] Keine Code-Änderung nötig: beide filtern bereits `attachment.type !== "image"` (ClaudeAdapter.ts:570-572, analog Gemini). Dokumente kommen über den Prompt-Text an.
- [ ] **Verifikation**: Manueller Smoke-Test in allen drei Providern.

### 9. Web composerDraftStore (`apps/web/src/composerDraftStore.ts`)

- [ ] `PersistedComposerDocumentAttachment` Schema (id/name/mimeType/sizeBytes/dataUrl).
- [ ] `ComposerDocumentAttachment` Interface (+ `file: File`, kein `previewUrl`).
- [ ] `ComposerThreadDraftState` um `documents`, `nonPersistedDocumentIds`, `persistedDocumentAttachments` erweitern.
- [ ] `composerDocumentDedupKey(doc)`: `${doc.name}|${doc.sizeBytes}|${doc.file.lastModified}`.
- [ ] Actions: `addDocument(threadId, doc)`, `addDocuments(threadId, docs)`, `removeDocument(threadId, docId)` — Struktur 1:1 wie Images.
- [ ] Persistenz: `PersistedComposerThreadDraftState` um `documents: Schema.optional(Schema.Array(PersistedComposerDocumentAttachment)).pipe(Schema.withDecodingDefault(() => []))` erweitern. **Keine** version-bump.
- [ ] Hydration: `hydrateDocumentsFromPersisted` analog `hydrateImagesFromPersisted`, aber ohne `previewUrl`.

### 10. ChatView + Composer UI (`apps/web/src/components/ChatView.tsx`)

- [ ] Helper `CLIENT_DOCUMENT_MIME_WHITELIST` + `CLIENT_DOCUMENT_EXTENSION_WHITELIST` (Fallback bei leerem `file.type`).
- [ ] `addComposerAttachments` (Zeile 2904) erweitern:
  - Image-Branch unverändert.
  - Neuer Doc-Branch vor dem Plaintext-Fallback: Wenn `runtimeMode !== "full-access"` → Toast "Document attachments require full-access runtime." → skip.
  - Sonst MIME/Extension gegen Whitelist → size-check (10 MB) → count-check (8 total über images+docs+files) → `addComposerDocument`.
  - Alte Plaintext-`composerFiles`-Branch bleibt für echte Textdateien, die NICHT in der Doc-Whitelist stehen (`.env.example`, beliebige `.ts` etc.).
- [ ] Preview-Row: Document-Chips (Icon + Name + Remove-Button) neben Image-Thumbnails. Reuse bestehenden File-Chip aus `composerFiles` falls möglich.
- [ ] `deriveComposerSendState`: `documentCount` ergänzen → Send-Button aktiv bei nur Dokument.
- [ ] Send-Flow (Zeile 3140ff):
  - `composerDocumentsSnapshot` parallel zu Images sammeln.
  - `turnAttachmentsPromise`: Document-Uploads mit `readFileAsDataUrl` in `UploadChatAttachment[]` (Type `"document"`) einbinden.
  - `optimisticAttachments`: Document-Form (ohne `previewUrl`).
  - Documents NICHT in `fileContentPrefix`.
- [ ] Thread-Clear: `setComposerDocuments([])` analog `setComposerFiles`.

### 11. Message-Rendering (Timeline)

- [ ] `apps/web/src/components/chat/MessagesTimeline.tsx` (oder wo `OrchestrationMessage.attachments` gerendert wird): neue Branch für `attachment.type === "document"` → Chip mit Icon + Name + Link `/attachments/{id}` (target \_blank).
- [ ] Image-Rendering unverändert.

### 12. Validierung

- [ ] `bun fmt`
- [ ] `bun lint`
- [ ] `bun typecheck`
- [ ] Manueller Smoke-Test:
  - PDF droppen → senden → Agent liest Datei (Codex)
  - Word-Datei droppen → senden → Agent liest (Codex)
  - Selbes in Claude + Gemini → Prompt-Referenz sichtbar, Agent liest
  - Oversize-PDF (>10 MB) → Fehler
  - Mime-Spoof (PDF-MIME mit PNG-Bytes) → abgelehnt
  - Reload mit gepastetem Doc im Composer-Draft → wird hydratisiert
  - Thread-Wechsel → Doc-Attachments isoliert
  - `runtimeMode = "approval-required"` → Doc-Upload disabled mit Tooltip
  - Normalizer-Fehler nach erstem File-Write → kein verwaistes File

## Folgetasks (bewusst NICHT in diesem Task)

- HTTP-Upload-Endpoint für >10 MB Dokumente.
- Lazy-Copy-to-Workspace für `approval-required`-Mode (damit Document-Upload dort funktioniert).
- Attachment-GC / TTL.
- Content-Disposition-Header + `?download=1`-Query an `/attachments/{id}`.
- Server-seitige PDF→Text-Extraktion als Pre-Summary.

## Risiken (verbleibend)

- **MIME-Spoofing trotz Sniffing**: Magic-Byte-Check stoppt naive Angriffe, aber ein böswillig konstruiertes PDF mit Office-Exploit kann weiterhin Code-Ausführung triggern — sobald der Agent die Datei öffnet. Mitigation: `danger-full-access` bleibt User-Choice; die Warn-Toast ("Document attachments require full-access runtime") macht das bewusst.
- **Blob-URL-Leaks im Composer**: Dokumente haben keine, aber beim Übergang zwischen Images und Docs muss die Revocation-Logik der Images unverändert bleiben (nicht aus Versehen gemeinsam behandeln).
- **WS-Frame-Size unter Node-Runtime (Desktop)**: Node `ws` erlaubt 100 MB, also kein Problem. Unter Bun-Runtime: 10 MB + Base64 ≈ 13.3 MB < 16 MB Default → passt.
