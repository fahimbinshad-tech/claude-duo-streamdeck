# Lead Detail — Notes Scroll on the Dial — PRD

- **Date created:** 2026-07-17
- **Version:** v1
- **Repo / branch:** claude-duo-streamdeck / main
- **Base commit:** 9155e31
- **Status:** SHIPPED
- **Supersedes:** none

## What Fahim asked
"Any way I can scroll to see notes in each lead with the dial?"

## The interaction model (detail view)
| Control | Behavior |
|---|---|
| Knob press | EXIT — back to the people list (unchanged) |
| Dial twist | NEW: scroll this lead's notes, newest → oldest, clamped at the ends |
| Tap the card | open the lead on crm.miassist.studio (unchanged) |
| Bottom person keys | jump to another person's detail (unchanged — replaces twist-as-next-person) |
| Category keys | switch category + exit detail (unchanged) |

## Display
- Note zone label becomes `NOTE 2/5 · 3D AGO` when a lead has multiple notes; stays `LAST NOTE · 1D AGO` for a single note; `no notes yet` unchanged
- Subtle hint `twist: older notes` only when more than one note exists
- Note index resets to newest whenever the selected person, category, or mode changes

## Data (already staged in plugin.js, uncommitted)
The 60s poll now keeps up to 15 notes per lead (newest first) from `lead_notes`, batched in one query; a notes failure never blanks the board. No new API load.

## Trade-off accepted?
Twist stops meaning next-person inside detail. Pending Fahim's go.

## Acceptance
- Twist in detail steps through real notes with correct count + age
- Twist in list mode still moves the highlight (unchanged)
- Knob press still exits to list from any note position
- Mock previews approved before ship
