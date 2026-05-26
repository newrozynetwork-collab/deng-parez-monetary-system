# Chat Assistant — Design Spec

**Date:** 2026-05-26
**Status:** Draft for review
**Scope:** v1 — artists + revenue flows via natural-language chat
**Target repo:** `deng-parez-monetary-system`

---

## 1. Goal

Replace clickable data entry with conversational data entry for the highest-traffic flows of the Deng Parez monetary system. The admin should be able to type or speak commands like:

- *"Add Hozan with 60% split, referred by Sarah at 5%"*
- *"Record $5000 revenue for Hozan from streaming May 2026"*
- *"Who's overdue on payment?"* (v2)

…and have the system parse, preview, and execute the underlying actions — running through the **same service-layer code paths the existing pages use**.

v1 is intentionally narrow (artists + revenue) to prove the approach before expanding to the remaining sections (expenses, additional income, payments, royalty shower, YouTube, reports, users, categories).

---

## 2. Non-goals

- No replacement of existing pages. Chat is additive. The forms keep working.
- No multi-user collaborative chat. Each admin has their own session.
- No agent that runs unattended. Every mutation either auto-executes a safe add or requires an explicit user confirmation click.
- No new authentication system. Reuses existing session auth.

---

## 3. Decisions (settled)

| Topic | Decision |
|---|---|
| Integration | New page + route inside existing repo (no new service) |
| v1 scope | Artists + revenue only |
| Input | Text + browser voice (Web Speech API, free) |
| LLM | Google Gemini 2.5 Flash, free tier |
| Approach | Native tool-calling (Gemini's function-calling API) |
| Confirmation | Smart: safe adds auto-execute; deletes, updates that touch money, and all `record_revenue` calls confirm |
| Persistence | All turns logged to `chat_messages` table (audit trail) |
| Permissions | Admin only in v1 (viewer role excluded since v1 has mutations) |

---

## 4. Architecture

### 4.1 Request lifecycle

```
[Browser /chat]
    |
    | POST /api/chat  { messages: [...] }
    v
[routes/chat.js  (requireAdmin)]
    |
    | buildToolCatalog(req.db)
    v
[services/gemini.js]  -- sendMessage(systemPrompt, tools, messages) -->  Gemini API
    |
    | response: text  OR  tool_call
    v
[routes/chat.js dispatcher]
    |
    +-- text reply        -> persist to chat_messages, return { reply, actions: [] }
    |
    +-- tool_call (safe)  -> validate args
    |                        -> execute via services/* and req.db
    |                        -> append result message, loop back to Gemini ONCE for narration
    |                        -> return { reply, actions: [{type:'executed', tool, result}] }
    |
    +-- tool_call (needs confirmation)
                             -> persist pending tool call in chat_messages
                             -> return { reply, actions: [{type:'confirm', tool, args, preview?}] }
                             -> UI renders confirmation card
                             -> on "Yes" click, browser POSTs /api/chat/execute
                                with the pending tool reference -> server executes -> returns result
```

### 4.2 New files

```
routes/
  chat.js                  # /api/chat and /api/chat/execute (requireAdmin)
services/
  chatTools.js             # Tool catalog: schemas, safety classifications, dispatch fns
  gemini.js                # Thin wrapper around @google/generative-ai
public/
  pages/chat.html          # Chat page (sidebar inlined, follows Mendy theme)
  app/chat.js              # Page controller
db/migrations/
  010_chat_messages.js     # New table for conversation audit trail
docs/superpowers/specs/
  2026-05-26-chat-assistant-design.md   # This file
```

### 4.3 Modified files

- `server.js` — register the new route mount and the page route; one line each.
- `package.json` — add `@google/generative-ai`.
- `.env.example` — add `GEMINI_API_KEY=`.
- All 14 admin page HTMLs — add the "Chat" sidebar item. This is your known pain point (Section 13.2 of PROJECT_KNOWLEDGE.md). We pay it once.
- `db/seeds/` — no change.

---

## 5. Tool catalog (v1)

All tools live in `services/chatTools.js`. Each tool exports `{ name, description, schema, safety, execute }`.

**`safety` values:** `'read'`, `'safe_write'`, `'needs_confirmation'`.

### 5.1 Read tools (no confirmation)

#### `list_artists`
- **Description:** Search/list artists. Used for disambiguation before any artist-targeted action.
- **Input:** `{ query?: string }` — case-insensitive substring match on `name` and `nickname`. Omit to list all.
- **Output:** `{ matches: [{ id, name, nickname, artist_split_pct, company_split_pct, bank_fee_pct, referrals_count, contract_status }] }`
- **Impl:** `SELECT … FROM artists LEFT JOIN referral_levels ON … WHERE name ILIKE ? OR nickname ILIKE ? GROUP BY artists.id` — mirrors logic from `routes/artists.js` GET.

#### `get_artist`
- **Description:** Full artist record including referral chain.
- **Input:** `{ id_or_name: string|number }`
- **Output:** Full artist object + `referrals: [{ level, referrer_id, referrer_name, commission_pct }]`. If `id_or_name` doesn't resolve to exactly one record: `{ error: 'not_found' | 'ambiguous', candidates?: [...] }` so the LLM can ask the user.

#### `list_referrers`
- **Description:** Search/list referrers from the registry.
- **Input:** `{ query?: string, include_inactive?: false }`
- **Output:** `[{ id, name, phone, email, artist_count, total_earned, is_active }]`

#### `preview_revenue_split`
- **Description:** Compute the revenue split without saving. Used live whenever the user mentions money or asks "what would X look like for artist Y?"
- **Input:** `{ artist: string|number, amount: number }`
- **Output:** Full output of `services/calculator.js` — `{ grossRevenue, bankFee, netRevenue, artistShare, companyGross, referralBreakdown[], companyNet }`. If the artist isn't resolved exactly: `{ error: 'not_found' | 'ambiguous', candidates: [...] }`.
- **Impl:** Look up artist + referral_levels, call `services/calculator.js`. Same code path as `POST /api/revenue/calculate`.

#### `list_recent_revenue`
- **Description:** Recent revenue entries for queries like "what did we record last week?"
- **Input:** `{ artist?: string|number, limit?: number (default 10), since?: ISO date }`
- **Output:** `[{ id, artist_name, amount, source, period_start, period_end, created_at, created_by_name }]`

### 5.2 Safe-write tools (auto-execute)

#### `add_artist`
- **Description:** Create a new artist record, optionally with a referral chain.
- **Input:**
  ```
  {
    name: string,                    // required
    nickname?: string,
    revenue_type?: 'youtube' | 'platform' | 'both' = 'both',
    artist_split_pct?: number = 60,
    company_split_pct?: number = 40,
    bank_fee_pct?: number = 2.5,
    phone?: string, phone2?: string,
    beneficiary?: string,
    contract_start?: ISO date, contract_end?: ISO date,
    contract_years?: number,
    notes?: string,
    referrals?: [{ level: number, referrer_name: string, commission_pct: number }]
  }
  ```
- **Behavior:** For each `referral.referrer_name`, look it up in the registry. If found → use `referrer_id`. If not found → create the referrer first, then link. Mirrors what the existing `routes/artists.js` POST does.
- **Output:** `{ id, name, referrals_created: number, referrers_auto_created: [name, ...] }`
- **Disclosure rule (system prompt):** When `referrers_auto_created` is non-empty, the assistant must say so in its reply (e.g. "Added Hozan. Sarah wasn't in the referrer registry, so I created her too."). This makes side effects visible even though the action auto-executes.

#### `add_referrer`
- **Description:** Create a new referrer in the registry.
- **Input:** `{ name: string, phone?, email?, social?, notes? }`
- **Behavior:** If a soft-deleted referrer with the same name exists, reactivate it (matches existing `routes/referrers.js` semantics).
- **Output:** `{ id, name, reactivated: boolean }`

### 5.3 Confirmation-required tools

For each of these, the route returns a confirmation card to the UI. The UI shows a preview, asks the user, and posts back to `/api/chat/execute` with the pending tool reference (stored server-side, not trusted from client).

#### `update_artist`
- **Input:** `{ id_or_name: string|number, changes: { ...any subset of add_artist fields } }`
- **Confirm because:** A change to splits/fees affects all future revenue. Updates that include `referrals` replace the entire referral chain (matches existing route semantics).
- **Preview shown:** Diff of changed fields, plus a calculator preview for $1000 with the new splits.

#### `update_referrer`
- **Input:** `{ id_or_name: string|number, changes: { name?, phone?, email?, social?, notes? } }`
- **Confirm because:** A rename cascades to `referral_levels.referrer_name` for future payouts (historical `revenue_distributions` rows are intentionally NOT rewritten — same behavior as the existing route).
- **Preview shown:** Diff + count of `referral_levels` rows that will be renamed.

#### `delete_artist`
- **Input:** `{ id_or_name: string|number }`
- **Confirm because:** Cascades to `referral_levels` and `revenue_entries`.
- **Preview shown:** Artist record + count of cascading rows ("This will also delete N revenue entries and M referral records").

#### `delete_referrer`
- **Input:** `{ id_or_name: string|number }`
- **Behavior:** Soft-delete if in use, hard-delete if not (matches existing route).
- **Preview shown:** Referrer record + `artist_count` from `referral_levels`.

#### `record_revenue`
- **Input:**
  ```
  {
    artist: string|number,
    amount: number,
    period_start: ISO date,
    period_end: ISO date,
    source: 'youtube' | 'platform' | 'both' = 'both',
    notes?: string
  }
  ```
- **Confirm because:** Money in. Always confirms regardless of amount.
- **Preview shown:** The full calculator breakdown — same card mock-up from Section 3 of the brainstorm (gross, bank fee, net, artist share, company gross, each referral level, company net).
- **On confirm:** Writes one `revenue_entries` row + N `revenue_distributions` rows. Same code path as the existing `POST /api/revenue` route.

### 5.4 Name resolution contract

Every tool that accepts `id_or_name` follows the same resolution pattern, implemented as a shared helper in `chatTools.js`:

```
resolveArtist(idOrName, db) -> { artist } | { error: 'not_found', query } | { error: 'ambiguous', candidates: [{id, name}, ...] }
```

Same for `resolveReferrer`. Tools return errors as part of their result (not exceptions). The LLM gets the structured error, sees the candidate list, and asks the user to clarify in natural language.

This pattern keeps disambiguation in the language layer where it belongs.

---

## 6. UI design

### 6.1 Page structure

`public/pages/chat.html` follows the Mendy theme. Sidebar inlined (matching all 14 other admin pages). Main content area:

- **Header:** "Chat" title, "Clear conversation" button (top-right)
- **Message thread:** scrollable, auto-scrolls to bottom on new messages
- **Composer:** multiline textarea, mic button, send button

### 6.2 Message types

The thread renders these message shapes, all in `public/app/chat.js`:

1. **`user_text`** — right-aligned bubble. Plain text, HTML-escaped.
2. **`assistant_text`** — left-aligned bubble. Markdown rendered (bold, italics, lists). Uses an inline minimal markdown renderer (no external lib for v1; just bold + line breaks).
3. **`tool_result_table`** — when a read tool ran and the LLM wants to surface structured data. Rendered as a small DataTable.
4. **`confirmation_card`** — body varies by tool:
   - `record_revenue`: calculator preview table (mirrors the existing `revenue-entry.html` preview layout for muscle-memory consistency)
   - `delete_*`: warning text + record details
   - `update_*`: diff of changed fields
   - Buttons: green "Confirm & save" + grey "Cancel"
5. **`error`** — red-tinted bubble. Includes a "Retry" button when applicable.

### 6.3 Composer behavior

- **Enter** sends. **Shift+Enter** newline. **Esc** cancels current request if in-flight.
- **Mic button** uses `window.SpeechRecognition || window.webkitSpeechRecognition`. Click to start, click again or 2s of silence to stop. Transcript appears live in the textarea; the user can edit before sending. If the browser lacks speech recognition (Safari iOS, older browsers), the button is hidden via feature detection.
- While a request is in flight: send button disabled, animated dots in the thread to indicate the assistant is thinking.

### 6.4 Following existing patterns

- Loads `common.js` first; `App.init(callback)` callback wires the chat.
- Every `/api/chat*` call goes through `App.api()` — gets 401 redirect and error-toast behavior.
- `escapeHtml()` applied to every user-supplied string before insertion.
- Feather icons (`data-feather="..."` + `feather.replace()`).
- The "Chat" sidebar item is added with class `.admin-only` so it's hidden from viewers.

---

## 7. Conversation state & persistence

### 7.1 In-memory (browser)

`window.chatState.messages = [{ role, content, ts, ...optional metadata }, ...]`

- Each `/api/chat` request sends the most recent **40 messages** to control free-tier token usage. Older messages are kept in memory for display but not sent to the model.
- "Clear conversation" empties the array and the visible thread.
- Page refresh clears in-memory state.

### 7.2 Server-side (database)

New migration `010_chat_messages.js`:

```js
exports.up = async (knex) => {
  if (!(await knex.schema.hasTable('chat_messages'))) {
    await knex.schema.createTable('chat_messages', (t) => {
      t.increments('id').primary();
      t.integer('user_id').references('id').inTable('users').onDelete('CASCADE');
      t.string('session_key', 64);                    // groups messages from one browser session
      t.string('role', 16).notNullable();             // 'user' | 'assistant' | 'tool' | 'system'
      t.text('content');                              // text content (nullable for pure tool messages)
      t.string('tool_name', 64);                      // nullable
      t.json('tool_args');                            // nullable
      t.json('tool_result');                          // nullable
      t.string('status', 16);                         // 'pending_confirm' | 'executed' | 'cancelled' | null
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.index(['user_id', 'created_at']);
      t.index(['session_key']);
    });
  }
};
exports.down = (knex) => knex.schema.dropTableIfExists('chat_messages');
```

Every turn writes:
- The user's message (role='user')
- The assistant's text reply (role='assistant')
- Each tool call (role='tool', with `tool_name`, `tool_args`, `tool_result`, `status`)

`status='pending_confirm'` is used for confirmation cards. When the user clicks Yes/Cancel, the row is updated to `'executed'` or `'cancelled'`. This makes pending confirmations server-authoritative — the client can't tamper with the args between preview and execution.

### 7.3 Pending tool reference (confirmation flow)

When a tool needs confirmation, server returns:

```json
{
  "reply": "Recording $5000 for Hozan, May 2026 — here's the split:",
  "actions": [{
    "type": "confirm",
    "pending_id": 1234,                          // chat_messages.id of the pending row
    "tool": "record_revenue",
    "preview": { ...calculator output... }
  }]
}
```

Browser stores `pending_id`. Clicking Confirm calls:

```
POST /api/chat/execute
Body: { pending_id: 1234, decision: "confirm" | "cancel" }
```

Server validates ownership (`chat_messages.user_id == session.userId`), status (`pending_confirm`), then executes with the stored args. **The client never re-sends the args.** This prevents tampering and double-execution.

---

## 8. Authentication & permissions

- `routes/chat.js` mounts `requireAdmin` for all endpoints. v1 is admin-only.
- The Chat sidebar item carries `.admin-only` class.
- All tool implementations pass `req.session.userId` into `created_by` columns wherever the existing routes do (revenue entries especially).
- Gemini API key lives only in `process.env.GEMINI_API_KEY`. Never sent to the browser.

**v2 enhancement (deferred):** Add a `viewer` mode that exposes only read tools (`list_*`, `get_*`, `preview_revenue_split`, `list_recent_revenue`). No mutations.

---

## 9. Error handling

### 9.1 LLM API errors

| Failure | Handling |
|---|---|
| Network timeout | Surface "Couldn't reach the assistant. Try again." + retry button. Don't write a tool row. |
| 429 rate limit (Gemini free tier: 15 RPM) | Surface "Slow down — free tier limit reached, try again in a moment." Server-side, queue is not added in v1; we rely on the user pacing. |
| 5xx from Gemini | Same as timeout. |
| Invalid response shape | Log full response, surface "Got a malformed response. Please retry." |

### 9.2 Tool execution errors

| Failure | Handling |
|---|---|
| Validation error (missing required field) | Tool returns `{ error: 'validation', field, message }`. Server loops back to Gemini with the error; Gemini relays it conversationally. |
| Name resolution: not_found | Tool returns `{ error: 'not_found', query }`. LLM tells the user the artist/referrer doesn't exist and asks if they want to create one. |
| Name resolution: ambiguous | Tool returns `{ error: 'ambiguous', candidates }`. LLM asks "Which one?" naturally. |
| DB error (FK constraint, unique violation, etc.) | Tool catches and returns `{ error: 'db', message: <friendly> }`. Server loops back; LLM surfaces. |
| Pending tool not found / wrong user / wrong status | `/api/chat/execute` returns 400 with `{ error: 'invalid_pending' }`. UI shows "This action expired — please re-ask." |

### 9.3 Loop guard

Each `/api/chat` request can trigger at most **one** Gemini → tool → Gemini round-trip. If the LLM tries to call another tool after the first result, the second call is collected and surfaced to the user as a normal reply, but no further tools execute that turn. This prevents runaway loops on the free tier and keeps response latency predictable.

(v2 may relax this to allow short tool chains.)

---

## 10. Testing strategy

### 10.1 Unit tests

- `services/calculator.js` — already untested; add basic unit tests so the chat's `preview_revenue_split` is verified. Pure function, trivial to test.
- `services/chatTools.js` — each tool's `execute` function tested with a mocked `req.db` (using `better-sqlite3` in-memory). Verifies the tool produces the expected DB state for representative inputs.
- `services/gemini.js` — mock the `@google/generative-ai` client; verify request shape (tools, system prompt, history truncation to 40 messages) and response parsing.

### 10.2 Integration / route tests

- `routes/chat.js` with `supertest`:
  - Auth gate (401 without admin session)
  - Round-trip with a stubbed Gemini that returns a known tool call → verify execution and response shape
  - Confirmation flow: pending row created → execute endpoint → state transitions
  - Loop guard

### 10.3 Command corpus (manual / weekly)

A file `tests/chat-corpus.md` with representative natural-language phrases and the expected tool call. Examples:

| Input | Expected tool | Expected args |
|---|---|---|
| `add hozan with 60% commission, referred by sarah at 5%` | `add_artist` | `{name:'hozan', artist_split_pct:60, referrals:[{level:1, referrer_name:'sarah', commission_pct:5}]}` |
| `record $5000 for hozan, may 2026, streaming` | `record_revenue` | `{artist:'hozan', amount:5000, period_start:'2026-05-01', period_end:'2026-05-31', source:'platform'}` |
| `how much did sarah earn this year?` | `list_recent_revenue` then `preview_revenue_split` or aggregate (v2) | — |
| `delete that artist` | `delete_artist` (after disambiguating prior turn) | … |

Not automated against live Gemini in v1 (would burn free-tier quota). Run manually after any prompt or tool-schema change. v2: a CI job that runs against a recorded Gemini cassette.

### 10.4 Manual smoke test before shipping

A 10-step walkthrough doc covering:
1. Add a brand-new artist with two referrers (one new to the registry).
2. Update that artist's split percentages.
3. Record revenue, preview, confirm.
4. Record revenue, preview, cancel.
5. Look up the artist by partial name.
6. Disambiguation: two "Sarah" artists.
7. Delete one artist.
8. Mic input (Chrome).
9. Network failure mid-request (DevTools throttling).
10. Rate-limit response (mock).

---

## 11. Out of scope for v1 (planned v2+)

These are deferred. The architecture supports adding them without rework.

- **Expense / income / category tools** (next slice after v1 ships).
- **Payments queries** ("who's overdue?")
- **Royalty Shower ingestion via chat** (drag-drop a CSV onto the chat? Or a `start_royalty_import` tool that returns an upload URL?)
- **YouTube tools** (generate share link, trigger sync).
- **Reports tools** (run a report, return summary).
- **User management tools** (admin/viewer creation).
- **Multi-step tool chains** (loop guard relaxation).
- **Streaming responses** (token-by-token rendering).
- **Per-user conversation persistence across sessions** (resume yesterday's chat).
- **Viewer-mode read-only chat.**
- **Cost telemetry** (per-user request count, token usage dashboard).

---

## 12. Risks & open questions

| Risk | Mitigation |
|---|---|
| Free-tier rate limit (15 RPM) feels restrictive in heavy use | Surface clear error; consider Haiku 4.5 paid (~$5/mo) as fallback if it becomes a real problem. |
| Gemini tool-calling on the free tier may degrade if Google changes the offering | Keep the LLM behind a `services/gemini.js` boundary so swapping providers is one file change. |
| User says "add hozan" without a commission — defaults to 60/40, but is that what they want every time? | The LLM should confirm defaults verbally in the reply ("Added Hozan with the default 60/40 split — let me know if you want different numbers"). System prompt encodes this. |
| Voice input accuracy on Kurdish/Arabic names | Browser STT is English-biased; Kurdish names will mistranscribe. Mitigation: the textarea is editable post-transcription. Long-term: switch to Whisper (paid) only if voice gets used a lot. |
| 14-file sidebar edit needed (your known pain point) | Same pain as every prior sidebar change. Use a one-time script to add the item to all pages. (See Section 13.2 of PROJECT_KNOWLEDGE.md for the historical pattern.) |
| Audit log gap | The new `chat_messages` table effectively starts the audit trail for the chat surface. Existing UI mutations still aren't audited — out of scope for this work. |

---

## 13. Implementation order (preview for the plan stage)

A rough sketch — the actual plan will be written separately:

1. Schema: migration 010 + bare `routes/chat.js` returning a stub.
2. `services/gemini.js` + a single tool (`list_artists`) end-to-end, no UI.
3. Chat HTML/JS skeleton with one read tool working.
4. Add safe-write tools (`add_artist`, `add_referrer`) with auto-execute path.
5. Add the confirmation pipeline + `record_revenue` (the biggest UX moment).
6. Add `update_*` and `delete_*` with confirmation cards.
7. Add `preview_revenue_split`, `list_recent_revenue`, `get_artist`.
8. Sidebar update across all 14 pages (one-shot script).
9. Tests (unit + integration + corpus doc).
10. Manual smoke walkthrough.
11. Ship.

---

*End of design spec.*
