# Clawd v2 + New-Session Launcher + Speech — PRD

- **Date created:** 2026-07-16
- **Version:** v1
- **Repo / branch:** claude-duo-streamdeck / main
- **Base commit:** clawd redesign (time-aware greetings)
- **Status:** IN PROGRESS
- **Supersedes:** none

## 1. New-session launcher
Pressing a dial on the USAGE page (page 1) opens a brand-new Claude terminal for that side's account:
- Knobs under the **Personal** half (columns 0–1) → new Warp tab running `claude`
- Knobs under the **Mi Assist** half (columns 2–3) → new Warp tab running `CLAUDE_CONFIG_DIR=~/.claude2 claude --dangerously-skip-permissions` (same as the `claude2` alias)
- Mechanism: same Warp launch-config trick as the skills dial (`~/.warp/launch_configurations/claude-new.yaml` + `warp://launch/`)
- The old "jump to neediest chat" moves exclusively to the Sessions page (it was redundant on page 1)

## 2. Clawd v2 (accurate to the stickers)
Reference: official sticker art — square-ish body (taller, not squashed), small SQUARE eyes set wide + high, little **arms protruding from the sides**, four longer legs (outer pair at body edges). Angry face = `> <` chevrons. Grid 16w × 12h, rendered bigger (scale 4) in the brand block.

## 3. Constant speech
The line under the wordmark changes every ~8s, mixing:
- Time-aware greetings ("Hey, Night Owl", "Good morning, Fahim")
- Activity quips matched to the current routine (juggling → "watch this touch", typing → "N agents cooking")
- Status facts (working count, "limits looking good")
- Amber "N need you" badge always wins the slot when sessions are waiting

## Acceptance
- Dial press page 1 left/right spawns correct account terminal in Warp
- Mascot visually matches sticker proportions; all 9 routines still animate
- Speech line visibly changes at least every 10s and references real state
