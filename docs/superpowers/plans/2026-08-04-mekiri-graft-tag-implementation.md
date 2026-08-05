# graft/tag Implementation Plan

**Goal:** Build the minimal §6 substrate (`report.md`/`capsule.md`/`capsule-index.jsonl`, written via a new `mekiri-core` module `reportStore.ts`) and two new MCP tools in `mekiri-proxy`: `tag` (mark current context as worth remembering, no cut) and `graft` (read it back — table of contents or a specific entry's full body). `prune` gets one addition: it now also records into the same report/capsule store, so pruned branches are graftable too.

**Spec:** `docs/superpowers/specs/2026-08-04-mekiri-graft-tag-design.md` — task steps below must match its file layout, function signatures, and tool schemas exactly.

**Dispatch:** ordinary Task subagents (implementer, then a separate reviewer pass) — `mekiri-host`/`sprout` is archived and no longer a build channel for Mekiri itself.

## Global constraints

- Follow existing `mekiri-core` conventions exactly: pure functions, no live API calls, `node:fs/promises`, explicit `.js` import extensions (NodeNext ESM), `mkdtemp`-based test isolation (see `test/auditLog.test.ts`).
- `graft`/`tag` never touch `rewriteMessages`/the daemon control API (`postControlRule`) — no wire rewriting, no trunk mutation for `tag` or `graft`.
- Zero real network calls in the default test run (existing convention in both packages).

---

### Task 1 (mekiri-core): `reportStore.ts` + type/audit-log extensions

**Files:**
- Create: `packages/mekiri-core/src/reportStore.ts`
- Create: `packages/mekiri-core/test/reportStore.test.ts`
- Edit: `packages/mekiri-core/src/types.ts` — add `CapsuleIndexEntry { ruleId, header, startLine, endLine, event, sessionId, timestamp }`
- Edit: `packages/mekiri-core/src/auditLog.ts` — add `TagAuditEntry`, `GraftAuditEntry` to the `AuditEntry` union (shapes per spec §3)
- Edit: `packages/mekiri-core/src/index.ts` — export `recordDistillate`, `readReportRange`, `readCapsule`, `findCapsuleEntry`, `ReportEntryMeta`, `CapsuleIndexEntry`

**Interface (must match spec §2 exactly):**
```ts
export interface ReportEntryMeta {
  event: "prune" | "tag";
  sessionId: string;
  ruleId: string;
  noteType: NoteType;
  timestamp: string;
}
export async function recordDistillate(dir: string, meta: ReportEntryMeta, header: string, bodyText: string): Promise<{ startLine: number; endLine: number }>
export async function readReportRange(dir: string, startLine: number, endLine: number): Promise<string>
export async function readCapsule(dir: string): Promise<string>
export async function findCapsuleEntry(dir: string, ruleId: string): Promise<CapsuleIndexEntry | undefined>
```

**Behavior:**
- `recordDistillate` appends a metadata header line + `bodyText` to `.mekiri/report.md`, measures the real 1-indexed line range of what it just appended (read current line count before append, diff after — do not persist a separate counter), then appends one line to `.mekiri/capsule.md` (`«{header}» {startLine}-{endLine} — {event} {ruleId}`) and one JSON line to `.mekiri/capsule-index.jsonl`. All three writes happen every call, in that order.
- Serialize concurrent calls (same or different `dir`) behind an in-module promise-chain mutex keyed by resolved `dir` path, so parallel callers never interleave appends or race on the "read line count then append" step.
- `readCapsule` returns the full `capsule.md` contents (empty string if the file doesn't exist yet).
- `findCapsuleEntry` scans `capsule-index.jsonl` for a matching `ruleId`, returns `undefined` if the file is missing or no match.
- `readReportRange` returns the 1-indexed `[startLine, endLine]` slice of `report.md`'s lines, joined with `\n`.

**Tests (`reportStore.test.ts`):**
- [ ] First `recordDistillate` call on an empty dir returns `{ startLine: 1, endLine: N }` matching the appended text's real line count; `report.md`/`capsule.md`/`capsule-index.jsonl` all exist afterward with matching content.
- [ ] A second call's `startLine` is `previous endLine + 1` (no gap, no overlap).
- [ ] Firing 5 concurrent `recordDistillate` calls (no `await` between them) on the same `dir` produces 5 non-overlapping ranges and a `report.md` with exactly 5 entries in some deterministic order (order doesn't need to match call order, but ranges must never overlap and the file must not be corrupted/interleaved).
- [ ] `findCapsuleEntry` returns the right entry by `ruleId` after multiple `recordDistillate` calls; returns `undefined` for an unknown id and for a dir with no `.mekiri/` at all.
- [ ] `readReportRange` returns exactly the body text passed to `recordDistillate` (bounded by the returned range) for a couple of entries, not neighboring entries' content.

- [ ] **Get task 1 reviewed.** Use the code-reviewer subagent (or equivalent) to review this task's diff against this plan file and the design spec. Fix any Critical/Important findings before moving to Task 2.

---

### Task 2 (mekiri-proxy): `tag`/`graft` tool handlers + `prune` wiring

**Depends on:** Task 1's `mekiri-core` exports.

**Files:**
- Edit: `packages/mekiri-proxy/src/mcpServer.ts` — add `tag`/`graft` handlers to `createToolHandlers`, add one `recordDistillate` call inside the existing `prune` handler
- Edit: `packages/mekiri-proxy/test/mcpServer.test.ts` — add cases per below

**`tag` handler** (spec §4):
```ts
tag(args: { fruit: unknown }): Promise<
  | { status: "ok"; rule_id: string }
  | { status: "invalid_fruit"; errors: string[] }
>
```
- `validateFruit({ noteType: "portal", fruit: args.fruit, keepCode: true })`. On failure, return `invalid_fruit`.
- Derive `header` from `fruit.summary`: first line, truncated to ~80 chars (trim, collapse newlines).
- `renderDistillate("portal", fruit)` (existing function, unchanged) for the body.
- `recordDistillate(context.dir, { event: "tag", sessionId: context.sessionId, ruleId: id, noteType: "portal", timestamp }, header, distillateText)`.
- `appendAuditEntry(context.dir, { event: "tag", timestamp, sessionId: context.sessionId, ruleId: id, fruitLength: distillateText.length })`.
- No `postControlRule` call, no `readSessionTranscript`/`findBoundary` — `tag` never touches the trunk.

**`graft` handler** (spec §4):
```ts
graft(args: { target?: string }): Promise<
  | { status: "ok"; mode: "toc"; content: string }
  | { status: "ok"; mode: "full"; content: string }
  | { status: "not_found" }
>
```
- No `target`: `content = await readCapsule(context.dir)`, audit `{ event: "graft", mode: "toc", sessionId: context.sessionId, timestamp }`.
- `target` given: look up via `findCapsuleEntry`; if missing, return `{ status: "not_found" }` (no audit entry on miss). Otherwise `body = await readReportRange(dir, entry.startLine, entry.endLine)`, wrap as `` `[graft: ${entry.event} ${entry.ruleId}, session ${entry.sessionId}, ${entry.timestamp}]\n${body}` ``, audit `{ event: "graft", mode: "full", targetRuleId: args.target, sessionId: context.sessionId, timestamp }`.

**`prune` handler edit:** immediately after `const distillateText = renderDistillate(...)` and id generation (reuse the same `id` already generated for the rewrite rule), add a `recordDistillate(context.dir, { event: "prune", sessionId: context.sessionId, ruleId: id, noteType: args.note_type, timestamp }, header, distillateText)` call before or after the existing `postControlRule`/`appendAuditEntry` calls (order doesn't matter functionally, but keep it before the function returns). Derive `header` the same way as in `tag` — from `args.fruit.summary` for portal, `args.fruit.tried` for death_reload.

**Tests (`mcpServer.test.ts`):**
- [ ] `tag` with valid portal fruit (with `files_touched`) returns `{ status: "ok", rule_id }`; `.mekiri/report.md`/`capsule.md`/`capsule-index.jsonl` reflect it.
- [ ] `tag` with `files_touched` omitted returns `invalid_fruit` (matches `keepCode: true`'s existing `validateFruit` requirement).
- [ ] `graft({})` (no target) returns the capsule contents as `mode: "toc"`.
- [ ] `graft({ target: <rule_id from a prior tag> })` returns `mode: "full"` with the wrapped body containing the original summary text.
- [ ] `graft({ target: "nonexistent" })` returns `{ status: "not_found" }`.
- [ ] After a real `prune` call, `graft({ target: <that prune's rule_id> })` succeeds and returns the prune's distillate — proves `prune` now also writes to the report store, not just `tag`.

- [ ] **Get task 2 reviewed.** Same reviewer pass as Task 1, then run both packages' full test suites (`npm test -w mekiri-core`, `npm test -w mekiri-proxy`) and confirm both are green before considering this plan done.
