# Chat Command Corpus

Manual test phrases for the chat assistant. Run after any prompt or tool-schema change. Record results in your shipping checklist.

## v1 — Read tools

| # | Input | Expected behavior |
|---|---|---|
| 1 | `list artists` | Bulleted list of artist names |
| 2 | `show me sarah` (with 2+ Sarahs) | Assistant asks which Sarah |
| 3 | `who is hozan` | Get artist card with referrals |
| 4 | `list referrers` | Bulleted referrer list |
| 5 | `what would 5000 look like for hozan` | preview_revenue_split card with full breakdown |
| 6 | `what revenue did we record last week` | list_recent_revenue table |

## v1 — Safe writes

| # | Input | Expected behavior |
|---|---|---|
| 7 | `add hozan` | Artist created with 60/40 defaults; assistant mentions the defaults |
| 8 | `add hozan with 70% split, referred by sarah at 5%` | Artist created; if Sarah didn't exist, disclosure ("Sarah wasn't in the registry, so I created her too") |
| 9 | `add a new referrer named ahmed, phone 555-1234` | Referrer created |

## v1 — Confirmation required

| # | Input | Expected behavior |
|---|---|---|
| 10 | `record 5000 for hozan from streaming, may 2026` | Confirmation card with calculator preview; Confirm saves to revenue_entries + distributions; Cancel marks cancelled |
| 11 | `change hozan's commission to 70%` | Confirmation card showing the diff; Confirm updates |
| 12 | `delete the artist hozan` | Confirmation card showing cascade counts; Confirm removes |
| 13 | `delete sarah from referrers` | Confirmation card; soft-delete if in use |

## Error and disambiguation

| # | Input | Expected behavior |
|---|---|---|
| 14 | `delete unknownperson` | Assistant says "I couldn't find unknownperson" — no execution |
| 15 | Click Confirm twice on the same card | Second click should fail with "pending action no longer valid" (server-authoritative) |
| 16 | Refresh page mid-confirmation | Pending row remains `pending_confirm` in DB; UI loses the card. Acceptable for v1; v2 could restore pending cards on reconnect. |

## Voice (Chrome only)

| # | Input | Expected behavior |
|---|---|---|
| 17 | Click mic, say "list artists" | Transcript appears in textarea; pressing Enter submits |
| 18 | Click mic on Safari iOS | Mic button is hidden (no SpeechRecognition support) |
