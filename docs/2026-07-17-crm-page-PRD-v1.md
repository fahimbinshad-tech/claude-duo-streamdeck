# CRM Page (Page 4) + New-Lead Alerts — PRD

- **Date created:** 2026-07-17
- **Version:** v1
- **Repo / branch:** claude-duo-streamdeck / main
- **Base commit:** chatgpt-ball teal fix
- **Status:** SHIPPED
- **Supersedes:** none

## What it is
A fourth swipeable touch-strip page that turns the deck into a speed-to-lead machine: live leads from the miassist.studio CRM (Supabase), one press from lead → board.

## Touch strip (4 encoder slots, `crm` action)
- **Overview panel** (left, wide layout only): new-leads-today count, "N need follow-up" (overdue follow-ups + untouched leads <48h old), tap → opens `/admin/analytics/leads`
- **Lead cards**: name, stage/temperature color stripe (hot=red, warm=amber, cold=blue; else stage color), footer = stage · age, overdue = amber "follow-up due"
- **Twist** = scroll/highlight · **press knob or tap card** = open that lead (`/admin/analytics/contacts?q=<name>`) · **hold** = new Warp tab running a Claude CRM briefing
- Sort: overdue follow-ups first, then newest

## 8 physical keys (`crmlead` action)
One lead per key by position (row-major, newest first after overdue). Press = open that lead. Empty slots render a muted dot.

## New-lead alert (everywhere)
Poll every 60s; newest `created_at` tracked in `logs/crm-state.json` (restart-safe, no re-announcing). On a fresh lead, for 2 minutes:
- Page 1: Clawd's speech line goes green — "NEW: <name>" with pulsing dot (outranks the amber badge and panic line)
- CRM page: overview panel pulses green, header shows the name
- CRM key: count flips green with "new lead!"

## Data + config
- Supabase REST query on `leads` (excludes won/lost/disqualified, limit 24); credentials read at runtime from the CRM repo's `.env.local` — never stored in this repo
- `accounts.json` optional `crm` block: `envPath`, `baseUrl`, `chromeProfile`
- Live board's real stage vocabulary includes `new` (green); nameless quiz leads fall back to email/phone

## Profile surgery
New page `9CDFD585-DEE8-4514-818F-3A8712B8A193` appended to the SD+ profile (4× crm encoders + 8× crmlead keys). Backup in session scratchpad.

## Acceptance (verified 2026-07-17)
- `--mock` renders: strip normal + alert, duo new-lead line, CRM key, lead keys ✓
- Live Supabase probe returns rows with the exact plugin query ✓
- Device: plugin reconnected, `crm-state.json` written on first live fetch ✓
- Profile shows 4 pages after Stream Deck restart ✓
