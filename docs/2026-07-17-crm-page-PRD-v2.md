# CRM Page v2 — Category Buttons + Detail View + Skill Keys — PRD

- **Date created:** 2026-07-17
- **Version:** v2
- **Repo / branch:** claude-duo-streamdeck / main
- **Base commit:** 6942c8f
- **Status:** SHIPPED
- **Supersedes:** 2026-07-17-crm-page-PRD-v1.md (the "wall of lead names" layout Fahim rejected)

## Fahim's design (his words, 2026-07-17)
Top keys = filter buttons — "Saved", "Recently Worked", "Follow Up Today", "Leads That Came In Today". Press one → those people pop up in the touch strip. Tap a person → their information displays in the strip.

## CRM page (page 4)
- **Top 4 keys** = category buttons with live counts; active one is lit (tinted + white ring). Categories map to the board's own bars: `saved_at`, `last_worked_at`, `follow_up_at <= end of today`, `created_at >= midnight`
- **Bottom 4 keys** = first four people of the active category; press = detail view
- **Strip list view**: person cards in the category color, one plain-English line each ("2m ago · fb ad", "was due 3d ago", "worked 1h ago", "saved 2d ago")
- **Strip detail view** (tap a card / press a person key): big name, status + stage + temperature, phone + email; **tap = open them on crm.miassist.studio**, **knob = back to list**, **twist = next person**, **hold = Claude CRM briefing**, header tap = the board
- **Smart wake-up**: first fetch picks Follow Up Today if anything's due, else New Today
- **New-lead alert**: auto-jumps to New Today with the person selected + green announcement on page 1 (unchanged from v1)

## Comms page keys
Elgato's leftover Apps/Tutorials folder buttons removed; all 8 keys are now `skillkey` actions — one most-used skill per key (from accounts.json `skills` or the built-in list, `/morning-briefing` first). Press = runs it in a fresh Warp tab.

## Data
Four scoped Supabase queries per poll (60s), all excluding won/lost/disqualified, limit 12 each. Live vocabulary handled: stages `new` and `contacted`; nameless quiz leads fall back to email → formatted phone → "Quiz lead". Names wrap on whole words only.

## Acceptance (verified 2026-07-17)
- All 4 category queries return live rows (probe: saved=1, worked=12, followup=12, newtoday=2)
- Device log after restart: `crm ok: saved=1 worked=12 followup=12 newtoday=2`
- Mock previews approved-pending-Fahim: list, detail, cat keys, person key, skill keys
- Comms page keypad shows 8 skillkey slots; junk folders gone
