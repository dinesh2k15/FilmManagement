# Slate Production Desk

Production management for Indian films, built around where productions lose money: star dates that clash, perks beyond contract, late script changes, cash crew payments and vendor GST. One production is shared by the whole team, and each person sees only what their role needs. The interface runs in English, Hindi, Telugu, Tamil, Kannada and Malayalam.

## What each role can do

| Role | Can do |
| --- | --- |
| Producer | Everything: approve or reject changes, invite the team, see the activity log |
| Director | See cost and schedule, request changes, break down scenes |
| Screenwriter | Request changes, break down scenes |
| Line producer | Wrap shoot days with actual cost, mark star dates, swap days, log perks, crew attendance and pay, vendor bills |
| Actor's manager | Mark away dates for the actor they represent only; see contracts |
| Financier | Read-only: overview, change requests, bills and Tally export |

The server checks every permission. The tabs in the app are only a convenience.

## Modules

- **Overview:** budget, spend so far, forecast final cost and the real cost of one slipped day. The forecast scales the remaining days by how far actual days are running over plan, and adds approved changes.
- **Star dates:** a grid of the next 12 shoot days. A red cell means an actor is booked on a day they are away. For each clash the app proposes a swap with a later day where everyone on both days is free; one tap swaps the cast, scenes and location.
- **Contracts:** vanity vans and entourage size against the signed terms, priced per day worked.
- **Change requests:** anyone creative can request a change. Its cost is shown before approval: new shoot days at the real day cost, other costs, and footage already shot that gets thrown away.
- **Crew and pay:** attendance that works offline, a UPI payment link for each person present, a WhatsApp message in the crew member's own language, and tomorrow's call sheet in any of the six languages.
- **Bills and GST:** CGST and SGST for vendors in your GST state, IGST otherwise. Export to Tally as Purchase vouchers (XML) or CSV.
- **Script breakdown:** paste a scene in any of the six languages; Claude returns the heading, cast, props, costumes, special needs and an English summary.
- **Team:** one-time invite codes per role, removal, and an activity log.

## Run it

Needs Node.js 22.13 or later (it uses Node's built-in SQLite, so there is nothing native to compile).

```bash
npm install
npm run seed          # optional: demo production mid-shoot, one login per role
SLATE_DEMO=1 npm start
```

Open http://localhost:3000. Demo logins (password `demo1234`): `producer@demo.slate`, `director@demo.slate`, `writer@demo.slate`, `lineprod@demo.slate`, `manager@demo.slate`, `financier@demo.slate`. `SLATE_DEMO=1` shows them on the sign-in screen; leave it off in production.

With Docker:

```bash
docker build -t slate .
docker run -p 3000:3000 -v slate-data:/app/data -e SLATE_SECRET=$(openssl rand -hex 32) slate
```

## Configuration

| Variable | Purpose |
| --- | --- |
| `SLATE_SECRET` | Signs session cookies. Required in production, 32+ characters. |
| `SLATE_DB` | SQLite file path. Default `data/slate.db`. |
| `PORT` | Default 3000. |
| `ANTHROPIC_API_KEY` | Turns on script breakdown. Without it the endpoint answers 503 with a clear message. |
| `SLATE_MODEL` | Claude model for breakdowns. Default `claude-sonnet-5-5`. |
| `SLATE_TODAY` | Pins "today" (YYYY-MM-DD) for demos and tests. Otherwise today in Asia/Kolkata. |
| `SLATE_DEMO` | `1` shows demo logins on the sign-in screen. |
| `NODE_ENV` | `production` makes cookies Secure and requires `SLATE_SECRET`. |

## Tests

```bash
npm test
```

21 tests: forecast and change-cost maths, overage, clash and swap logic, GST rounding, Tally XML balancing and escaping, and API tests for sign-in, role enforcement, the actor-manager restriction, change approval, day swaps, offline attendance replay, bills and invite codes.

## Layout

```
src/server.js       Express app, security headers, error handling
src/db.js           SQLite schema
src/auth.js         Sign-up, sign-in (bcrypt + httpOnly JWT cookie), membership checks
src/permissions.js  What each role may do
src/api.js          All production endpoints
src/calc.js         Cost, forecast, clash and swap logic (pure, tested)
src/gst.js          GST, Tally XML and CSV (pure, tested)
src/claude.js       Script breakdown through the Claude API
src/seed.js         Demo production
public/             The app: app.js, i18n.js (six languages), styles, service worker, manifest
test/               node:test suites
```

## How offline works

The app installs as a PWA. The service worker serves the app shell and the last copy of each screen's data when there is no signal. Attendance marks made offline go into an outbox on the phone and are sent when the connection returns; the server keeps the newest mark for each person and day, so a late replay never overwrites a newer mark.

## Before real use

- **Translations are drafts.** Have a native speaker review `public/i18n.js` for each language. Admin forms (bills, team, new production) are in English only.
- **Check Tally import with your accountant.** Vouchers use the ledgers `Input CGST`, `Input SGST`, `Input IGST`, the vendor name and the ledger typed on each bill; they must exist in Tally first.
- **Day costs are simplified.** Extra entourage is priced at ₹6,000 a head a day and an extra van at ₹45,000 a day by default (`per_head`, `van_day` on the production).
- **UPI links open the payer's own UPI app.** Nothing is paid from the server; "Mark paid" is a record, not a payment.
- **SQLite suits one production office.** For many productions or heavy concurrent use, move to Postgres; the SQL is plain and isolated in `src/api.js`.
- **Not yet built:** password reset by email, per-scene cast editing, multilingual dubbing schedules, song units, rights and distributor settlements (roadmap phases 3 and 4).
