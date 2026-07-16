# Claude Duo — Stream Deck Command Center

Your Claude life on a Stream Deck + touch bar: **both accounts' usage**, **live sessions with one-press jump to the exact chat**, Slack/WhatsApp unread badges, a skills launcher — and **Clawd**, the pixel mascot who juggles a soccer ball, morphs into the Claude spark, greets you by name, and punts the ChatGPT logo off your screen.

![Full-bar dashboard](docs/full-bar-dashboard.png)

## The three touch-bar pages (swipe to switch)

### Page 1 — Usage dashboard
- Both Claude accounts side by side: Current (5h) % and Weekly % with bars and "Resets in…" timers. Amber at 70%, red at 90%
- **Clawd** performs a nonstop routine (juggle + kick, walk, spark-morph spin, dance, look around, hop, typing when your agents work, stretch, wave, ChatGPT punt) and the serif headline rotates between "Claude" and personal hellos
- **Tap an account's half** → its usage page opens in that account's own Chrome profile
- **Press a knob** → a brand-new Claude terminal for that side (left = account 1, right = account 2) opens in Warp
- Amber badge + spoken status lines ("2 agents cooking") when sessions wait on you

### Page 2 — Live Sessions board
- Every open Claude Code session as a big card: conversation topic, account color stripe, live status (🟢 working / 🟠 needs you) read from Claude Code's own session registry
- **Twist** a knob to move the highlight, **press or tap** → the exact chat opens on claude.ai in the right Chrome profile, **hold** → jump to the terminal (Warp tab-cycling by title)

### Page 3 — Comms + Skills
- **Slack / WhatsApp** cards showing the dock-badge unread count (read via `lsappinfo`, no APIs or tokens). Tap opens the app
- **Skills dial**: twist through your most-used slash commands, press to run it in a fresh Warp tab

## Install

Requires macOS, Stream Deck app 6.5+, and [Claude Code](https://claude.com/claude-code) logged in.

```bash
git clone https://github.com/fahimbinshad-tech/claude-duo-streamdeck.git
cd claude-duo-streamdeck/com.fahim.claude-duo.sdPlugin
npm install
ln -s "$(pwd)" "$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/com.fahim.claude-duo.sdPlugin"
killall "Stream Deck"; open -a "Elgato Stream Deck"
```

Drag the actions onto your deck. For the full-bar dashboards, fill **all four dial slots** on a page with the same feature's actions (usage: 2× each account; sessions/skills: as you like).

## Configure — `accounts.json`

```bash
cp accounts.example.json accounts.json
```

```json
{
  "personal": { "label": "Personal", "service": "Claude Code-credentials", "chromeProfile": "Profile 22" },
  "business": { "label": "Work", "service": "Claude Code-credentials-xxxxxxxx", "chromeProfile": "Profile 5" },
  "skills": ["/morning-briefing", "/summarize"]
}
```

- **`service`** — the macOS Keychain entry holding that account's Claude Code OAuth token. Default account = `Claude Code-credentials`. A `CLAUDE_CONFIG_DIR` second account gets a suffix (first 8 hex of sha256 of the config dir path). Find yours:
  ```bash
  security dump-keychain 2>/dev/null | grep '"svce"' | grep 'Claude Code' | sort -u
  ```
- **`chromeProfile`** — which Chrome profile holds that Claude account's login (`Profile N` from `~/Library/Application Support/Google/Chrome/Local State`). Deep links open there
- **`skills`** — optional; overrides the skills dial list

## How it works

Dependency-light Node (no SDK framework): speaks the Stream Deck WebSocket protocol directly, renders **PNGs in-process** with `@resvg/resvg-js` + real font files (the Stream Deck app's own SVG text rendering is unreliable), and stitches multi-slot panels by slicing one wide image per slot with `viewBox` offsets.

Data sources — all local, nothing leaves your machine:
- **Usage**: Anthropic's OAuth usage endpoint, using the tokens Claude Code already keeps in the Keychain (read-only; tokens are never refreshed or stored — an expired token just shows "open claude to fix")
- **Sessions**: `~/.claude/sessions/<pid>.json` — Claude Code's live registry (name, status, cwd, pid, claude.ai bridge id) — joined to transcripts for conversation topics
- **Unread badges**: `lsappinfo` dock badge labels
- **Launching**: Warp launch configurations (`warp://launch/…`) for new sessions and skills

## Hacking on it

- `node bin/plugin.js --mock` renders every panel to `logs/*.png` with fake data — **exactly** what the device will show
- `node bin/plugin.js --test` does the same with live data (uses real API calls — be gentle, the endpoint rate-limits bursts)
- Runtime log: `logs/plugin.log` (fetches, taps, launches, and why anything was skipped)
- Apply changes: `killall "Stream Deck"; open -a "Elgato Stream Deck"`
- Design notes and specs live in `docs/`

## Credits

Design inspired by the [Musing](https://musing.framer.website/) hardware monitor and the community's Claude usage plugins ([Claude Deck](https://jonnyelwyn.co.uk/blog/claude-code-usage-on-a-stream-deck/), [streamdeckclaude](https://github.com/Darhkfox/streamdeckclaude), [stream-deck-ai-limits](https://github.com/lenadweb/stream-deck-ai-limits)). Clawd is a fan-made pixel homage to Anthropic's mascot. The ChatGPT punt is affectionate rivalry.

Built with [Claude Code](https://claude.com/claude-code) in one overnight session. MIT license.
