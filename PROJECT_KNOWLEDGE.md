# Deng Parez Monetary System — Project Knowledge Base

> **Purpose of this document**: A complete, self-contained handoff document. A new AI session (or new developer) should be able to read **only this file** and understand the project deeply enough to continue development immediately, without re-scanning the entire repository.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Sister Project (cross-reference)](#2-sister-project-cross-reference)
3. [Architecture Overview](#3-architecture-overview)
4. [Folder Structure](#4-folder-structure)
5. [Codebase Breakdown — File by File](#5-codebase-breakdown--file-by-file)
6. [Database Schema](#6-database-schema)
7. [Business Logic — Royalty Distribution](#7-business-logic--royalty-distribution)
8. [API Reference](#8-api-reference)
9. [External Integrations](#9-external-integrations)
10. [UI / UX System](#10-ui--ux-system)
11. [Developer Conventions](#11-developer-conventions)
12. [Deployment](#12-deployment)
13. [Known Issues & Technical Debt](#13-known-issues--technical-debt)
14. [Future Improvement Roadmap](#14-future-improvement-roadmap)
15. [Quick-start for a New AI Session](#15-quick-start-for-a-new-ai-session)

---

## 1. Project Overview

### What is this?
**Deng Parez Monetary System** is the internal back-office for **Deng Parez** — a music label/management company in the Kurdistan Region. It tracks artists, their royalty revenue from music platforms (YouTube, Spotify via The Orchard, etc.), expenses, additional income, and most importantly **the automatic split of every dollar earned between the artist, the company, and a chain of referrers**.

### Live deployment
- **Production URL**: https://dp.tt-social.com
- **Repo**: `github.com/newrozynetwork-collab/deng-parez-monetary-system` (private, branch `master`)
- **Hosted on**: Railway (auto-deploys on push to `master`)
- **Domain**: `tt-social.com` (with `dp.` subdomain) — DNS via Cloudflare with SSL set to **Flexible** (note: app at the apex of `dp.tt-social.com`, not on the Cloudflare-managed `dengparez.com` zone — those are different zones)

### Core business model the system encodes
For every dollar of revenue from a music platform:
1. **Bank fee** (default 2.5%, per-artist override) is deducted from gross
2. **Net revenue** is split between artist (default 60%) and company (default 40%) — both percentages stored per-artist
3. **Referral commissions** are paid out from the *company's* share to a chain of "L1 / L2 / L3..." referrers — each at a percentage of the company gross
4. **Company net** = company gross − all referral commissions

This is implemented in `services/calculator.js` and invoked anywhere revenue is recorded or previewed (see [Section 7](#7-business-logic--royalty-distribution)).

### Main user flows

1. **Recording revenue** → an admin picks an artist on `/revenue/new`, enters a gross amount and period, and previews the split. On save, `revenue_entries` + N `revenue_distributions` rows are written.
2. **Adding artists** → on `/artists`, with editable referral chain (L1, L2, ...) — referrers come from the new **referrers registry**.
3. **Tracking who's owed money** → `/payments` lists every recipient (artists, referrers, additional-income contacts), their last paid date, days since paid, and a per-person history modal.
4. **Public artist royalty pages** → `/shower/<slug>` is a no-login public page where an artist sees their own monthly royalties (data ingested from a distributor CSV at `/shower/admin`).
5. **Generating per-artist reports** → `/report-generator` is a fully client-side pipeline: drop a distributor CSV, filter/transform, generate styled XLSX reports for each artist.
6. **Expenses & additional income** → `/expenses`, `/additional-income`.
7. **YouTube** → `/youtube` shows per-artist channel stats and revenue, fetched from the YouTube API after each artist authorizes via OAuth (`/connect/<token>`).

### Stakeholders
- **Admin** (Deng Parez staff) — full access to all admin pages
- **Viewer** (read-only role) — can view but not mutate (see `requireAdmin` vs `requireAuth` in `middleware/auth.js`)
- **Artists** (no login) — visit `/shower/<their-slug>` to see their own royalties; visit `/connect/<token>` to authorize YouTube

---

## 2. Sister Project (cross-reference)

There is a **separate sibling repo** that is *not* the same codebase but related:
- **Repo**: `github.com/newrozynetwork-collab/artist-management-system` (private)
- **Local path**: `C:/Users/PC/Desktop/Deng Parez Management System/`
- **Stack**: **Flask 3 + Python**, PostgreSQL on Railway, Bootstrap 5 (Uena template, orange theme `#FF720D`)
- **Deployed at**: `web-production-6c7de.up.railway.app` (no custom domain at the time of writing)
- **Purpose**: Artist *contract* management (contract dates, expirations), work tracking, live music sessions/venues with FullCalendar, custom yes/no feeds (OAC, Spotify), and shareable read-only artist profile links (`/artists/share/<token>`).

The two systems do **not** share a database. They are independent. If a feature touches royalty distribution, revenue, or referrer payments → it belongs in the **Monetary** system (this repo). If it's about artist metadata, contract lifecycle, or live gigs → it belongs in the **Management** system.

---

## 3. Architecture Overview

### Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js (Express 4) |
| DB driver | Knex.js 3 |
| Database | PostgreSQL in production (`DATABASE_URL` env var), SQLite locally (auto-detected — see `knexfile.js`) |
| Sessions | `express-session` + `connect-session-knex` (table `sessions`, auto-created) |
| Auth | Username + password, `bcryptjs` for hashing, role = `admin` or `viewer` |
| Templating | None — server returns static HTML files; all rendering is jQuery on the client |
| CSS framework | Bootstrap 4 + "Mendy" admin theme (purple/pink `#f158d0` accent) |
| JS libs (CDN/local) | jQuery, DataTables 1.10, Feather icons, Chart.js, XLSX.js (SheetJS), JSZip, PapaParse |
| File parsing | `csv-parse/sync` server-side; `XLSX.js` + `PapaParse` client-side |
| Excel generation | `exceljs` (server) and `XLSX.js` (client) |
| YouTube | `googleapis` v171 (OAuth + YouTube Analytics + Data API v3) |
| Hosting | Railway (Procfile: `web: node server.js`) |

### Pattern
- **MPA, not SPA**. Each page is its own static HTML file in `public/pages/` served by an `app.get('/pageX', ...)` route in `server.js`. Pages all include the **same sidebar markup inline** (no template engine), which means schema changes to the sidebar require editing all pages.
- **JSON APIs under `/api/*`** → all called via `App.api()` (a thin jQuery `$.ajax` wrapper in `public/app/common.js`).
- **Knex everywhere** — no ORM, just raw query builder. Most routes do their own SQL composition.
- **Service layer** lives in `services/` for non-trivial logic that is reused across routes (calculator, exporter, royalty shower parser, YouTube API).

### High-level diagram

```
                                        ┌──────────────────────┐
                                        │  Railway PostgreSQL  │
                                        └──────────▲───────────┘
                                                   │ Knex
                                  ┌────────────────┴────────────────┐
                                  │       Express server.js          │
                                  │  ┌────────────┐  ┌─────────────┐ │
   Browser (jQuery + DataTables)──┤  │ /api/*     │  │ static HTML │ │
                                  │  │ (routes/)  │  │ (public/)   │ │
                                  │  └─────▲──────┘  └─────────────┘ │
                                  │        │ uses                    │
                                  │  ┌─────┴──────┐                  │
                                  │  │ services/  │                  │
                                  │  │ calculator │                  │
                                  │  │ exporter   │                  │
                                  │  │ royaltyShower                 │
                                  │  │ youtube    │                  │
                                  │  └────────────┘                  │
                                  └──────────────────────────────────┘

                External integrations: YouTube Data + Analytics + OAuth
                Distributor CSV: The Orchard (parsed by Report Shower)
```

---

## 4. Folder Structure

```
Deng Parez Monetiary System/
├── server.js                  # Entry point — Express setup, route mounting, page routing, migrations on boot
├── knexfile.js                # Knex config — auto-switches PG ↔ SQLite based on DATABASE_URL
├── package.json               # name: deng-parez-monetary-system; start: node server.js
├── Procfile                   # web: node server.js (Railway)
├── README.md                  # Existing project README (light)
│
├── db/
│   ├── migrations/            # Knex migrations 001 → 009 (additive, idempotent — guarded by hasColumn/hasTable)
│   └── seeds/                 # Initial data (default users, categories, etc.)
│
├── routes/                    # Express routers, mounted under /api/<name>
│   ├── auth.js                # Login / logout / me
│   ├── artists.js             # CRUD for artists + their referral_levels
│   ├── referrals.js           # Read-only views of the referral *network* (tree + flat)
│   ├── referrers.js           # NEW (mig 009) — CRUD for the referrer registry
│   ├── revenue.js             # Revenue entry calculate + persist
│   ├── expenses.js            # CRUD expenses
│   ├── income.js              # CRUD additional_income
│   ├── categories.js          # CRUD expense/income categories
│   ├── youtube.js             # OAuth start, callback, channel sync, revenue sync, share-link tokens
│   ├── reports.js             # Aggregate dashboards / exports
│   ├── users.js               # Admin user management
│   ├── import.js              # Bulk artist import (.csv/.xls/.xlsx)
│   ├── royaltyShower.js       # Public per-artist royalty pages + admin ingest
│   └── payments.js            # Payment summary + per-recipient history
│
├── services/                  # Domain logic shared by multiple routes
│   ├── calculator.js          # THE revenue split formula (gross → bank fee → artist/company → referrals)
│   ├── exporter.js            # Excel/CSV export for the artist directory
│   ├── royaltyShower.js       # Distributor CSV parser + ingestion to royalty_rows
│   └── youtube.js             # OAuth client, encryption of refresh tokens, channel/revenue fetchers
│
├── middleware/
│   └── auth.js                # requireAuth (any logged-in user) + requireAdmin (role=='admin' gate)
│
├── public/                    # All static assets served by express.static
│   ├── pages/                 # One HTML file per page (sidebar inlined in each)
│   │   ├── login.html
│   │   ├── dashboard.html
│   │   ├── artists.html         + artist-detail.html
│   │   ├── youtube.html
│   │   ├── connect.html         + connect-universal.html  (public — no auth)
│   │   ├── referrals.html       (network tree+table view)
│   │   ├── referrers.html       (NEW — registry CRUD)
│   │   ├── revenue-entry.html   + revenue-history.html
│   │   ├── expenses.html
│   │   ├── additional-income.html
│   │   ├── reports.html
│   │   ├── user-breakdown.html
│   │   ├── report-generator.html (client-side XLSX/CSV processor)
│   │   ├── payments.html
│   │   ├── shower-admin.html    (CSV ingest UI)
│   │   ├── shower-index.html    (public — list of artist pages)
│   │   ├── shower-artist.html   (public — per-artist royalties)
│   │   └── settings.html
│   │
│   ├── app/                   # Per-page jQuery controllers (vanilla JS, IIFE-style, no bundler)
│   │   ├── common.js          # The App.* utility object (auth, theme, API, formatters, toast)
│   │   ├── dashboard.js
│   │   ├── artists.js         # Artist CRUD + the new referrer dropdown logic
│   │   ├── revenue.js
│   │   ├── payments.js
│   │   └── referrers.js       # NEW — registry page
│   │
│   ├── assets/                # Mendy theme assets — Bootstrap, vendored libs, icons, images
│   ├── css/
│   │   ├── style.min.css      # Mendy theme stylesheet
│   │   └── custom-app.css     # Project-specific overrides + light/dark theme tokens
│   └── js/
│       ├── app.js / app.init.js / custom.js / sidebarmenu.js / waves.js / feather.min.js
│       └── pages/             # Theme demo scripts — not used by us
│
└── data/                      # Runtime SQLite file (when DATABASE_URL is unset). Gitignored.
```

---

## 5. Codebase Breakdown — File by File

### Entry point: `server.js`

**Responsibilities**:
1. Loads `.env`, instantiates Express + Knex.
2. Wires session middleware backed by Knex (table `sessions`, auto-created).
3. Sets `app.set('trust proxy', 1)` only when `DATABASE_URL` is set (Railway always sits behind a proxy).
4. Injects `req.db = db` middleware so every route gets the Knex instance via `req.db`.
5. Mounts API routers under `/api/<name>`.
6. Registers the page routes — each one just `sendFile`'s a static HTML.
7. On boot: `db.migrate.latest()` → if `users` table is empty, runs `db.seed.run()` → starts listening.

**Important quirks**:
- All admin pages are server-rendered as static HTML, but the **sidebar HTML is inlined in every page**. Adding a new sidebar item means editing **all 14 admin HTMLs**. This was historically done with `sed`/Python (see git log: `Add Referrers sidebar item to all pages`).
- The **public** Shower pages and `/connect/<token>` pages do *not* have the sidebar.

### Middleware: `middleware/auth.js`

Tiny — exports two functions:
- `requireAuth` — 401 if no `req.session.userId`.
- `requireAdmin` — 401 if not logged in, 403 if `req.session.role !== 'admin'`.

Read-only routes use `requireAuth`; mutations use `requireAdmin`.

### Routes

#### `routes/auth.js`
- `POST /api/auth/login` — bcrypt compare, on success sets `session.userId`, `session.role`, `session.name`.
- `POST /api/auth/logout` — destroys session.
- `GET /api/auth/me` — returns `{ id, role, name }` from session, 401 if not logged in.

The frontend `App.init(callback)` (in `common.js`) calls `/me` on every page load; on 401 it redirects to `/login`. This is the primary gate.

#### `routes/artists.js`
CRUD for `artists` + their `referral_levels`. Notable:
- `POST /api/artists` and `PUT /api/artists/:id` accept `referrals: [{ level, referrer_id, referrer_name, commission_pct }, ...]`. The route deletes existing levels then re-inserts — full replacement semantics.
- The route persists **both** `referrer_id` (FK to the new `referrers` table) and `referrer_name` (denormalized snapshot, kept in sync on rename in `routes/referrers.js`).
- `POST` defaults: `artist_split_pct ?? 60`, `company_split_pct ?? 40`, `bank_fee_pct ?? 2.5`. Note these use `||` so passing `0` would fall through to defaults — safe in practice because nobody sets 0% but a pitfall to remember.

#### `routes/referrals.js`
**Read-only views** of the referral *network*:
- `GET /api/referrals` — flat list of every referral_levels row joined to its artist, augmented with `total_earned` summed from `revenue_distributions` where `recipient_type = 'referral'` and `recipient_name` matches.
- `GET /api/referrals/tree` — same data shaped as `[{ artist, referrals: [...] }]`.

This is the data source for the existing `/referrals` page (tree + table view).

#### `routes/referrers.js` *(NEW — added with migration 009)*
CRUD for the referrer **registry**:
- `GET /` — all active referrers + computed `artist_count` (from `referral_levels.referrer_id`) and `total_earned` (matched by name from `revenue_distributions`).
- `POST /` — creates; if a soft-deleted record with the same name exists, reactivates it instead of erroring.
- `PUT /:id` — updates; if the `name` changed, also updates `referral_levels.referrer_name` to keep aggregations consistent.
- `DELETE /:id` — soft-deletes (sets `is_active = false`) if the referrer is in use; hard-deletes only if no `referral_levels` rows reference it.

#### `routes/revenue.js`
- `POST /api/revenue/calculate` — accepts `{ artist_id, amount }`, looks up the artist + their referral_levels, calls `services/calculator.js`, returns the full breakdown for live preview.
- `POST /api/revenue` — same calculation but actually persists: writes a `revenue_entries` row + N `revenue_distributions` rows (one per recipient: artist, company, each referrer).
- `GET /api/revenue` — paginated list with joins for display.

#### `routes/payments.js`
Two endpoints powering the Payment History page:
- `GET /api/payments/summary` — aggregates `revenue_distributions` (artists + referrals) and `additional_income.commission_to`. Returns one row per recipient with `totalPaid`, `paymentCount`, `lastPaidAt`, `daysSinceLastPaid`. Sorted by most-overdue first by default.
- `GET /api/payments/history?name=X&type=Y` — full history rows for a single recipient. Reverse-chronological.

Recipient `type` is one of: `artist`, `referral`, `additional`.

#### `routes/royaltyShower.js`
The "Report Shower" — a public-facing royalty viewer.
- `POST /ingest` (admin) — multipart upload, calls `services/royaltyShower.js`. Accepts CSV/TSV/TXT. The frontend `shower-admin.html` converts XLSX to CSV before uploading so this endpoint stays simple.
- `GET /imports` — admin: list of past imports.
- `DELETE /imports/:id` — removes an import + its rows.
- `GET /public/artists` — public list (no auth) for the `/shower` directory.
- `GET /public/artists/:slug` — public per-artist data for `/shower/:slug`.

#### `routes/youtube.js`
The most complex route file. Highlights:
- OAuth: `GET /connect/:artistId` (admin) creates a one-shot share token and a public connect URL.
- Public `GET /connect/redirect?token=...` → drives the OAuth flow on behalf of the artist (no admin login required).
- `GET /callback` — receives the auth code, exchanges it, encrypts the refresh token (via `services/youtube.js`), upserts into `youtube_accounts`. Falls into `youtube_pending_connections` if the artist match isn't yet known (artist authenticates *before* admin links them).
- `POST /sync/:artistId` — pulls fresh stats + revenue using stored refresh token.

#### `routes/import.js`
Bulk artist import — accepts CSV/XLSX, normalizes column aliases, inserts artists with `phone`, `phone2`, `beneficiary`, `contract_start`, `contract_end`, etc. (the columns added in migration 002).

#### `routes/expenses.js`, `routes/income.js`, `routes/categories.js`, `routes/users.js`, `routes/reports.js`
Standard CRUD with admin gates on mutations. Reports does aggregations for the dashboard.

### Services

#### `services/calculator.js` — **CRITICAL**
The single source of truth for the royalty split formula. **All revenue calculations MUST go through this.** Pure function (no DB), 40 lines, exports one function:

```js
calculate({ grossRevenue, bankFeePct, artistSplitPct, companySplitPct, referralLevels })
```

Returns `{ grossRevenue, bankFeePct, bankFee, netRevenue, artistSplitPct, artistShare, companySplitPct, companyGross, referralBreakdown[], totalReferrals, companyNet }`.

Order of operations:
1. `bankFee = round(gross * bankFeePct/100)`
2. `netRevenue = gross - bankFee`
3. `artistShare = round(netRevenue * artistSplitPct/100)`
4. `companyGross = round(netRevenue * companySplitPct/100)`
5. For each referral level: `amount = round(companyGross * level.commissionPct/100)`
6. `companyNet = companyGross - sum(referralAmounts)`

`round()` is half-up to 2 decimals (`Math.round(x * 100) / 100`).

#### `services/royaltyShower.js`
Parses distributor CSVs (The Orchard format) and ingests rows into `royalty_rows`.
- `parseCsvBuffer(buffer)` — auto-detects delimiter (`,` `;` or `\t`), parses with `csv-parse/sync`, returns rows as objects.
- `findCol(headers, ...candidates)` — case-insensitive substring match against header names. Used to find the artist column (`PRODUCT ARTIST`, `TRACK ARTIST`, `Primary Artist`, etc.) and the revenue column (`NET REVENUE`, `NET SHARE ACCOUNT CURRENCY`, etc.).
- `parsePeriod(val)` — handles Date objects, `M/D/YYYY`, `YYYY-MM-DD`, `Month YYYY`, etc. Returns `'YYYY-MM'` or `null`.
- `slugify(name)` — strips diacritics, lowercases, replaces non-alphanumeric with `-`. Used for public URLs.
- `ingestCsv({ db, filename, buffer, uploadedBy })` — orchestration: parse → validate columns → insert one `royalty_imports` row + N batched `royalty_rows`. Returns counts.
- **Important fix in May 2026**: `db('royalty_imports').insert(...)` was missing `.returning('id')`, which caused `(intermediate value) is not iterable` on PostgreSQL. Fixed; now uses `.returning('id')` + array unwrap pattern.
- **Helpful error message** for aggregate-only Orchard reports (Countries / Stores / Statement_periods) — they have no artist column and Shower can't ingest them.

#### `services/youtube.js`
Encrypts/decrypts refresh tokens (so they're not plaintext in the DB), wraps `googleapis` with helper functions:
- `getOAuthClient()` — returns a configured `OAuth2Client` from env vars.
- `encrypt(text)` / `decrypt(text)` — AES-256-GCM with `YT_ENCRYPTION_KEY` env var.
- Channel/revenue fetchers — wrap the Data v3 + Analytics v2 APIs.

#### `services/exporter.js`
Excel/CSV exports for the artist directory. Uses `exceljs` to write styled worksheets (orange header for company branding match).

### Frontend

#### `public/app/common.js` — the `App` global
Every page loads this first. Exposes:
- `App.init(callback)` — calls `/api/auth/me`, redirects to login on 401, otherwise stores user in `App.user`, fills `#user-name` / `#user-role`, hides `.admin-only` elements for viewers, injects the dark-mode toggle, then calls `callback(user)`.
- `App.api(method, url, data)` — promise wrapper around `$.ajax`. Auto-handles 401 (redirect) and toasts errors.
- `App.formatCurrency`, `App.formatNumber`, `App.formatDate`.
- `App.showSuccess(msg)` / `App.showError(msg)` — Bootstrap-styled toasts top-right.
- `App.sourceLabel(source)` / `App.sourceBadge(source)` — pretty-print `youtube` / `platform` / `both`.
- Theme system — `applyTheme(theme)` flips `data-theme` on `<html>` and persists in `localStorage` (`dp-theme` key). The CSS in `custom-app.css` defines all colors via CSS variables under `:root` and `[data-theme="dark"]`.

#### `public/app/artists.js`
Page controller for `/artists`. Recent changes (May 2026):
- Loads the referrers registry once on page load → `referrersList`.
- `addReferralRow(referrerId, referrerName, pct)` — emits a `<select>` dropdown of registered referrers + a `+` button that calls `quickAddReferrer()`.
- `quickAddReferrer(btn)` — `prompt()`s for a name, POSTs to `/api/referrers`, refreshes every dropdown in the modal so the new option appears, auto-selects it for the row that triggered the add.
- Save sends both `referrer_id` (numeric or null) and `referrer_name` (string). Legacy artists with names not matching the registry show a "(legacy)" placeholder option.

#### `public/app/referrers.js` *(NEW)*
Page controller for `/referrers`. Standard list+modal pattern. Listens for the URL hash `#add` → auto-opens the Add modal (driven by the dashboard Quick Action button).

#### `public/app/payments.js`
Page controller for `/payments`. Renders the summary as a DataTable with conditional row colors (red for >60 days overdue, green for <30 days). Each row has a History button → opens a modal that calls `/api/payments/history?name=X&type=Y`.

---

## 6. Database Schema

### Migration order
1. `001_initial.js` — users, artists, referral_levels, revenue_entries, revenue_distributions, expenses, additional_income.
2. `002_extend_artists.js` — adds `phone`, `phone2`, `beneficiary`, `contract_start`, `contract_end`, `contract_years`, `contract_status` to `artists`.
3. `003_categories.js` — `categories` table + `category_id` FK on `expenses` and `additional_income`. Seeds 16 default categories.
4. `004_youtube.js` — `artists.youtube_*` columns + `youtube_accounts` + `youtube_channel_stats` tables.
5. `005_youtube_revenue.js` — `youtube_revenue_history` (monthly per-artist).
6. `006_youtube_connect_tokens.js` — one-shot tokens for the artist-facing OAuth flow.
7. `007_youtube_pending.js` — captures an OAuth-completed channel before the admin matches it to an artist.
8. `008_royalty_shower.js` — `royalty_imports`, `artist_slugs`, `royalty_rows`.
9. `009_referrers.js` *(NEW)* — `referrers` table; adds `referrer_id` FK to `referral_levels`; backfills the registry from existing distinct `referrer_name` values and links `referral_levels.referrer_id` accordingly.

All migrations are written **idempotently** (`hasTable`/`hasColumn` guards) so they can re-run safely.

### Tables (key fields)

#### `users`
`id, username (unique), password_hash (bcrypt), role ('admin' | 'viewer'), name, created_at`

#### `artists`
`id, name, nickname, revenue_type ('youtube'|'platform'|'both'), artist_split_pct (decimal 5,2 default 60), company_split_pct (default 40), bank_fee_pct (default 2.5), notes, phone, phone2, beneficiary, contract_start (date), contract_end, contract_years, contract_status (default 'Active'), youtube_channel_id, youtube_channel_url, youtube_channel_title, youtube_last_sync, created_at`

#### `referral_levels`
`id, artist_id (FK CASCADE), level (int), referrer_name (text — denormalized, kept in sync), referrer_id (FK referrers.id, nullable, ON DELETE SET NULL), commission_pct, created_at`

The denormalized name is intentional: payment-history aggregations match by `recipient_name` against `revenue_distributions.recipient_name`, which is also the name string. Renaming a referrer in the registry triggers an `UPDATE referral_levels.referrer_name` so future payouts continue matching, but historical `revenue_distributions` rows aren't rewritten (their old name persists, which is correct — they were paid under that name at that time).

#### `referrers` *(NEW)*
`id, name (unique, not null), phone, email, social, notes, is_active (default true), created_at, updated_at`

#### `revenue_entries`
`id, artist_id (FK CASCADE), amount (decimal 12,2), source (default 'both'), period_start (date), period_end (date), notes, created_by (FK users), created_at`

#### `revenue_distributions`
`id, revenue_entry_id (FK CASCADE), recipient_type ('artist' | 'company' | 'referral'), recipient_name (text), amount, created_at`

This is the **money-flow truth** — every cell in Payment History is computed from this table.

#### `expenses` / `additional_income`
Standard. `additional_income` notably has `commission_pct` + `commission_to` for "we paid X person Y% of this gig". This is the third source of payments tracked in `/payments`.

#### `categories`
`id, name, type ('expense'|'income'), color (hex), icon (feather name), sort_order, unique(name, type)`

#### `royalty_imports`, `artist_slugs`, `royalty_rows`
The Report Shower's storage. `royalty_rows` is the leaf table (one row per artist/track/store/country/period combination). Indexed on `artist_slug` and `period`.

#### `youtube_*` tables
- `youtube_accounts` — per-artist refresh tokens (encrypted).
- `youtube_channel_stats` — cached channel snapshot.
- `youtube_revenue_history` — month-by-month per-artist.
- `youtube_connect_tokens` — one-shot tokens to seed an OAuth flow without admin login.
- `youtube_pending_connections` — temporary parking lot for channels that authorized before being matched to an artist.

#### `sessions`
Auto-created by `connect-session-knex`. Used by `express-session`. **Does not appear in migrations.**

### Relationships

```
users 1 ─┬─→ revenue_entries.created_by
         ├─→ expenses.created_by
         └─→ additional_income.created_by

artists 1 ─┬─→ N referral_levels
           ├─→ N revenue_entries
           ├─→ 1 youtube_accounts
           ├─→ 1 youtube_channel_stats
           └─→ N youtube_revenue_history

referrers 1 ─→ N referral_levels (NEW)

revenue_entries 1 ─→ N revenue_distributions

royalty_imports 1 ─→ N royalty_rows
artist_slugs (independent — keyed by slug, not FK)

categories 1 ─┬─→ N expenses
              └─→ N additional_income
```

---

## 7. Business Logic — Royalty Distribution

This is the single most important calculation in the system. Reproduced here for clarity.

### Inputs
- `grossRevenue` (number, USD or any single currency)
- `bankFeePct` (default 2.5)
- `artistSplitPct` (default 60)
- `companySplitPct` (default 40 — must sum to 100 with artist; UI auto-calculates the complement)
- `referralLevels: [{ level, referrerName, commissionPct }, ...]`

### Output
```
1. bankFee       = gross × bankFeePct%
2. netRevenue    = gross − bankFee
3. artistShare   = netRevenue × artistSplitPct%
4. companyGross  = netRevenue × companySplitPct%
5. For each referral L (taken from companyGross, NOT netRevenue):
     L.amount    = companyGross × L.commissionPct%
6. totalReferrals = Σ L.amount
7. companyNet    = companyGross − totalReferrals
```

**All numbers are rounded to 2 decimals at every step (half-up).** This means tiny rounding error is possible (the parts may not sum to exactly `gross` to the cent). Acceptable for now — see [Section 13](#13-known-issues--technical-debt).

### Persistence
When a revenue entry is saved, one row is written to `revenue_entries` and **multiple rows** to `revenue_distributions`:
- One with `recipient_type='artist'`, `recipient_name=artist.name`.
- One with `recipient_type='company'`, `recipient_name='Deng Parez'` (or whatever the company name constant is — verify in `routes/revenue.js`).
- One with `recipient_type='referral'`, `recipient_name=L.referrerName` for each level.

### Why split this way?
- **Bank fee taken from gross** matches the real-world flow (the platform converts to USD, the bank takes its cut, then the company sees the rest).
- **Referrals from company gross, not artist share** is the business rule: artists are not impacted by referral chains; referrals are paid out of the company's pocket. This is critical and must NOT change without explicit approval.
- The artist always sees the same share regardless of how long the referral chain is.

---

## 8. API Reference

All endpoints under `/api/*`. All return JSON. All require auth via session cookie unless noted.

### Auth
| Method | Path | Auth | Body / Query | Returns |
|---|---|---|---|---|
| POST | `/api/auth/login` | none | `{ username, password }` | `{ id, username, role, name }` or 401 |
| POST | `/api/auth/logout` | any | — | `{ ok: true }` |
| GET | `/api/auth/me` | any | — | `{ id, role, name }` or 401 |

### Artists
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/artists` | viewer+ | Returns artists with embedded `referrals` array |
| GET | `/api/artists/:id` | viewer+ | Single artist with referrals |
| POST | `/api/artists` | admin | Body includes `referrals: [{ level, referrer_id, referrer_name, commission_pct }]` |
| PUT | `/api/artists/:id` | admin | Same body; replaces referral_levels rows wholesale |
| DELETE | `/api/artists/:id` | admin | Cascade to referral_levels and revenue_entries |

### Referrers (NEW)
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/referrers` | viewer+ | Includes `artist_count` and `total_earned` per row |
| POST | `/api/referrers` | admin | `{ name, phone?, email?, social?, notes? }`. Reactivates soft-deleted by name. |
| PUT | `/api/referrers/:id` | admin | Renames also propagate to `referral_levels.referrer_name` |
| DELETE | `/api/referrers/:id` | admin | Soft-delete if in use, else hard-delete |

### Referrals (read-only, for the network view)
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/referrals` | viewer+ | Flat: every referral_levels row joined to artist + earnings |
| GET | `/api/referrals/tree` | viewer+ | Grouped by artist |

### Revenue
| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/revenue/calculate` | viewer+ | Live preview, no DB write. `{ artist_id, amount }` → calculator output |
| POST | `/api/revenue` | admin | Persists entry + distributions |
| GET | `/api/revenue` | viewer+ | History, paginated, joined to artist |

### Payments
| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/payments/summary` | viewer+ | One row per recipient with last paid + days since |
| GET | `/api/payments/history?name=X&type=Y` | viewer+ | Per-recipient history. `type` = `artist` \| `referral` \| `additional` |

### Expenses / Income / Categories / Users
Standard CRUD. Admin-gated on writes.

### Royalty Shower
| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/shower/ingest` | admin | multipart/form-data with `file` (CSV/TSV) |
| GET | `/api/shower/imports` | admin | Past imports |
| DELETE | `/api/shower/imports/:id` | admin | Cascade to royalty_rows |
| GET | `/api/shower/public/artists` | **public** | Directory listing |
| GET | `/api/shower/public/artists/:slug` | **public** | Per-artist royalties |

### YouTube
| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/youtube/share-link/:artistId` | admin | Generate one-shot connect token + URL |
| GET | `/api/youtube/connect/redirect?token=...` | **public** | Drives OAuth |
| GET | `/api/youtube/callback` | **public** | OAuth callback — exchanges code for refresh token |
| POST | `/api/youtube/sync/:artistId` | admin | Pulls fresh data |

### Page routes (HTML)
Defined in `server.js`. Public ones (no auth):
- `/login`, `/connect`, `/connect/:token`, `/shower`, `/shower/:slug`, `/shower/:slug/:period`

Everything else falls through to the static-files middleware OR the page route, both of which let the browser load the HTML — the auth gate happens on the **first `/api/auth/me` call** from the client.

This means a logged-out user can technically *load* `/dashboard` HTML, but the JS immediately redirects them to `/login`. There is no server-side gate on the page HTML itself — keep this in mind for any "leaked content" concerns.

---

## 9. External Integrations

### YouTube (OAuth + Data v3 + Analytics v2)
- **Required env vars**: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` (must exactly match what's whitelisted in Google Cloud Console for the app).
- **Encryption**: `YT_ENCRYPTION_KEY` — 32-byte hex string used for AES-256-GCM of refresh tokens.
- **Flow**:
  1. Admin clicks "Generate Share Link" on the artist detail page → POST to `/api/youtube/share-link/:artistId` → returns a URL like `https://dp.tt-social.com/connect/<token>`.
  2. Admin sends the URL to the artist (WhatsApp, email — pre-built buttons in the modal).
  3. Artist opens it, gets redirected to Google, consents to read-only YouTube + YouTube Analytics scopes.
  4. Google calls back to `/api/youtube/callback?code=...&state=<token>` → server exchanges the code for tokens, encrypts the refresh token, stores in `youtube_accounts` (or `youtube_pending_connections` if the token is unknown).
  5. Admin clicks Sync → uses the stored refresh token to fetch channel stats + monthly revenue.

### The Orchard (royalty CSV ingestion)
The Orchard is a major music distributor; they email/download monthly statement CSVs (~200MB, 500K rows). The Shower's parser handles their schema. Common headers we look for:
- Artist: `Product Artist`, `Track Artist`, `Primary Artist`, `Artist Name`
- Revenue: `Net Revenue`, `Net Share Account Currency`, `Net Share`, `Earnings`
- Period: `Statement Period`, `Reporting Month`, `Sales Month`, `Transaction Date`

**Known landmines with Orchard files**:
- Sometimes have **double UTF-8 BOMs** at the start (`ef bb bf ef bb bf` — 6 invisible bytes). Parsers that strip one BOM are still confused by the second. PapaParse handles this if you pre-strip; the standalone splitter at `C:/Users/PC/Downloads/The Orchard Reports/split_report.py` strips them all.
- Old Excel `.xls` files (binary, BIFF format) — `XLSX.js` can read them; the Shower frontend converts to CSV client-side before upload.
- Aggregate breakdown reports (Countries, Stores, Statement_periods) have **no artist column** — Shower will refuse them with a friendly error message.

### Cloudflare (DNS only)
- Domain is `tt-social.com` (not `dengparez.com`).
- DNS at Cloudflare; SSL mode is **Flexible** for `dengparez.com` and **Full** would be needed for any subdomain that points to Railway. *(See conversation history: a previous attempt to set up `mg.dengparez.com` was reverted. The two domains are isolated zones.)*

---

## 10. UI / UX System

### Theme
- Base: Bootstrap 4 + the **Mendy** admin template (purple/pink `#f158d0` accent).
- Color tokens are CSS variables in `public/css/custom-app.css`. Each color is defined under `:root` (light) and `[data-theme="dark"]`. Toggle is the moon/sun button injected by `App.injectThemeToggle()`.
- The selected theme is persisted in `localStorage` under key `dp-theme` and applied **synchronously before paint** by an inline `<script>` in the `<head>` of every page (prevents flash of wrong theme).

### Components
- **DataTables** is the default for any tabular data — config is per-page; common options: `pageLength: 25`, `order: [[colIdx, 'asc']]`, `columnDefs` to disable sorting on action columns.
- **Modals** are Bootstrap 4 (`#modal-id` triggered via `$('#modal-id').modal('show')`).
- **Toasts** are fixed-position alerts injected by `App.showSuccess` / `App.showError` (top-right, 3-5s auto-dismiss).
- **Feather icons** via `feather.replace()` after any DOM injection that uses `<i data-feather="...">`.
- **Sidebar** uses the Mendy theme's MetisMenu pattern. **Critical**: the toggle JS lives in `public/js/sidebarmenu.js` and **must be included on every page** (it's not loaded by `app.init.js`). Without it, `has-arrow` submenus (like Revenue → New Entry / History) silently don't expand. *(This was the bug we fixed in commit `Load sidebarmenu.js so has-arrow submenus expand on click`.)*

### Sidebar items (current order, must match in every admin page)
1. Dashboard
2. Artists
3. YouTube
4. Referrals (network view)
5. Referrers (registry — NEW)
6. Revenue ▾ (New Entry / History)
7. Payment History
8. Expenses
9. Additional Income
10. Reports
11. User Breakdown
12. Report Generator
13. Report Shower
14. Settings (admin-only)

### `.admin-only` class
Any sidebar item or button that should be hidden from `viewer` role users gets this class. `App.init` removes them from the DOM for non-admins via `$('.admin-only').hide()`.

### Quick Actions on Dashboard
The dashboard's `Quick Actions` row currently has **5 buttons**: New Revenue, Add Artist, Add Referrer (links to `/referrers#add` which auto-opens the modal), Add Expense, Export Report. Layout: `col-lg col-md-4 col-6` — equal-width on lg+, 3+2 on md, 2 per row on mobile.

---

## 11. Developer Conventions

### File / module
- Routes live in `routes/<resource>.js` and are mounted at `/api/<resource>` in `server.js`.
- Page controllers live in `public/app/<page>.js` and are loaded *after* `common.js` in the corresponding HTML page.
- Service modules live in `services/`. They take `{ db, ... }` for any DB-touching function — never import knex directly inside services.

### SQL conventions (knex)
- **Always use `req.db`** in routes (set by middleware), never `require('../knexfile')` directly.
- For PostgreSQL compatibility, **always use `.returning('id')`** on inserts when you need the new row's id, then unwrap:
  ```js
  const inserted = await db('table').insert({...}).returning('id');
  const id = Array.isArray(inserted)
    ? (typeof inserted[0] === 'object' ? inserted[0].id : inserted[0])
    : inserted;
  ```
- Soft-delete pattern: use `is_active = false` with a `WHERE is_active = true` filter on reads. Hard-delete only when the row has no FKs pointing to it.

### Frontend conventions
- Every page calls `App.init(callback)` first. The callback runs *after* auth confirms.
- Use `App.api()` not raw `$.ajax` — gets you 401 redirection, error toasts, and JSON content-type for free.
- HTML escape with `escapeHtml` / `esc` (defined per-file). **Never** insert user-supplied text into HTML strings without escaping.
- Use `data-feather="icon-name"` then call `feather.replace()` to render — don't hand-write SVGs.

### Naming
- Tables: `snake_case`, plural (`revenue_entries`, `royalty_rows`).
- API routes: kebab-case where natural (`/api/shower/public/artists`), single-word otherwise.
- JS objects from API: `camelCase` for new code, but legacy code mixes `snake_case` (e.g. `artist_split_pct`) — keep going with whatever the row already uses.
- IDs in HTML: prefixed by page abbreviation (`#rev-amount`, `#sw-dropzone`, `#ref-name`) to avoid collision when modals are loaded into pages that have similar fields.

### Commit messages
Conventional but loose. Subject line + bullet list of changes. Always include the trailer:
```
Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

---

## 12. Deployment

### Railway (production)
- App service auto-deploys on every push to `master`.
- PostgreSQL service provisioned in the same Railway project; `DATABASE_URL` is injected automatically.
- `Procfile`: `web: node server.js`. On boot, `server.js` runs `db.migrate.latest()` then `db.seed.run()` if `users` is empty.
- Required env vars: `DATABASE_URL`, `SESSION_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `YT_ENCRYPTION_KEY`.
- `app.set('trust proxy', 1)` is set when `DATABASE_URL` is present (Railway is always behind a proxy → secure cookies need this).

### Local development
- `npm install`
- No env vars needed — `knexfile.js` falls back to SQLite at `./data/database.sqlite`.
- `npm run setup` (= `migrate:latest && seed:run`) on first run.
- `npm start` → http://localhost:3000.
- Default seeded admin: check `db/seeds/` for credentials.

### Database migrations
- New migration: `npx knex migrate:make name_here` → edits go in `db/migrations/`.
- Run: `npx knex migrate:latest` (also runs automatically on Railway boot via `server.js`).
- Rollback: `npx knex migrate:rollback`. **Make sure your `down` function is correct** — production rollbacks have happened.

---

## 13. Known Issues & Technical Debt

### Bugs / weak spots

1. **`||` defaults instead of `??`** in `routes/artists.js`:
   ```js
   artist_split_pct: artist_split_pct || 60
   ```
   This treats `0` as falsy and falls back to 60. Switch to `??` (nullish coalescing). Low impact in practice (nobody sets 0%), but a footgun.

2. **Sidebar duplicated in 14 HTML files**. Adding/renaming a sidebar item requires editing every page or running a script. We've already paid this cost twice (sidebarmenu.js include, Referrers item add). Consider a small build step that injects a shared `_sidebar.html` partial, or migrate to a templating engine (Pug, EJS, or even just a tiny client-side `fetch('/sidebar')` injection).

3. **No CSRF protection**. Sessions are cookie-based and `sameSite: 'lax'`, which mitigates a lot, but a determined attacker on a same-site issue could still POST. Add `csurf` or a custom token middleware if exposing to a hostile domain.

4. **No rate limiting**. `/api/auth/login` is unbottled — easy to brute force. Add `express-rate-limit`.

5. **Rounding accumulation** in the calculator: 2-decimal rounding at every step means parts may not sum exactly to gross. Acceptable today; revisit if accountants complain.

6. **Public Shower endpoints** (`/shower/...`) leak nothing sensitive but DO let anyone enumerate artists by slug. Consider whether per-artist URLs should require an artist-specific token (similar to `/connect/<token>`).

7. **No audit log**. There's no record of *who* edited an artist, who deleted a revenue entry, etc. Mutations are fire-and-forget. The Management System (sister project) has an `AuditLog` table — port the pattern over.

8. **YouTube refresh token** decryption errors are not gracefully handled — they crash the sync route. Wrap with try/catch and surface a user-facing "please reconnect" message.

9. **The "intermediate value is not iterable" PostgreSQL `.insert()` bug pattern** existed in `services/royaltyShower.js` (fixed). **Audit other `const [x] = await db('...').insert(...)` patterns in the codebase** — there may be more. Specific files to grep: `routes/expenses.js`, `routes/income.js`, `routes/categories.js`, `routes/youtube.js`.

10. **Migrations 002+ use `if (!hasColumn)` guards inside `up`** — good for re-runs, but **the `down` functions assume the column exists**. Rolling back a migration that was never fully applied could throw. Verify every `down` matches its `up`.

### Performance

- The artist-list page loads all referrers + all artists + all referral_levels via separate API calls. Fine for hundreds, would degrade past thousands.
- `royalty_rows` has indices on `artist_slug` and `period` — good. But aggregations (`SUM(net_revenue) GROUP BY ...`) are computed on every Shower page load. Cache or materialize if the table grows past a few million rows.
- The Payment History summary aggregates the entire `revenue_distributions` table on every load. Add a covering index on `(recipient_type, recipient_name)`.

### Architecture concerns

- **Mixing inline page-specific JS with shared `app/*.js` files**. Some pages do all logic in-line (`shower-admin.html`), others externalize it (`artists.js`). Pick one convention. External is better for caching and code review.
- **No tests at all**. Even smoke tests on the calculator would catch regressions.
- **`public/app/*.js` is unminified, unbundled**. Fine for now (monolithic Express app); a build step would help if the JS grows.

---

## 14. Future Improvement Roadmap

Listed roughly by ROI (highest first):

1. **Add a tests folder.** Start with `services/calculator.js` — pure function, trivial to unit test, would have caught any change to the split formula. Follow with route-level smoke tests using `supertest`.
2. **Extract sidebar to a partial.** Shared `_sidebar.html`, included via a tiny build-step or fetched at page load. Eliminates the "edit 14 files" problem permanently.
3. **Audit log table.** Port the pattern from the sister Management System. Mutations write `(user_id, action, entity_type, entity_id, details_json, timestamp)`.
4. **CSRF + rate limiting.** Standard hygiene.
5. **Role refinement.** Right now it's binary (admin/viewer). A "label staff" role that can record revenue but not delete artists, and an "accountant" role that can see Payment History but not edit splits, would be useful.
6. **Per-artist currency.** Today everything is implicitly USD. The Orchard reports often arrive in various currencies and the calculator pretends they're all the same. Add a `currency` column to `revenue_entries` and surface it in the UI.
7. **Recurring revenue templating.** Most labels have monthly statements with the same shape — let the user save a "template" (artist + recurring schedule) and auto-create entries from a CSV import.
8. **Artist self-service portal.** Combine the existing `/shower/<slug>` (royalties) and `/connect/<token>` (YouTube auth) into a real artist login, so artists can see their own contracts, royalty history, and update their own contact info.
9. **Cross-system data sync.** The Management System has artist contracts and live sessions; the Monetary System has revenue. They share the artist concept but don't talk. Either (a) merge them, or (b) build a tiny sync (one direction: Management → Monetary keeps artist names + status in sync).
10. **The Orchard ingestion automation.** Today it's a manual upload. The Orchard supports SFTP delivery and email notification — automate the pipeline so monthly statements show up in the Shower without admin intervention.

---

## 15. Quick-start for a New AI Session

If you're a new Claude/AI session picking this up, here's the fastest path to productivity:

### Step 1 — Read these files in order (max 30 minutes)
1. `server.js` (entry point, route map)
2. `services/calculator.js` (the one calculation that matters)
3. `db/migrations/001_initial.js` and `009_referrers.js` (schema bookends)
4. `routes/revenue.js` and `routes/artists.js` (most-used CRUD paths)
5. `public/app/common.js` (the App.* utility every page uses)
6. `public/pages/dashboard.html` (a representative page — sidebar + page wiring)

### Step 2 — Run locally if possible
```bash
cd "Deng Parez Monetiary System"
npm install
npm run setup      # migrates + seeds
npm start          # http://localhost:3000
```
Default admin login is in `db/seeds/`. Create a fresh artist, record a revenue entry, see it appear in `/payments`.

### Step 3 — Common gotchas to remember
- **Sidebar duplicated** in every page — to add a nav item, edit all 14 admin HTMLs (or write a script).
- **`sidebarmenu.js`** must be included for `has-arrow` submenus to expand. If a submenu is mysteriously dead, this is why.
- **`.returning('id')`** is mandatory on PostgreSQL inserts when destructuring. Without it: `(intermediate value) is not iterable`.
- **Theme toggle** uses CSS variables. Adding new colors → add them under both `:root` and `[data-theme="dark"]` in `custom-app.css`.
- **Public vs admin pages**: `/login`, `/connect`, `/connect/:token`, `/shower`, `/shower/:slug` are PUBLIC. Don't add any auth checks to these.
- **The sister Management System** is a different repo (Flask, separate database) — don't confuse the two when the user mentions "the system".

### Step 4 — The development cycle
1. Make changes locally → commit → push to `master`.
2. Railway redeploys in ~30-60 seconds.
3. Hard-refresh the browser (Ctrl+Shift+R) — the app heavily relies on cached JS.
4. Verify on `https://dp.tt-social.com`.

### Step 5 — When in doubt
- The conversation transcript that produced this doc covers: Report Generator big-CSV fix (PapaParse), Shower multi-file + XLSX support, sidebar `sidebarmenu.js` fix, Payment History (was already built, fixed visibility), Referrers Registry (new), Quick Action button on dashboard, Royalty Shower aggregate-report rejection. Search git log for those keywords for context.
- Keep `services/calculator.js` sacred. Do not change its arithmetic without explicit user sign-off.
- Never log in as admin in JS console — `console.log(App.user)` reveals more than you want in screenshots.

---

*This document was generated 2026-05-03 by Claude Opus 4.6 (1M context) as a self-contained handoff. If this codebase has materially changed since, regenerate by re-running the `Create a comprehensive project knowledge base` prompt.*
