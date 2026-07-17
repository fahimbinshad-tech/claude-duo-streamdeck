# Money Page v2 — Active Clients Roster — PRD

- **Date created:** 2026-07-17
- **Version:** v1
- **Repo / branch:** claude-duo-streamdeck / main
- **Base commit:** a30fd5c
- **Status:** SHIPPED
- **Supersedes:** the invoice-cards Money page shipped in a30fd5c (kept dead prospects like one-off "sent" invoices on screen — rejected by Fahim)

## What Fahim asked (his words)
"I want to know who's active with us, who owes us what, and when... highest-paying client at the top and lowest at the bottom. It will show all clients, and then I can scroll through them or go to the next page. I need the dial scroll."

## Who counts as a client (live, not a manual list)
The GHL **recurring invoice schedules** (status active/scheduled) ARE the roster — 7 today: AgentNaf $900, Melare $750, CHS $700, Hazel's $500, Rene Ruiz $400, Artifice Belleza $400, Greenway $200 = $3,850/mo. One-off prospect invoices (Olutunde, Eric Torres) never appear. A new signed retainer shows up automatically; a cancelled one drops off.

## The page
- **Ranked list, highest payer first.** Card: client name · **$X/mo** · status line:
  - red `owes $700 · 12d late` (unpaid invoice joined from the invoice list)
  - amber `due in 3d`
  - green `paid up`
- **Header:** `MRR $3,850` + `N owe $X` when anyone's behind
- **Dial scrolls** the highlight through all clients, paging past 4 per screen (same feel as the CRM list)
- **Keys:** top 8 clients in rank order, same card content
- **Any press/tap** opens the GHL invoices list
- Poll: schedules + invoices joined every 10 min, read-only, cached for restarts

## Data join
`/invoices/schedule` (roster + monthly amount + rank) ⟕ `/invoices/` per contact: unpaid totals → owed; latest invoice due date → when. Both endpoints verified live 2026-07-17 (`offset=0` required or 422).

## Acceptance
- Roster matches the 7 live schedules exactly, ranked by amount
- Owed/when reflects the live unpaid invoices (currently: everyone paid up)
- Dial scrolls + pages; mock previews approved before ship
