// Claude Duo Usage — Stream Deck plugin
// Shows Claude Code usage (Current 5h + Weekly) for two Claude accounts.
// Reads OAuth tokens from macOS Keychain (same entries Claude Code maintains),
// polls https://api.anthropic.com/api/oauth/usage every 60s.
//
// Look: modeled on the "Musing" hardware usage monitor — dark purple-black,
// pixel invader + big serif header, huge percentages, pill labels, coral
// bars (amber at 70%, red at 90%), "Resets in ..." lines. Static, no animation.
//
// Touch strip: place the same account action on 2 ADJACENT slots for the big
// wide panel (stitched by column order). 1 slot = compact fallback.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { Resvg } = require('@resvg/resvg-js');

// Rasterize in-process with real font files so the deck shows EXACTLY what we
// design (the Stream Deck app's own SVG font handling is unreliable).
const FONT_OPTS = {
  loadSystemFonts: false,
  fontFiles: [
    '/System/Library/Fonts/Supplemental/Georgia.ttf',
    '/System/Library/Fonts/Supplemental/Georgia Bold.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
  ],
  defaultFontFamily: 'Helvetica',
};
// Memoize: the 450ms mascot heartbeat re-renders every visible key; static
// faces (skills, category buttons, ads keys) produce identical SVG each tick,
// so skip the expensive re-encode for those.
const pngCache = new Map();
function svgToPngDataUri(svg) {
  const hit = pngCache.get(svg);
  if (hit) return hit;
  if (pngCache.size > 300) pngCache.clear();
  const out = rawSvgToPngDataUri(svg);
  pngCache.set(svg, out);
  return out;
}
function rawSvgToPngDataUri(svg) {
  const png = new Resvg(svg, { font: FONT_OPTS }).render().asPng();
  return 'data:image/png;base64,' + Buffer.from(png).toString('base64');
}

const LOG_FILE = path.join(__dirname, '..', 'logs', 'plugin.log');
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.map(String).join(' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
}

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const FETCH_INTERVAL_MS = 120_000; // the endpoint rate-limits; be polite
const RENDER_INTERVAL_MS = 30_000; // keeps "Resets in" countdowns fresh
const backoffUntil = {}; // actionUUID -> timestamp to skip fetches until (429)

// Account config lives in accounts.json (private, gitignored) with
// accounts.example.json as the fallback template. Each entry maps one of the
// two plugin actions to a macOS Keychain entry that Claude Code maintains.
const os = require('os');
function loadAccounts() {
  let cfg = {};
  for (const f of ['accounts.json', 'accounts.example.json']) {
    try {
      cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
      break;
    } catch {}
  }
  const user = os.userInfo().username;
  const defaults = {
    personal: { label: 'Account 1', service: 'Claude Code-credentials' },
    business: { label: 'Account 2', service: null },
  };
  const out = {};
  for (const [key, base] of Object.entries(defaults)) {
    const c = { ...base, ...(cfg[key] || {}) };
    out[`com.fahim.claude-duo.${key}`] = { label: c.label, service: c.service, account: c.account || user, chromeProfile: c.chromeProfile || null };
  }
  return out;
}
const ACCOUNTS = loadAccounts();

// Musing-style palette
const C = {
  bg: '#17151E',
  card: '#252134',
  track: '#3B3554',
  pill: '#3B3554',
  pillText: '#D8D3E8',
  cream: '#F3EDDF',
  muted: '#9A93A8',
  coral: '#E07B54',
  amber: '#FBBF24',
  red: '#F87171',
};

// actionUUID -> { data, error, fetchedAt }
const cache = {};
// actionUUID -> promise guard so a burst of willAppears fires ONE fetch
const inFlight = {};
// streamdeck context -> { action, controller, column }
const contexts = new Map();

// Persist last good data so restarts show numbers instantly (never "retrying")
const CACHE_FILE = path.join(__dirname, '..', 'logs', 'cache.json');
try {
  const saved = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  for (const [uuid, entry] of Object.entries(saved)) {
    if (ACCOUNTS[uuid] && entry.data) cache[uuid] = { ...entry, error: null };
  }
} catch {}
function persistCache() {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); } catch {}
}

function readKeychain(service, account) {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/security',
      ['find-generic-password', '-s', service, '-a', account, '-w'],
      { timeout: 8000 },
      (err, stdout) => (err ? reject(new Error('keychain: ' + err.message)) : resolve(stdout.trim()))
    );
  });
}

function fetchUsage(actionUUID) {
  if (inFlight[actionUUID]) return inFlight[actionUUID];
  inFlight[actionUUID] = doFetchUsage(actionUUID).finally(() => { delete inFlight[actionUUID]; });
  return inFlight[actionUUID];
}

async function doFetchUsage(actionUUID) {
  const acct = ACCOUNTS[actionUUID];
  if (!acct.service) {
    cache[actionUUID] = { ...(cache[actionUUID] || {}), error: 'NOT_CONFIGURED' };
    return;
  }
  if (Date.now() < (backoffUntil[actionUUID] || 0)) return;
  try {
    const raw = await readKeychain(acct.service, acct.account);
    const creds = JSON.parse(raw).claudeAiOauth;
    if (!creds || !creds.accessToken) throw new Error('no accessToken in keychain entry');
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });
    if (res.status === 401 || res.status === 403) throw new Error('EXPIRED');
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after')) || 300;
      backoffUntil[actionUUID] = Date.now() + retryAfter * 1000;
      throw new Error('HTTP 429');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    cache[actionUUID] = { data: parseUsage(json), error: null, fetchedAt: Date.now() };
    persistCache();
    log(`fetch ${acct.label} ok: current=${cache[actionUUID].data.current?.pct}% weekly=${cache[actionUUID].data.weekly?.pct}%`);
  } catch (err) {
    const prev = cache[actionUUID] || {};
    cache[actionUUID] = { ...prev, error: err.message, fetchedAt: prev.fetchedAt };
    log(`fetch ${acct.label} failed:`, err.message);
  }
}

function parseUsage(json) {
  const byKind = {};
  for (const lim of json.limits || []) byKind[lim.kind] = lim;
  const metric = (lim) => (lim ? { pct: lim.percent, resetsAt: lim.resets_at } : null);
  return {
    current: metric(byKind.session),
    weekly: metric(byKind.weekly_all),
    model: metric(byKind.weekly_scoped),
    modelName: byKind.weekly_scoped?.scope?.model?.display_name || null,
  };
}

function barColor(pct) {
  if (pct >= 90) return C.red;
  if (pct >= 70) return C.amber;
  return C.coral;
}

function countdown(iso) {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'now';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const SANS = 'Helvetica';
const SERIF = 'Georgia';

// Pixel space invader, scale s per pixel, coral
const INVADER = [
  '..X.....X..',
  '...X...X...',
  '..XXXXXXX..',
  '.XX.XXX.XX.',
  'XXXXXXXXXXX',
  'X.XXXXXXX.X',
  'X.X.....X.X',
  '...XX.XX...',
];
function invader(x, y, s, color) {
  const parts = [`<g fill="${color}">`];
  for (let r = 0; r < INVADER.length; r++) {
    for (let c = 0; c < INVADER[r].length; c++) {
      if (INVADER[r][c] === 'X') {
        parts.push(`<rect x="${x + c * s}" y="${y + r * s}" width="${s}" height="${s}"/>`);
      }
    }
  }
  parts.push('</g>');
  return parts.join('');
}

// ---- comms board (Slack / WhatsApp dock badges) ----
// macOS exposes each app's dock badge (the red unread bubble) via lsappinfo —
// exactly the number the user sees, no APIs, no tokens.
const COMMS = {
  'com.fahim.claude-duo.slack': {
    app: 'Slack', bundle: 'com.tinyspeck.slackmacgap', accent: '#36C5F0',
  },
  'com.fahim.claude-duo.whatsapp': {
    app: 'WhatsApp', bundle: 'net.whatsapp.WhatsApp', accent: '#25D366',
  },
};
const badges = {}; // app -> { running, label }

function pollBadges() {
  for (const cfg of Object.values(COMMS)) {
    execFile('/usr/bin/lsappinfo', ['info', '-only', 'StatusLabel', cfg.app], { timeout: 4000 }, (err, out) => {
      const running = !err && !!(out || '').trim();
      const m = (out || '').match(/"label"="([^"]*)"/);
      badges[cfg.app] = { running, label: m ? m[1] : '' };
    });
  }
}

function slackLogo(x, y, s) {
  // four-color hash, simplified
  const bars = [
    [`${x + s * 1.2},${y}`, '#36C5F0', 0],
    [`${x + s * 2.8},${y + s * 1.6}`, '#2EB67D', 90],
    [`${x + s * 1.2},${y + s * 2.8}`, '#ECB22E', 0],
    [`${x - 0.4 * s},${y + s * 1.6}`, '#E01E5A', 90],
  ];
  const parts = [];
  for (const [pos, color, rot] of bars) {
    const [px, py] = pos.split(',').map(Number);
    parts.push(`<rect x="${px}" y="${py}" width="${s * 1.1}" height="${s * 2.6}" rx="${s * 0.55}" fill="${color}" transform="rotate(${rot} ${px + s * 0.55} ${py + s * 1.3})"/>`);
  }
  return parts.join('');
}

function whatsappLogo(cx, cy, r) {
  return (
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#25D366"/>` +
    `<polygon points="${cx - r * 0.85},${cy + r * 1.05} ${cx - r * 0.25},${cy + r * 0.6} ${cx - r * 0.75},${cy + r * 0.35}" fill="#25D366"/>` +
    `<path d="M ${cx - r * 0.42} ${cy - r * 0.45} q ${r * 0.12} -${r * 0.18} ${r * 0.26} -${r * 0.04} l ${r * 0.16} ${r * 0.2} q ${r * 0.08} ${r * 0.14} -${r * 0.04} ${r * 0.26} q ${r * 0.06} ${r * 0.34} ${r * 0.42} ${r * 0.5} q ${r * 0.3} ${r * 0.14} ${r * 0.44} ${r * 0.02} q ${r * 0.14} -${r * 0.1} ${r * 0.26} -${r * 0.02} l ${r * 0.18} ${r * 0.18} q ${r * 0.12} ${r * 0.16} -${r * 0.06} ${r * 0.3} q -${r * 0.3} ${r * 0.24} -${r * 0.72} ${r * 0.04} q -${r * 0.6} -${r * 0.3} -${r * 0.86} -${r * 0.78} q -${r * 0.18} -${r * 0.36} ${r * 0.16} -${r * 0.66} z" fill="#FFFFFF"/>`
  );
}

function commsInner(actionUUID, w) {
  const cfg = COMMS[actionUUID];
  const b = badges[cfg.app] || { running: false, label: '' };
  const parts = [];
  parts.push(`<rect width="${w}" height="100" fill="${C.bg}"/>`);
  const badgeColor = cfg.app === 'Slack' ? '#E01E5A' : '#25D366';
  const label = b.label === '•' ? '•' : b.label;
  const hasUnread = b.running && label && label !== '0';

  if (w < 300) {
    // compact single-slot card
    if (cfg.app === 'Slack') parts.push(slackLogo(16, 12, 11));
    else parts.push(whatsappLogo(32, 28, 18));
    parts.push(`<text x="62" y="34" font-family="${SERIF}" font-size="17" font-weight="700" fill="${C.cream}">${esc(cfg.app)}</text>`);
    if (!b.running) {
      parts.push(`<text x="100" y="72" text-anchor="middle" font-family="${SANS}" font-size="11" fill="${C.muted}">closed · tap to open</text>`);
    } else if (hasUnread) {
      parts.push(`<circle cx="100" cy="66" r="22" fill="${badgeColor}"/>`);
      parts.push(`<text x="100" y="${label === '•' ? 78 : 74}" text-anchor="middle" font-family="${SANS}" font-size="${label.length > 2 ? 18 : 24}" font-weight="800" fill="#FFFFFF">${esc(label)}</text>`);
    } else {
      parts.push(`<text x="100" y="74" text-anchor="middle" font-family="${SANS}" font-size="22" fill="${C.muted}">✓</text>`);
    }
    return parts.join('');
  }

  const logoCx = 52;
  if (cfg.app === 'Slack') parts.push(slackLogo(logoCx - 24, 26, 16));
  else parts.push(whatsappLogo(logoCx, 48, 26));
  parts.push(`<text x="${logoCx + 44}" y="42" font-family="${SERIF}" font-size="24" font-weight="700" fill="${C.cream}">${esc(cfg.app)}</text>`);

  if (!b.running) {
    parts.push(`<text x="${logoCx + 45}" y="66" font-family="${SANS}" font-size="12" fill="${C.muted}">closed · tap to open</text>`);
  } else if (hasUnread) {
    parts.push(`<circle cx="${w - 64}" cy="50" r="30" fill="${badgeColor}"/>`);
    parts.push(`<text x="${w - 64}" y="${label === '•' ? 66 : 61}" text-anchor="middle" font-family="${SANS}" font-size="${label.length > 2 ? 24 : 32}" font-weight="800" fill="#FFFFFF">${esc(label)}</text>`);
    parts.push(`<text x="${logoCx + 45}" y="66" font-family="${SANS}" font-size="12" fill="${C.muted}">${label === '•' ? 'new activity' : 'unread'} · tap to open</text>`);
  } else {
    parts.push(`<text x="${w - 64}" y="56" text-anchor="middle" font-family="${SANS}" font-size="26" fill="${C.muted}">✓</text>`);
    parts.push(`<text x="${logoCx + 45}" y="66" font-family="${SANS}" font-size="12" fill="${C.muted}">all clear · tap to open</text>`);
  }
  return parts.join('');
}

// ---- skills dial ----
// Twist through the most-used skills, press to launch it in a fresh Warp tab
// (via a Warp launch configuration, which CAN exec commands).
const SKILLS_ACTION = 'com.fahim.claude-duo.skills';
const DEFAULT_SKILLS = [
  '/morning-briefing', '/summarize', '/pickup', '/ghl-summary',
  '/client-reply', '/eod-summary', '/inbox-cleaner', '/organize-vault',
  '/summarize-chat', '/push-workspace',
];
function loadSkills() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'accounts.json'), 'utf8'));
    if (Array.isArray(cfg.skills) && cfg.skills.length) return cfg.skills;
  } catch {}
  return DEFAULT_SKILLS;
}
const SKILLS = loadSkills();
let skillSel = 0;

function skillsInner(w) {
  const parts = [];
  parts.push(`<rect width="${w}" height="100" fill="${C.bg}"/>`);
  parts.push(spark(18, 14, 8, C.coral));
  parts.push(`<text x="34" y="19" font-family="${SANS}" font-size="11" font-weight="700" letter-spacing="1.5" fill="${C.muted}">SKILLS ${skillSel + 1}/${SKILLS.length}</text>`);
  const cur = SKILLS[skillSel] || '';
  const prev = SKILLS[(skillSel - 1 + SKILLS.length) % SKILLS.length];
  const next = SKILLS[(skillSel + 1) % SKILLS.length];
  let size = 26;
  while (cur.length * size * 0.55 > w - 40 && size > 14) size -= 2;
  parts.push(`<text x="${w / 2}" y="56" text-anchor="middle" font-family="${SANS}" font-size="${size}" font-weight="800" fill="${C.cream}">${esc(cur)}</text>`);
  parts.push(`<text x="14" y="56" font-family="${SANS}" font-size="12" fill="${C.muted}">‹</text>`);
  parts.push(`<text x="${w - 14}" y="56" text-anchor="end" font-family="${SANS}" font-size="12" fill="${C.muted}">›</text>`);
  parts.push(`<text x="${w / 2}" y="80" text-anchor="middle" font-family="${SANS}" font-size="10.5" fill="${C.muted}">${esc(prev)}  ·  twist to pick  ·  ${esc(next)}</text>`);
  parts.push(`<text x="${w / 2}" y="95" text-anchor="middle" font-family="${SANS}" font-size="10.5" font-weight="700" fill="${C.coral}">press dial to run in Warp</text>`);
  return parts.join('');
}

function skillsSlice(sliceIndex, totalSlices) {
  const inner = skillsInner(200 * totalSlices);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="${200 * sliceIndex} 0 200 100">${inner}</svg>`;
}

// Tap on the usage strip -> that account's usage page, in ITS Chrome profile
function openUsage(src) {
  const acct = ACCOUNTS[`com.fahim.claude-duo.${src}`] || {};
  const url = 'https://claude.ai/settings/usage';
  log(`open usage: ${src} chromeProfile=${acct.chromeProfile || 'default browser'}`);
  if (acct.chromeProfile) {
    execFile('/usr/bin/open', ['-na', 'Google Chrome', '--args', `--profile-directory=${acct.chromeProfile}`, url], (e) => { if (e) log('chrome open failed:', e.message); });
  } else {
    execFile('/usr/bin/open', [url], (e) => { if (e) log('open url failed:', e.message); });
  }
}

// Press a knob on the usage page -> brand-new Claude terminal for that side
function launchClaude(src) {
  const isBiz = src === 'business';
  const exec = isBiz
    ? `CLAUDE_CONFIG_DIR=${os.homedir()}/.claude2 claude --dangerously-skip-permissions`
    : 'claude';
  const title = isBiz ? 'claude 2 · mi assist' : 'claude 1 · personal';
  const dir = path.join(os.homedir(), '.warp', 'launch_configurations');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const yaml = `---\nname: claude-new\nwindows:\n  - tabs:\n      - title: ${title}\n        layout:\n          cwd: ${os.homedir()}\n          commands:\n            - exec: ${exec}\n`;
    fs.writeFileSync(path.join(dir, 'claude-new.yaml'), yaml);
    log(`launch new session: ${title}`);
    execFile('/usr/bin/open', ['warp://launch/claude-new.yaml'], (e) => { if (e) log('warp launch failed:', e.message); });
  } catch (e) {
    log('launchClaude error:', e.message);
  }
}

function launchSkill(cmd) {
  const safe = String(cmd).replace(/[^a-zA-Z0-9/_-]/g, '');
  const dir = path.join(os.homedir(), '.warp', 'launch_configurations');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const yaml = `---\nname: claude-skill\nwindows:\n  - tabs:\n      - title: claude ${safe}\n        layout:\n          cwd: ${os.homedir()}\n          commands:\n            - exec: claude "${safe}"\n`;
    fs.writeFileSync(path.join(dir, 'claude-skill.yaml'), yaml);
    log(`launch skill: ${safe}`);
    execFile('/usr/bin/open', ['warp://launch/claude-skill.yaml'], (e) => { if (e) log('warp launch failed:', e.message); });
  } catch (e) {
    log('launchSkill error:', e.message);
  }
}

// ---- skill keys (one most-used skill per physical key) ----
const SKILLKEY_ACTION = 'com.fahim.claude-duo.skillkey';
function skillKeySvg(idx) {
  const cmd = SKILLS[idx];
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">`);
  parts.push(`<rect width="144" height="144" rx="14" fill="${C.bg}"/>`);
  if (!cmd) {
    parts.push(`<text x="72" y="82" text-anchor="middle" font-family="${SANS}" font-size="22" fill="#2A2638">·</text>`);
    parts.push('</svg>');
    return parts.join('');
  }
  parts.push(`<text x="16" y="40" font-family="${SERIF}" font-size="34" font-weight="700" fill="${C.coral}">/</text>`);
  const words = cmd.replace(/^\//, '').split('-');
  const lines = [];
  for (const word of words) {
    if (lines.length && (lines[lines.length - 1] + ' ' + word).length <= 10) lines[lines.length - 1] += ` ${word}`;
    else lines.push(word);
  }
  lines.slice(0, 3).forEach((line, i) => {
    parts.push(`<text x="16" y="${72 + i * 22}" font-family="${SANS}" font-size="18" font-weight="700" fill="${C.cream}">${esc(line)}</text>`);
  });
  parts.push(`<text x="16" y="132" font-family="${SANS}" font-size="11" fill="${C.muted}">press: run</text>`);
  parts.push('</svg>');
  return parts.join('');
}

function commsSlice(actionUUID, sliceIndex, totalSlices) {
  const inner = commsInner(actionUUID, 200 * totalSlices);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="${200 * sliceIndex} 0 200 100">${inner}</svg>`;
}

// ---- the little Claude creature ----
// state-driven pixel mascot: chill (blinks), sleep, working (typing),
// alert (a session needs you), panic (a usage limit is critical)
let mascotFrame = 0;

// Clawd — matched to the official sticker: square-ish body, small SQUARE
// eyes set wide and high, little arms poking out the sides, four longer legs.
// Angry face = "> <" chevrons.
function mascotGrid({ eyes = 'open', step = 0 } = {}) {
  const W = 16;
  const blank = () => Array(W).fill('.');
  const g = [];
  // body rows 0-7 span cols 2..13; arms protrude rows 3-4
  for (let r = 0; r < 8; r++) {
    const row = blank();
    for (let c = 2; c <= 13; c++) row[c] = 'o';
    if (r === 3 || r === 4) { row[0] = 'o'; row[1] = 'o'; row[14] = 'o'; row[15] = 'o'; }
    g.push(row);
  }
  // four legs, rows 8-11 (outer pair at body edges)
  const allLegs = [2, 3, 6, 7, 9, 10, 12, 13];
  const liftA = [2, 3, 9, 10];
  const liftB = [6, 7, 12, 13];
  for (let r = 0; r < 4; r++) {
    const row = blank();
    const planted = r >= 2 && step === 1 ? liftA : r >= 2 && step === 2 ? liftB : allLegs;
    planted.forEach((c) => { row[c] = 'o'; });
    g.push(row);
  }

  const setPx = (row, col) => { if (g[row] && g[row][col] !== undefined) g[row][col] = 'd'; };
  const sq = (r2, c) => { setPx(r2, c); setPx(r2, c + 1); setPx(r2 + 1, c); setPx(r2 + 1, c + 1); };
  if (eyes === 'angry') {
    [[1, 4], [2, 5], [3, 4], [1, 11], [2, 10], [3, 11]].forEach(([r2, c]) => setPx(r2, c));
  } else if (eyes === 'closed') {
    setPx(2, 4); setPx(2, 5); setPx(2, 10); setPx(2, 11);
  } else if (eyes === 'down') {
    sq(3, 4); sq(3, 10);
  } else if (eyes === 'left') {
    sq(1, 3); sq(1, 9);
  } else if (eyes === 'right') {
    sq(1, 5); sq(1, 11);
  } else {
    sq(1, 4); sq(1, 10);
  }
  return g;
}

// idle routine — the creature is never still: it juggles, walks, morphs into
// the spinning Claude spark, looks around, hops, repeat
const IDLE_ACTS = [
  { kind: 'juggle', ticks: 12 },
  { kind: 'alarm', ticks: 6 },
  { kind: 'walk', ticks: 12 },
  { kind: 'spin', ticks: 10 },
  { kind: 'dance', ticks: 10 },
  { kind: 'alarm', ticks: 6 },
  { kind: 'look', ticks: 8 },
  { kind: 'hop', ticks: 8 },
  { kind: 'type', ticks: 10 },
  { kind: 'punt', ticks: 12 },
  { kind: 'stretch', ticks: 8 },
  { kind: 'wave', ticks: 8 },
];
let actIdx = 0;
let actTick = 0;
function advanceMascot() {
  actTick++;
  if (actTick >= IDLE_ACTS[actIdx].ticks) {
    actTick = 0;
    for (let i = 0; i < IDLE_ACTS.length; i++) {
      actIdx = (actIdx + 1) % IDLE_ACTS.length;
      const k = IDLE_ACTS[actIdx].kind;
      // conditional acts: typing needs a working agent, alarm needs a fresh wait
      if (k === 'type' && !sessions.list.some((s) => s.state === 'working')) continue;
      if (k === 'alarm' && !freshWaiting()) continue;
      break;
    }
  }
}

function chillPose(f) {
  const act = IDLE_ACTS[actIdx].kind;
  const t = actTick;
  if (act === 'walk') {
    const dxs = [0, 3, 6, 9, 12, 14, 12, 9, 6, 3, 0, 0];
    return { grid: mascotGrid({ eyes: t < 6 ? 'right' : 'left', step: (t % 2) + 1 }), body: C.coral, bob: t % 2, dx: dxs[t % 12] };
  }
  if (act === 'spin') {
    return { spinSpark: true, body: C.coral };
  }
  if (act === 'look') {
    const dir = ['left', 'left', 'open', 'right', 'right', 'open', 'closed', 'open'][t % 8];
    return { grid: mascotGrid({ eyes: dir }), body: C.coral, bob: t % 2 };
  }
  if (act === 'hop') {
    const hops = [0, -4, -7, -8, -7, -4, 0, 0];
    const airborne = hops[t % 8] < -3;
    return { grid: mascotGrid({ eyes: 'open', step: airborne ? 1 : 0 }), body: C.coral, bob: hops[t % 8] };
  }
  if (act === 'dance') {
    return { grid: mascotGrid({ eyes: 'open', step: (t % 2) + 1 }), body: C.coral, bob: t % 2, dx: t % 2 ? 4 : -4 };
  }
  if (act === 'type') {
    return { grid: mascotGrid({ eyes: 'down', step: (t % 2) + 1 }), body: C.coral, bob: 0 };
  }
  if (act === 'stretch') {
    return { grid: mascotGrid({ eyes: t < 4 ? 'closed' : 'open' }), body: C.coral, bob: t % 4 < 2 ? -3 : 0 };
  }
  if (act === 'wave') {
    return { grid: mascotGrid({ eyes: 'open', step: t % 2 ? 1 : 0 }), body: C.coral, bob: 0 };
  }
  if (act === 'alarm') {
    return { grid: mascotGrid({ eyes: 'angry', step: t % 2 ? 1 : 0 }), body: C.coral, bob: t % 2 ? 2 : 0, bang: true };
  }
  if (act === 'punt') {
    // codex pill slides in, Clawd boots it off the top of the screen
    const kicking = t === 3 || t === 4;
    const eyes = t < 3 ? 'right' : t < 5 ? 'angry' : 'closed';
    return { grid: mascotGrid({ eyes, step: kicking ? 2 : 0 }), body: C.coral, bob: t > 4 ? t % 2 : 0, codex: t };
  }
  // juggle (default) — front-leg kick when the ball is low
  const kicking = t % 4 === 0;
  return { grid: mascotGrid({ eyes: t % 6 === 5 ? 'closed' : 'open', step: kicking ? 2 : 0 }), body: C.coral, bob: t % 2, ball: true };
}

const MASCOT_STATES = {
  chill: (f) => chillPose(f),
  sleep: (f) => ({ grid: mascotGrid({ eyes: 'closed' }), body: C.coral, bob: f % 2 ? 1 : 0, zzz: f % 2 }),
  working: (f) => ({ grid: mascotGrid({ eyes: 'down', step: (f % 2) + 1 }), body: C.coral, bob: f % 2 }),
  alert: (f) => ({ grid: mascotGrid({ eyes: 'angry', step: f % 2 ? 1 : 0 }), body: C.coral, bob: f % 2 ? 2 : 0, bang: true }),
  panic: (f) => ({ grid: mascotGrid({ eyes: 'angry', step: (f % 2) + 1 }), body: C.red, bob: f % 2 ? 3 : 0, bang: true, sweat: f % 2 }),
};

// time-aware greetings, like Claude Code's own hellos
const GREET_SETS = {
  night: ['Hey, Night Owl', 'burning midnight tokens', 'sleep is a feature, Fahim'],
  morning: ['Morning, Fahim', 'coffee + Claude', 'rise and build'],
  day: ["Hey Fahim, how's it going?", 'what are we shipping?', 'locked in'],
  evening: ['evening, boss', 'golden hour grind', 'one more win today?'],
};
// the big serif wordmark itself rotates between the brand and personal hellos
const HEADLINES = ['Claude', 'Hello, Fahim', 'Claude', "how's it going?", 'Claude', 'Hey, Fahim'];
function headline() {
  const h = new Date().getHours();
  const pool = [...HEADLINES];
  if (h < 5 || h >= 21) pool.push('Night Owl mode');
  return pool[Math.floor(mascotFrame / 66) % pool.length]; // ~every 30s
}
function fitSerif(text, maxW, startSize, minSize) {
  let s = startSize;
  while (text.length * s * 0.52 > maxW && s > minSize) s--;
  return s;
}

function greeting() {
  const h = new Date().getHours();
  const set = h < 5 ? GREET_SETS.night : h < 12 ? GREET_SETS.morning : h < 17 ? GREET_SETS.day : h < 21 ? GREET_SETS.evening : GREET_SETS.night;
  return set[Math.floor(mascotFrame / 66) % set.length];
}

// constant chatter — quips tied to the current routine + live status facts
const ACT_QUIPS = {
  juggle: ['watch this touch', 'better than Messi?', 'first touch: elite'],
  alarm: ['a chat needs you!', 'someone is waiting on you'],
  walk: ['pacing, plotting', 'idea loading', 'thinking walk'],
  spin: ['going full asterisk', 'brand moment'],
  dance: ['ship-it dance', 'small W, big vibes'],
  look: ['scanning the board', 'all systems good?'],
  hop: ['zoomies', 'bounce check'],
  type: ['agents cooking', 'tokens flying', 'deep work mode'],
  stretch: ['brb, stretching', 'posture check'],
  wave: ['hey Fahim', 'yo, boss', 'sup Fahim'],
  punt: ['bye, ChatGPT', 'get punted', 'not on my deck'],
};
function speech() {
  // a brand-new lead beats everything Clawd has to say
  const alert = leadAlertFresh();
  if (alert) return `NEW LEAD: ${alert.name}!`;
  const bucket = Math.floor(mascotFrame / 18); // new line ~every 8s
  const working = sessions.list.filter((s) => s.state === 'working').length;
  const status = working > 0 ? [`${working} agent${working > 1 ? 's' : ''} cooking`, 'limits looking good'] : ['limits looking good', 'plenty of runway'];
  const quips = ACT_QUIPS[IDLE_ACTS[actIdx].kind] || [];
  const pool = [greeting(), ...quips, ...status];
  return pool[bucket % pool.length];
}

function mascotState() {
  let worst = 0;
  for (const entry of Object.values(cache)) {
    for (const m of [entry.data?.current, entry.data?.weekly]) {
      if (m && m.pct > worst) worst = m.pct;
    }
  }
  if (worst >= 90) return 'panic';
  if (!sessions.list.length) return 'sleep';
  // the show always runs — "needs you" is an act in the rotation, not a lock
  return 'chill';
}

function freshWaiting() {
  return sessions.list.some((s) => s.state === 'waiting' && s.ageMs < 10 * 60_000);
}

function mascotSvg(x, y, scale, state, frame) {
  const { grid, body, bob = 0, dx = 0, zzz, bang, sweat, ball, spinSpark, codex } = MASCOT_STATES[state](frame);
  if (spinSpark) {
    const cx = x + 8 * scale;
    const cy = y + 4.5 * scale;
    const angle = (actTick * 40) % 360;
    return `<g transform="rotate(${angle} ${cx} ${cy})">${spark(cx, cy, 4.8 * scale, body)}</g>`;
  }
  const colors = { o: body, d: '#332017', w: '#BFDBFE' };
  const parts = [`<g>`];
  x += dx;
  const yy = y + bob;
  grid.forEach((row, r) => {
    row.forEach((ch, c) => {
      if (colors[ch]) parts.push(`<rect x="${x + c * scale}" y="${yy + r * scale}" width="${scale}" height="${scale}" fill="${colors[ch]}"/>`);
    });
  });
  if (sweat) {
    parts.push(`<rect x="${x - scale}" y="${yy + scale}" width="${scale}" height="${scale}" fill="#BFDBFE"/>`);
    parts.push(`<rect x="${x + 15 * scale}" y="${yy + 3 * scale}" width="${scale}" height="${scale}" fill="#BFDBFE"/>`);
  }
  if (zzz !== undefined) {
    parts.push(`<text x="${x + 15 * scale}" y="${yy + (zzz ? 2 : 4) * scale}" font-family="${SANS}" font-size="${scale * 3.2}" font-weight="800" fill="${C.muted}">z</text>`);
    parts.push(`<text x="${x + 17 * scale}" y="${yy + (zzz ? 5 : 3) * scale}" font-family="${SANS}" font-size="${scale * 2.2}" font-weight="800" fill="${C.muted}">z</text>`);
  }
  if (bang) {
    parts.push(`<text x="${x + 15.5 * scale}" y="${yy + 4 * scale}" font-family="${SANS}" font-size="${scale * 5}" font-weight="900" fill="${body === C.red ? C.red : C.amber}">!</text>`);
  }
  if (codex !== undefined) {
    // ChatGPT blossom gets kicked like a ball: slide in, boot, fly off spinning
    const traj = [
      [28, 8], [24.5, 8], [21, 8], [18.5, 8],     // rolling in
      [18, 6.5], [20, 3], [22.5, -0.5], [25, -4], // launched
      [27.5, -7.5], [30, -11], [32, -14], [34, -17],
    ];
    const [cxg, cyg] = traj[Math.min(codex, traj.length - 1)];
    const bx = x + cxg * scale;
    const by = yy + cyg * scale;
    const rot = codex > 3 ? (codex - 3) * 40 : codex * 15;
    parts.push(chatgptLogo(bx, by, 2.7 * scale, rot));
  }
  if (ball) {
    // soccer ball juggle — foot, knee, header, knee
    const spots = [[17.4, 8.2], [18, 4.6], [16.2, -0.6], [18, 4.6]];
    const [bc, br] = spots[actTick % 4];
    const bx = x + bc * scale;
    const by = yy + br * scale;
    const rr = scale * 1.35;
    parts.push(`<circle cx="${bx}" cy="${by}" r="${rr}" fill="#F5F0E5" stroke="#332017" stroke-width="1"/>`);
    parts.push(`<circle cx="${bx}" cy="${by}" r="${rr * 0.38}" fill="#332017"/>`);
  }
  parts.push('</g>');
  return parts.join('');
}

// ChatGPT "ball" — white blossom on the teal app-icon circle, so it pops on
// the dark background instead of melting into it
function chatgptLogo(cx, cy, r, rot = 0) {
  const parts = [`<g transform="rotate(${rot} ${cx} ${cy})">`];
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="#74AA9C" stroke="#F0EEE6" stroke-width="${(r * 0.1).toFixed(1)}"/>`);
  for (let i = 0; i < 6; i++) {
    parts.push(`<ellipse cx="${cx}" cy="${cy - r * 0.44}" rx="${r * 0.2}" ry="${r * 0.48}" fill="#FFFFFF" transform="rotate(${i * 60} ${cx} ${cy})"/>`);
  }
  parts.push(`<circle cx="${cx}" cy="${cy}" r="${r * 0.24}" fill="#74AA9C"/>`);
  parts.push('</g>');
  return parts.join('');
}

// Small static Claude spark
function spark(cx, cy, r, color) {
  const rays = [
    [0, 1], [33, 0.82], [66, 0.95], [98, 0.78], [131, 1], [164, 0.85],
    [196, 0.92], [229, 0.8], [262, 1], [295, 0.84], [327, 0.9],
  ];
  const parts = [`<g stroke="${color}" stroke-width="${Math.max(2, r * 0.3).toFixed(1)}" stroke-linecap="round">`];
  for (const [deg, len] of rays) {
    const a = (deg * Math.PI) / 180;
    parts.push(`<line x1="${(cx + Math.cos(a) * r * 0.18).toFixed(1)}" y1="${(cy + Math.sin(a) * r * 0.18).toFixed(1)}" x2="${(cx + Math.cos(a) * r * len).toFixed(1)}" y2="${(cy + Math.sin(a) * r * len).toFixed(1)}"/>`);
  }
  parts.push('</g>');
  return parts.join('');
}

function pillWidth(text, fontSize) {
  return Math.round(text.length * fontSize * 0.62) + 14;
}
function pill(xRight, yTop, text, fontSize) {
  const w = pillWidth(text, fontSize);
  const h = fontSize + 8;
  const x = xRight - w;
  return (
    `<rect x="${x}" y="${yTop}" width="${w}" height="${h}" rx="${h / 2}" fill="${C.pill}"/>` +
    `<text x="${x + w / 2}" y="${yTop + h - 6}" text-anchor="middle" font-family="${SANS}" font-size="${fontSize}" font-weight="600" fill="${C.pillText}">${esc(text)}</text>`
  );
}

// Musing-style metric card: big %, pill label, bar, "Resets in ..."
function card(m, label, x, y, w, h, opts = {}) {
  if (!m) return '';
  const pct = Math.max(0, Math.min(100, Math.round(m.pct)));
  const color = barColor(pct);
  const pad = opts.pad ?? 10;
  const pctSize = opts.pctSize ?? 30;
  const pillSize = opts.pillSize ?? 10;
  const barH = opts.barH ?? 9;
  const subSize = opts.subSize ?? 10;
  const parts = [];
  parts.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="9" fill="${C.card}"/>`);
  // auto-shrink the % so it can never collide with the pill
  const pctText = `${pct}%`;
  const avail = w - pad * 2 - pillWidth(label, pillSize) - 5;
  let size = pctSize;
  while (pctText.length * size * 0.62 > avail && size > 12) size -= 1;
  parts.push(`<text x="${x + pad}" y="${y + pad + pctSize * 0.78}" font-family="${SANS}" font-size="${size}" font-weight="800" fill="${C.cream}">${esc(pctText)}</text>`);
  parts.push(pill(x + w - pad, y + pad + 1, label, pillSize));
  const barY = y + pad + pctSize * 0.78 + 9;
  const barW = w - pad * 2;
  const fillW = Math.max(4, Math.round((pct / 100) * barW));
  parts.push(`<rect x="${x + pad}" y="${barY}" width="${barW}" height="${barH}" rx="${barH / 2}" fill="${C.track}"/>`);
  parts.push(`<rect x="${x + pad}" y="${barY}" width="${fillW}" height="${barH}" rx="${barH / 2}" fill="${color}"/>`);
  const sub = m.resetsAt ? `Resets in ${countdown(m.resetsAt)}` : 'Idle';
  parts.push(`<text x="${x + pad}" y="${barY + barH + subSize + 4}" font-family="${SANS}" font-size="${subSize}" fill="${C.muted}">${esc(sub)}</text>`);
  return parts.join('');
}

function errorInner(entry, cx, cy) {
  const parts = [];
  if (entry.error === 'EXPIRED') {
    parts.push(`<text x="${cx}" y="${cy}" text-anchor="middle" font-family="${SANS}" font-size="14" font-weight="700" fill="${C.red}">TOKEN EXPIRED</text>`);
    parts.push(`<text x="${cx}" y="${cy + 18}" text-anchor="middle" font-family="${SANS}" font-size="10" fill="${C.muted}">open claude to fix</text>`);
  } else if (entry.error === 'NOT_CONFIGURED') {
    parts.push(`<text x="${cx}" y="${cy}" text-anchor="middle" font-family="${SANS}" font-size="14" font-weight="700" fill="${C.amber}">ADD ACCOUNT</text>`);
    parts.push(`<text x="${cx}" y="${cy + 18}" text-anchor="middle" font-family="${SANS}" font-size="10" fill="${C.muted}">edit accounts.json</text>`);
  } else if (entry.error) {
    parts.push(`<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-family="${SANS}" font-size="12" fill="${C.amber}">retrying…</text>`);
  } else {
    parts.push(`<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-family="${SANS}" font-size="12" fill="${C.muted}">loading…</text>`);
  }
  return parts.join('');
}

// 144x144 key — the Musing device layout: header + two stacked cards
function renderSvg(actionUUID) {
  const acct = ACCOUNTS[actionUUID];
  const entry = cache[actionUUID] || {};
  const d = entry.data;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">`);
  parts.push(`<rect width="144" height="144" rx="14" fill="${C.bg}"/>`);
  parts.push(invader(8, 6, 1.6, C.coral));
  parts.push(`<text x="78" y="19" text-anchor="middle" font-family="${SERIF}" font-size="17" font-weight="700" fill="${C.cream}">${esc(acct.label)}</text>`);
  parts.push(spark(133, 12, 6, C.coral));
  if (d && d.current) {
    parts.push(card(d.current, 'Current', 6, 26, 132, 55, { pad: 8, pctSize: 22, pillSize: 9, barH: 7, subSize: 9 }));
    parts.push(card(d.weekly, 'Weekly', 6, 84, 132, 55, { pad: 8, pctSize: 22, pillSize: 9, barH: 7, subSize: 9 }));
  } else {
    parts.push(errorInner(entry, 72, 80));
  }
  parts.push(`</svg>`);
  return parts.join('');
}

// Touch strip content, width = 200 (compact) or 400+ (wide, spans 2 slots)
function stripInner(actionUUID, w) {
  const acct = ACCOUNTS[actionUUID];
  const entry = cache[actionUUID] || {};
  const d = entry.data;
  const parts = [];
  parts.push(`<rect width="${w}" height="100" fill="${C.bg}"/>`);

  if (w >= 400) {
    // header: invader + account name serif + spark
    parts.push(invader(10, 5, 1.7, C.coral));
    parts.push(`<text x="${w / 2}" y="21" text-anchor="middle" font-family="${SERIF}" font-size="19" font-weight="700" fill="${C.cream}">${esc(acct.label)}</text>`);
    parts.push(spark(w - 18, 13, 7, C.coral));
    if (d && d.current) {
      const cardW = (w - 8 * 2 - 8) / 2;
      parts.push(card(d.current, 'Current', 8, 28, cardW, 66, { pad: 10, pctSize: 26, pillSize: 10, barH: 9, subSize: 10 }));
      parts.push(card(d.weekly, 'Weekly', 8 + cardW + 8, 28, cardW, 66, { pad: 10, pctSize: 26, pillSize: 10, barH: 9, subSize: 10 }));
    } else {
      parts.push(errorInner(entry, w / 2, 60));
    }
  } else {
    parts.push(invader(6, 4, 1.3, C.coral));
    parts.push(`<text x="104" y="15" text-anchor="middle" font-family="${SERIF}" font-size="14" font-weight="700" fill="${C.cream}">${esc(acct.label)}</text>`);
    if (d && d.current) {
      const cardW = (200 - 6 * 2 - 6) / 2;
      parts.push(card(d.current, 'Now', 6, 22, cardW, 72, { pad: 7, pctSize: 24, pillSize: 9, barH: 8, subSize: 9 }));
      parts.push(card(d.weekly, 'Week', 6 + cardW + 6, 22, cardW, 72, { pad: 7, pctSize: 24, pillSize: 9, barH: 8, subSize: 9 }));
    } else {
      parts.push(errorInner(entry, 100, 55));
    }
  }
  return parts.join('');
}

function stripSlice(actionUUID, sliceIndex, totalSlices) {
  const inner = stripInner(actionUUID, 200 * totalSlices);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="${200 * sliceIndex} 0 200 100">${inner}</svg>`;
}

// Unified dashboard: BOTH accounts across the whole touch bar (usually 800px).
// Big Claude brand block on the left, then Personal + Mi Assist groups.
function duoInner(w) {
  const parts = [];
  parts.push(`<rect width="${w}" height="100" fill="${C.bg}"/>`);
  let x0 = 4;
  if (w >= 760) {
    const st = mascotState();
    parts.push(mascotSvg(8, 26, 3.6, st, mascotFrame));
    const head = headline();
    const oneSize = fitSerif(head, 104, 26, 19);
    let speechY = 70;
    if (head.length * oneSize * 0.52 <= 104) {
      parts.push(`<text x="88" y="48" font-family="${SERIF}" font-size="${oneSize}" font-weight="700" fill="${C.cream}">${esc(head)}</text>`);
    } else {
      // long hello -> stack it on two serif lines
      let cut = head.indexOf(' ', Math.floor(head.length / 2) - 2);
      if (cut < 1) cut = head.lastIndexOf(' ');
      const l1 = head.slice(0, cut).trim();
      const l2 = head.slice(cut).trim();
      const size = Math.min(fitSerif(l1, 104, 21, 14), fitSerif(l2, 104, 21, 14));
      parts.push(`<text x="88" y="40" font-family="${SERIF}" font-size="${size}" font-weight="700" fill="${C.cream}">${esc(l1)}</text>`);
      parts.push(`<text x="88" y="61" font-family="${SERIF}" font-size="${size}" font-weight="700" fill="${C.cream}">${esc(l2)}</text>`);
      speechY = 82;
    }
    const waiting = waitingCount();
    const alert = leadAlertFresh();
    const showBadge = !alert && waiting && Math.floor(mascotFrame / 18) % 2 === 0; // alternate badge <-> speech
    if (alert) {
      // a fresh lead outranks everything — green pulse + the lead's name
      parts.push(`<circle cx="93" cy="${speechY - 4}" r="4" fill="${GREEN}"${mascotFrame % 2 ? ` opacity="0.35"` : ''}/>`);
      const shortName = alert.name.length > 12 ? `${alert.name.slice(0, 11)}…` : alert.name;
      parts.push(`<text x="101" y="${speechY}" font-family="${SANS}" font-size="11" font-weight="700" fill="${GREEN}">${esc(`NEW: ${shortName}`)}</text>`);
    } else if (st === 'panic') {
      parts.push(`<text x="89" y="${speechY}" font-family="${SANS}" font-size="11" font-weight="700" fill="${C.red}">limit close!</text>`);
    } else if (showBadge) {
      parts.push(`<circle cx="93" cy="${speechY - 4}" r="4" fill="${C.amber}"/>`);
      parts.push(`<text x="101" y="${speechY}" font-family="${SANS}" font-size="11" font-weight="700" fill="${C.amber}">${waiting} need${waiting > 1 ? '' : 's'} you</text>`);
    } else {
      parts.push(`<text x="89" y="${speechY}" font-family="${SANS}" font-size="11.5" fill="${C.muted}">${esc(speech())}</text>`);
    }
    x0 = 196;
  }
  const uuids = Object.keys(ACCOUNTS);
  const groupW = (w - x0) / uuids.length;
  uuids.forEach((uuid, i) => {
    const acct = ACCOUNTS[uuid];
    const entry = cache[uuid] || {};
    const d = entry.data;
    const gx = x0 + i * groupW;
    parts.push(`<text x="${gx + groupW / 2}" y="12" text-anchor="middle" font-family="${SANS}" font-size="10" font-weight="700" letter-spacing="1.5" fill="${C.coral}">${esc(acct.label.toUpperCase())}</text>`);
    if (d && d.current) {
      const cardW = (groupW - 8 - 6 - 10) / 2;
      const big = { pad: 10, pctSize: 30, pillSize: 10, barH: 10, subSize: 10 };
      parts.push(card(d.current, 'Current', gx + 8, 17, cardW, 80, big));
      parts.push(card(d.weekly, 'Weekly', gx + 8 + cardW + 6, 17, cardW, 80, big));
    } else {
      parts.push(errorInner(entry, gx + groupW / 2, 55));
    }
    if (i > 0) parts.push(`<rect x="${gx - 1}" y="14" width="1.5" height="76" fill="#2E2940"/>`);
  });
  return parts.join('');
}

function duoSlice(sliceIndex, totalSlices) {
  const inner = duoInner(200 * totalSlices);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="${200 * sliceIndex} 0 200 100">${inner}</svg>`;
}

// ---------- Claude sessions board (swipe to page 2) ----------

const SESSIONS_ACTION = 'com.fahim.claude-duo.sessions';
// Claude Code maintains a LIVE session registry per account config dir:
// ~/.claude/sessions/<pid>.json with the session's name (same one shown in
// the terminal), real status (busy/idle), cwd, pid, and the claude.ai
// bridgeSessionId for exact-chat deep links.
const SESSION_REGISTRIES = [
  { dir: path.join(os.homedir(), '.claude', 'sessions'), src: 'personal' },
  { dir: path.join(os.homedir(), '.claude2', 'sessions'), src: 'business' },
];
const ACCOUNT_COLORS = { personal: '#F97316', business: '#4ADE80' }; // orange = personal, green = mi assist

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// The conversation topic (same text the terminal tab shows) lives in
// "summary" entries that can sit ANYWHERE in the transcript — full-scan for
// the latest one, cached per session for 5 minutes.
const titleCache = {};
function sessionTopic(sessionId, file, size) {
  const hit = titleCache[sessionId];
  if (hit && Date.now() - hit.at < 300_000 && hit.size === size) return hit.title;
  let title = null;
  try {
    if (size < 30 * 1024 * 1024) {
      const text = fs.readFileSync(file, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.includes('"type":"summary"')) continue;
        try {
          const e = JSON.parse(line);
          if (e.type === 'summary' && typeof e.summary === 'string') title = e.summary;
        } catch {}
      }
    }
  } catch {}
  titleCache[sessionId] = { title, at: Date.now(), size };
  return title;
}
const sessions = { list: [], scannedAt: 0 };
let sessionSel = 0;

function readChunk(file, start, len) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    const read = fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    return buf.toString('utf8', 0, read);
  } catch { return ''; }
}

function parseLines(text) {
  const out = [];
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch {}
  }
  return out;
}

// last entry (for state/cwd) + chat title (from "summary" entries, like the
// name shown in claude --resume / the phone app)
function inspectSession(file, size) {
  const tail = parseLines(readChunk(file, Math.max(0, size - 16384), Math.min(size, 16384)));
  // the first human message can sit far into the file (big context blocks),
  // so read a generous head slice
  const head = size > 16384 ? parseLines(readChunk(file, 0, 262144)) : [];
  // bookkeeping entries (bridge-session, mode, last-prompt) aren't conversation
  const meaningful = [...tail].reverse().find((e) => e.type === 'assistant' || e.type === 'user');
  const last = meaningful || (tail.length ? tail[tail.length - 1] : null);
  const cwdEntry = [...tail].reverse().find((e) => e.cwd) || head.find((e) => e.cwd);
  const launchCwd = head.find((e) => e.cwd)?.cwd || null;
  let title = null;
  for (const e of [...head, ...tail]) {
    if (e.type === 'summary' && typeof e.summary === 'string') title = e.summary;
  }
  if (!title) {
    for (const e of [...head, ...tail]) {
      const t = humanText(e);
      if (t) { title = t; break; }
    }
  }
  return { last, title, launchCwd, cwd: cwdEntry?.cwd || '' };
}

// first real human message — skips system-reminders, command tags, sidechains
function humanText(entry) {
  if (!entry || entry.type !== 'user' || entry.isSidechain || entry.isMeta) return '';
  const content = entry.message?.content;
  let text = typeof content === 'string' ? content : Array.isArray(content) ? (content.find((c) => c.type === 'text')?.text || '') : '';
  if (!text) return '';
  text = text
    .replace(/<[a-z-]+>[\s\S]*?<\/[a-z-]+>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/^Caveat:.*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length >= 4 ? text : '';
}

function scanSessions() {
  const list = [];
  for (const { dir, src } of SESSION_REGISTRIES) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      let j;
      try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      if (j.kind !== 'interactive' || !j.pid || !pidAlive(j.pid)) continue;
      if (/observer|salvage|watchdog/i.test(j.name || '')) continue; // daemons
      const status = j.status || 'idle';
      const state = status === 'busy' ? 'working' : status === 'idle' ? 'waiting' : status;
      const ageMs = Math.max(0, Date.now() - (j.statusUpdatedAt || j.updatedAt || Date.now()));
      const home = os.homedir();
      // join registry -> transcript for the conversation topic (what the
      // terminal tab title shows), falling back to the registry name
      let title = null;
      if (j.sessionId && j.cwd) {
        const slug = j.cwd.replace(/[/.]/g, '-');
        const tf = path.join(home, '.claude', 'projects', slug, `${j.sessionId}.jsonl`);
        try {
          const st = fs.statSync(tf);
          title = sessionTopic(j.sessionId, tf, st.size) || inspectSession(tf, st.size).title;
        } catch {}
      }
      list.push({
        name: (title || j.name || 'session').slice(0, 34),
        folder: j.cwd && j.cwd !== home ? path.basename(j.cwd).slice(0, 14) : '',
        cwd: j.cwd || '',
        pid: j.pid,
        bridge: j.bridgeSessionId || null,
        state, ageMs, src,
      });
    }
  }
  const rank = { waiting: 0, working: 1 };
  sessions.list = list
    .sort((a, b) => (rank[a.state] ?? 2) - (rank[b.state] ?? 2) || a.ageMs - b.ageMs)
    .slice(0, 12);
  sessions.scannedAt = Date.now();
  sessionSel = Math.max(0, Math.min(sessionSel, sessions.list.length - 1));
}

function waitingCount() {
  return sessions.list.filter((s) => s.state === 'waiting').length;
}

function agoText(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

const SESSION_STYLE = {
  working: { dot: '#4ADE80', text: (s) => `working · ${agoText(s.ageMs)}` },
  waiting: { dot: C.amber, text: (s) => `needs you · ${agoText(s.ageMs)}` },
  idle: { dot: '#6B6580', text: (s) => `idle · ${agoText(s.ageMs)}` },
};

// Card grid: one block per touch-strip slot, dial scrolls pages, press opens
const CARD_TOP = 21;
const CARD_H = 76;
const CARD_MARGIN = 6;
function cardGeometry(w) {
  const n = Math.max(1, Math.round(w / 200));
  const cardW = (w - CARD_MARGIN * (n + 1)) / n;
  return { n, cardW };
}
function wrapTwo(text, perLine) {
  if (text.length <= perLine) return [text];
  let cut = text.lastIndexOf(' ', perLine);
  if (cut < perLine * 0.5) cut = perLine;
  const line1 = text.slice(0, cut).trim();
  let line2 = text.slice(cut).trim();
  if (line2.length > perLine) line2 = line2.slice(0, perLine - 1) + '…';
  return [line1, line2];
}
function sessionsInner(w) {
  const parts = [];
  parts.push(`<rect width="${w}" height="100" fill="${C.bg}"/>`);
  parts.push(invader(8, 2, 1.3, C.coral));
  parts.push(`<text x="28" y="15" font-family="${SERIF}" font-size="14" font-weight="700" fill="${C.cream}">Live Sessions</text>`);
  const working = sessions.list.filter((s) => s.state === 'working').length;
  const waiting = waitingCount();
  const summary = waiting ? `${waiting} need you · ${working} working` : `${working} working`;
  parts.push(`<text x="${w - 10}" y="14" text-anchor="end" font-family="${SANS}" font-size="11" font-weight="600" fill="${waiting ? C.amber : C.muted}">${esc(summary)}</text>`);

  if (!sessions.list.length) {
    parts.push(mascotSvg(w / 2 - 70, 38, 3.4, 'sleep', mascotFrame));
    parts.push(`<text x="${w / 2 + 14}" y="68" font-family="${SANS}" font-size="14" fill="${C.muted}">All quiet — no live sessions</text>`);
    return parts.join('');
  }

  const { n, cardW } = cardGeometry(w);
  const pageStart = Math.floor(sessionSel / n) * n;
  const visible = sessions.list.slice(pageStart, pageStart + n);
  const perLine = Math.max(10, Math.floor((cardW - 22) / 7.4));

  visible.forEach((s, i) => {
    const x = CARD_MARGIN + i * (cardW + CARD_MARGIN);
    const style = SESSION_STYLE[s.state];
    const acctColor = ACCOUNT_COLORS[s.src] || C.muted;
    const selected = pageStart + i === sessionSel;
    parts.push(`<rect x="${x}" y="${CARD_TOP}" width="${cardW}" height="${CARD_H}" rx="10" fill="${selected ? '#343048' : C.card}"${selected ? ` stroke="${acctColor}" stroke-width="2.5"` : ''}/>`);
    parts.push(`<rect x="${x}" y="${CARD_TOP}" width="6" height="${CARD_H}" rx="3" fill="${acctColor}"/>`);
    const lines = wrapTwo(s.name, perLine);
    parts.push(`<text x="${x + 15}" y="${CARD_TOP + 24}" font-family="${SANS}" font-size="14" font-weight="700" fill="${selected ? '#FFFFFF' : C.cream}">${esc(lines[0])}</text>`);
    if (lines[1]) parts.push(`<text x="${x + 15}" y="${CARD_TOP + 41}" font-family="${SANS}" font-size="14" font-weight="700" fill="${selected ? '#FFFFFF' : C.cream}">${esc(lines[1])}</text>`);
    parts.push(`<circle cx="${x + 20}" cy="${CARD_TOP + 61}" r="5" fill="${style.dot}"/>`);
    parts.push(`<text x="${x + 30}" y="${CARD_TOP + 65}" font-family="${SANS}" font-size="11.5" font-weight="600" fill="${style.dot}">${esc(style.text(s))}</text>`);
  });

  if (sessions.list.length > n) {
    const pages = Math.ceil(sessions.list.length / n);
    const page = Math.floor(pageStart / n);
    parts.push(`<text x="${w / 2}" y="15" text-anchor="middle" font-family="${SANS}" font-size="10" fill="${C.muted}">page ${page + 1}/${pages} · twist to scroll</text>`);
  }
  return parts.join('');
}

function sessionsSlice(sliceIndex, totalSlices) {
  const inner = sessionsInner(200 * totalSlices);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="${200 * sliceIndex} 0 200 100">${inner}</svg>`;
}

function sessionsKeySvg() {
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">`);
  parts.push(`<rect width="144" height="144" rx="14" fill="${C.bg}"/>`);
  parts.push(invader(8, 6, 1.6, C.coral));
  parts.push(`<text x="78" y="19" text-anchor="middle" font-family="${SERIF}" font-size="16" font-weight="700" fill="${C.cream}">Sessions</text>`);
  const waiting = waitingCount();
  const working = sessions.list.filter((s) => s.state === 'working').length;
  parts.push(`<text x="72" y="78" text-anchor="middle" font-family="${SANS}" font-size="40" font-weight="800" fill="${waiting ? C.amber : C.cream}">${waiting || working}</text>`);
  parts.push(`<text x="72" y="102" text-anchor="middle" font-family="${SANS}" font-size="11" fill="${C.muted}">${waiting ? 'need you' : 'working'}</text>`);
  parts.push(`</svg>`);
  return parts.join('');
}

// ═══════════════════ CRM page (crm.miassist.studio board) ═══════════════════
// Four category buttons on the top keys (matching the board's own bars), the
// category's people on the strip + bottom keys, tap a person for a detail view.
// Credentials come from the CRM repo's own .env.local at runtime — nothing
// lands in this repo.
const CRM_ACTION = 'com.fahim.claude-duo.crm';
const CRMLEAD_ACTION = 'com.fahim.claude-duo.crmlead';
const CRM_POLL_MS = 60_000;

function crmConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'accounts.json'), 'utf8')).crm || {}; } catch {}
  return {
    envPath: cfg.envPath || path.join(os.homedir(), 'code', 'miassist-crmboard', '.env.local'),
    baseUrl: (cfg.baseUrl || 'https://crm.miassist.studio').replace(/\/$/, ''),
    chromeProfile: cfg.chromeProfile || null,
  };
}

let crmCredsCache = null;
function crmCreds() {
  if (crmCredsCache) return crmCredsCache;
  try {
    const text = fs.readFileSync(crmConfig().envPath, 'utf8');
    const env = {};
    for (const line of text.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)="?([^"\n]*?)"?\s*$/);
      if (m) env[m[1]] = m[2];
    }
    const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
    const key = env.SUPABASE_SECRET_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (url && key) crmCredsCache = { url: url.replace(/\/$/, ''), key };
  } catch (e) { log('crm creds unavailable:', e.message); }
  return crmCredsCache;
}

const STAGE_LABELS = {
  new: 'new', to_contact: 'to contact', contacted: 'contacted', tried: 'tried', talked: 'talked',
  follow_up: 'follow-up', booked: 'booked', proposal: 'proposal', won: 'won', lost: 'lost',
};
function stageLabel(stage) { return STAGE_LABELS[stage] || String(stage || '').replace(/_/g, ' '); }
const GREEN = '#4ADE80';

// The four category buttons — same concepts as the board's own bars
const CRM_CATS = [
  { key: 'saved', label: 'Saved', words: ['Saved'], color: '#A78BFA' },
  { key: 'worked', label: 'Worked', words: ['Recently', 'Worked'], color: '#60A5FA' },
  { key: 'followup', label: 'Follow Up', words: ['Follow Up', 'Today'], color: '#FBBF24' },
  { key: 'newtoday', label: 'New Today', words: ['New', 'Today'], color: GREEN },
];
function crmCatMeta(key) { return CRM_CATS.find((c) => c.key === key) || CRM_CATS[3]; }

const crm = { cats: { saved: [], worked: [], followup: [], newtoday: [] }, error: null, fetchedAt: 0 };
let crmCat = 'newtoday';
let crmMode = 'list'; // 'list' | 'detail'
let crmSel = 0;
let crmNewDays = 1; // hold the New Today key to widen: 1 -> 3 -> 7 days
let crmAllLeads = false; // press New Today AGAIN -> every lead, newest first
function newTodayLabel() {
  if (crmAllLeads) return 'All Leads';
  return crmNewDays === 1 ? 'New Today' : `New · ${crmNewDays} Days`;
}
function newTodayWords() {
  if (crmAllLeads) return ['All', 'Leads'];
  return crmNewDays === 1 ? ['New', 'Today'] : ['New', `${crmNewDays} Days`];
}
let leadAlert = null; // { name, at } — a brand-new lead just landed

function crmActiveList() {
  if (crmCat === 'newtoday' && crmAllLeads) return crm.cats.all || [];
  return crm.cats[crmCat] || [];
}

// remember the newest lead we've seen so a restart never re-announces old leads
const CRM_STATE_FILE = path.join(__dirname, '..', 'logs', 'crm-state.json');
let crmLastSeen = 0;
try { crmLastSeen = JSON.parse(fs.readFileSync(CRM_STATE_FILE, 'utf8')).lastSeen || 0; } catch {}

function fmtPhone(p) {
  const d = String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (p || '');
}

function leadName(l) {
  const person = [l.first_name, l.last_name].filter(Boolean).join(' ').trim();
  return l.business_name || person || (l.email || '').split('@')[0] || fmtPhone(l.phone) || 'Quiz lead';
}

function leadAgo(ms) {
  const mins = Math.round(Math.abs(ms) / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / 1440)}d`;
}

const SRC_WORDS = {
  facebook_ads: 'fb ad', instagram_ads: 'ig ad', google_ads: 'google ad',
  social_facebook: 'fb', social_instagram: 'ig', email: 'email', sms: 'sms',
  qr: 'qr code', bio: 'bio link', direct: 'direct',
};
function srcWord(src) { return SRC_WORDS[src] || (src ? String(src).replace(/_/g, ' ').slice(0, 12) : null); }

function mapLead(l, now) {
  const createdMs = Date.parse(l.created_at) || 0;
  const followMs = l.follow_up_at ? Date.parse(l.follow_up_at) : 0;
  return {
    id: l.id, name: leadName(l), stage: l.stage, temperature: l.temperature,
    createdMs, ageMs: now - createdMs, followMs,
    savedMs: l.saved_at ? Date.parse(l.saved_at) : 0,
    workedMs: l.last_worked_at ? Date.parse(l.last_worked_at) : 0,
    due: followMs > 0 && followMs <= now,
    phone: l.phone || null, email: l.email || null, src: l.utm_source || null,
    qname: l.business_name || [l.first_name, l.last_name].filter(Boolean).join(' ').trim() || l.email || l.phone || '',
  };
}

async function crmQuery(creds, extra, limit = 12) {
  const base = 'select=id,first_name,last_name,business_name,email,phone,stage,temperature,created_at,follow_up_at,saved_at,last_worked_at,utm_source'
    + `&disqualified=not.is.true&stage=not.in.(won,lost)&limit=${limit}`;
  const res = await fetch(`${creds.url}/rest/v1/leads?${base}&${extra}`, {
    headers: { apikey: creds.key, Authorization: `Bearer ${creds.key}` },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

let crmFirstFetch = true;
async function fetchLeads() {
  const creds = crmCreds();
  if (!creds) { crm.error = 'no CRM creds'; return; }
  const now = Date.now();
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const endOfDay = new Date(); endOfDay.setHours(23, 59, 59, 999);
  try {
    const [saved, worked, followup, newtoday, all] = await Promise.all([
      crmQuery(creds, 'saved_at=not.is.null&order=saved_at.desc'),
      crmQuery(creds, 'last_worked_at=not.is.null&order=last_worked_at.desc'),
      crmQuery(creds, `follow_up_at=lte.${encodeURIComponent(endOfDay.toISOString())}&order=follow_up_at.asc`),
      crmQuery(creds, `created_at=gte.${encodeURIComponent((crmNewDays === 1 ? midnight : new Date(now - crmNewDays * 86400_000)).toISOString())}&order=created_at.desc`),
      crmQuery(creds, 'order=created_at.desc', 60),
    ]);
    crm.cats = {
      saved: saved.map((l) => mapLead(l, now)),
      worked: worked.map((l) => mapLead(l, now)),
      followup: followup.map((l) => mapLead(l, now)),
      newtoday: newtoday.map((l) => mapLead(l, now)),
      all: all.map((l) => mapLead(l, now)),
    };
    crm.error = null;
    crm.fetchedAt = now;
    if (crmFirstFetch) {
      log(`crm ok: saved=${crm.cats.saved.length} worked=${crm.cats.worked.length} followup=${crm.cats.followup.length} newtoday=${crm.cats.newtoday.length}`);
      // wake up on what matters: overdue follow-ups first, else today's leads
      crmCat = crm.cats.followup.length ? 'followup' : 'newtoday';
      crmFirstFetch = false;
    }
    const newest = crm.cats.newtoday.length ? crm.cats.newtoday[0].createdMs : 0;
    if (crmLastSeen && newest > crmLastSeen) {
      leadAlert = { name: crm.cats.newtoday[0].name, at: now };
      crmCat = 'newtoday'; crmAllLeads = false; crmSel = 0; crmMode = 'list'; // the deck jumps to them
      log('NEW LEAD:', leadAlert.name);
    }
    if (newest > crmLastSeen) {
      crmLastSeen = newest;
      try { fs.writeFileSync(CRM_STATE_FILE, JSON.stringify({ lastSeen: crmLastSeen })); } catch {}
    }
  } catch (e) {
    crm.error = e.message;
    log('fetchLeads failed:', e.message);
  }
}

function leadAlertFresh() {
  return leadAlert && Date.now() - leadAlert.at < 120_000 ? leadAlert : null;
}

// One plain-English line saying WHY this person is in the active category
function catText(l) {
  if (crmCat === 'saved') return l.savedMs ? `saved ${leadAgo(Date.now() - l.savedMs)} ago` : 'saved';
  if (crmCat === 'worked') return l.workedMs ? `worked ${leadAgo(Date.now() - l.workedMs)} ago` : 'worked';
  if (crmCat === 'followup') {
    if (!l.followMs) return 'follow up';
    const over = Date.now() - l.followMs;
    return over > 3600_000 ? `was due ${leadAgo(over)} ago` : 'due today';
  }
  if (crmAllLeads) return `${leadAgo(l.ageMs)} ago · ${stageLabel(l.stage)}`;
  const src = srcWord(l.src);
  return `${leadAgo(l.ageMs)} ago${src ? ` · ${src}` : ''}`;
}

function crmInner(w) {
  const cat = crmCatMeta(crmCat);
  const list = crmActiveList();
  const parts = [];
  parts.push(`<rect width="${w}" height="100" fill="${C.bg}"/>`);
  parts.push(invader(8, 2, 1.3, C.coral));
  parts.push(`<text x="28" y="15" font-family="${SERIF}" font-size="14" font-weight="700" fill="${C.cream}">CRM ·</text>`);
  parts.push(`<text x="76" y="15" font-family="${SERIF}" font-size="14" font-weight="700" fill="${cat.color}">${esc(cat.key === 'newtoday' ? newTodayLabel() : cat.label)}</text>`);
  const alert = leadAlertFresh();
  const headRight = crm.error ? 'CRM offline'
    : alert ? `NEW: ${alert.name}`
    : crmMode === 'detail' ? `${crmSel + 1} of ${list.length} · tap: open · knob: back`
    : `${list.length} ${list.length === 1 ? 'person' : 'people'} · tap one for details`;
  parts.push(`<text x="${w - 10}" y="14" text-anchor="end" font-family="${SANS}" font-size="11" font-weight="600" fill="${crm.error ? C.red : alert ? GREEN : C.muted}">${esc(headRight)}</text>`);

  if (!list.length) {
    const msg = crm.error ? `board unreachable — ${crm.error}` : `nothing in ${cat.label} right now`;
    parts.push(`<text x="${w / 2}" y="62" text-anchor="middle" font-family="${SANS}" font-size="13" fill="${C.muted}">${esc(msg)}</text>`);
    return parts.join('');
  }
  if (crmSel >= list.length) crmSel = list.length - 1;

  if (crmMode === 'detail') {
    const l = list[crmSel];
    parts.push(`<rect x="${CARD_MARGIN}" y="${CARD_TOP}" width="${w - CARD_MARGIN * 2}" height="${CARD_H}" rx="10" fill="#2B2740" stroke="${cat.color}" stroke-width="2"/>`);
    parts.push(`<rect x="${CARD_MARGIN}" y="${CARD_TOP}" width="8" height="${CARD_H}" rx="4" fill="${cat.color}"/>`);
    parts.push(`<text x="26" y="${CARD_TOP + 30}" font-family="${SANS}" font-size="20" font-weight="800" fill="#FFFFFF">${esc(l.name)}</text>`);
    const bits = [catText(l)];
    if (l.stage) bits.push(`stage: ${stageLabel(l.stage)}`);
    if (l.temperature) bits.push(l.temperature);
    parts.push(`<text x="26" y="${CARD_TOP + 52}" font-family="${SANS}" font-size="13" font-weight="600" fill="${cat.color}">${esc(bits.join('  ·  '))}</text>`);
    const phone = fmtPhone(l.phone);
    const contact = [phone, l.email].filter(Boolean).join('   ·   ') || 'no contact info on file';
    parts.push(`<text x="26" y="${CARD_TOP + 70}" font-family="${SANS}" font-size="13" fill="${C.cream}">${esc(contact)}</text>`);
    parts.push(`<text x="${w - 16}" y="${CARD_TOP + 68}" text-anchor="end" font-family="${SANS}" font-size="10" fill="${C.muted}">tap: open on board · twist: next</text>`);
    return parts.join('');
  }

  const { n, cardW } = cardGeometry(w);
  const pageStart = Math.floor(crmSel / n) * n;
  const visible = list.slice(pageStart, pageStart + n);
  const perLine = Math.max(8, Math.floor((cardW - 22) / 7.4));

  visible.forEach((l, i) => {
    const x = CARD_MARGIN + i * (cardW + CARD_MARGIN);
    const selected = pageStart + i === crmSel;
    parts.push(`<rect x="${x}" y="${CARD_TOP}" width="${cardW}" height="${CARD_H}" rx="10" fill="${selected ? '#343048' : C.card}"${selected ? ` stroke="${cat.color}" stroke-width="2.5"` : ''}/>`);
    parts.push(`<rect x="${x}" y="${CARD_TOP}" width="6" height="${CARD_H}" rx="3" fill="${cat.color}"/>`);
    const lines = wrapTwo(l.name, perLine);
    parts.push(`<text x="${x + 15}" y="${CARD_TOP + 24}" font-family="${SANS}" font-size="14" font-weight="700" fill="${selected ? '#FFFFFF' : C.cream}">${esc(lines[0])}</text>`);
    if (lines[1]) parts.push(`<text x="${x + 15}" y="${CARD_TOP + 41}" font-family="${SANS}" font-size="14" font-weight="700" fill="${selected ? '#FFFFFF' : C.cream}">${esc(lines[1])}</text>`);
    parts.push(`<circle cx="${x + 20}" cy="${CARD_TOP + 61}" r="5" fill="${cat.color}"/>`);
    parts.push(`<text x="${x + 30}" y="${CARD_TOP + 65}" font-family="${SANS}" font-size="11.5" font-weight="600" fill="${cat.color}">${esc(catText(l))}</text>`);
  });

  if (list.length > n) {
    const pages = Math.ceil(list.length / n);
    parts.push(`<text x="${w / 2}" y="15" text-anchor="middle" font-family="${SANS}" font-size="10" fill="${C.muted}">page ${Math.floor(pageStart / n) + 1}/${pages} · twist to scroll</text>`);
  }
  return parts.join('');
}

function crmSlice(sliceIndex, totalSlices) {
  const inner = crmInner(200 * totalSlices);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="${200 * sliceIndex} 0 200 100">${inner}</svg>`;
}

// Summary key (when the crm action sits on a plain key on another page)
function crmKeySvg() {
  const alert = leadAlertFresh();
  const newToday = crm.cats.newtoday.length;
  const dueCount = crm.cats.followup.length;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">`);
  parts.push(`<rect width="144" height="144" rx="14" fill="${C.bg}"/>`);
  parts.push(invader(8, 6, 1.6, C.coral));
  parts.push(`<text x="78" y="19" text-anchor="middle" font-family="${SERIF}" font-size="16" font-weight="700" fill="${C.cream}">CRM</text>`);
  const big = alert ? newToday : (dueCount || newToday);
  parts.push(`<text x="72" y="78" text-anchor="middle" font-family="${SANS}" font-size="40" font-weight="800" fill="${alert ? GREEN : dueCount ? C.amber : C.cream}">${big}</text>`);
  parts.push(`<text x="72" y="102" text-anchor="middle" font-family="${SANS}" font-size="11" fill="${C.muted}">${alert ? 'new lead!' : dueCount ? 'follow-ups' : 'today'}</text>`);
  parts.push(`</svg>`);
  return parts.join('');
}

// Top-row keys: the four category buttons (live counts, active = lit up)
function crmCatKeySvg(col) {
  const cat = CRM_CATS[col];
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">`);
  if (!cat) { parts.push(`<rect width="144" height="144" rx="14" fill="${C.bg}"/></svg>`); return parts.join(''); }
  const active = crmCat === cat.key;
  const count = (cat.key === 'newtoday' && crmAllLeads ? crm.cats.all || [] : crm.cats[cat.key] || []).length;
  parts.push(`<rect width="144" height="144" rx="14" fill="${C.bg}"/>`);
  if (active) parts.push(`<rect x="3" y="3" width="138" height="138" rx="12" fill="${cat.color}" opacity="0.16"/>`);
  parts.push(`<rect x="3" y="3" width="138" height="138" rx="12" fill="none" stroke="${active ? '#FFFFFF' : cat.color}" stroke-width="${active ? 3 : 2}"${active ? '' : ' opacity="0.55"'}/>`);
  const words = cat.key === 'newtoday' ? newTodayWords() : cat.words;
  const y0 = words.length > 1 ? 40 : 50;
  words.forEach((word, i) => {
    parts.push(`<text x="72" y="${y0 + i * 22}" text-anchor="middle" font-family="${SANS}" font-size="18" font-weight="800" fill="${active ? '#FFFFFF' : C.cream}">${esc(word)}</text>`);
  });
  parts.push(`<text x="72" y="118" text-anchor="middle" font-family="${SANS}" font-size="38" font-weight="800" fill="${cat.color}">${count}</text>`);
  if (cat.key === 'newtoday') {
    const hint = crmAllLeads ? 'press: back to today' : 'again: all · hold: days';
    parts.push(`<text x="72" y="135" text-anchor="middle" font-family="${SANS}" font-size="9" fill="${C.muted}">${esc(hint)}</text>`);
  }
  parts.push(`</svg>`);
  return parts.join('');
}

// Bottom-row keys: the first four people of the active category
function crmPersonKeySvg(col) {
  const cat = crmCatMeta(crmCat);
  const l = crmActiveList()[col];
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">`);
  parts.push(`<rect width="144" height="144" rx="14" fill="${C.bg}"/>`);
  if (!l) {
    parts.push(`<text x="72" y="82" text-anchor="middle" font-family="${SANS}" font-size="22" fill="#2A2638">·</text>`);
    parts.push('</svg>');
    return parts.join('');
  }
  const selected = crmSel === col && crmMode === 'detail';
  if (selected) parts.push(`<rect x="3" y="3" width="138" height="138" rx="12" fill="none" stroke="#FFFFFF" stroke-width="3"/>`);
  parts.push(`<rect x="0" y="0" width="8" height="144" fill="${cat.color}"/>`);
  // break on whole words only — "Maria" / "Gonzalez", never "Gonza" / "lez"
  const nameWords = l.name.split(' ');
  const clip = (s) => (s.length > 12 ? `${s.slice(0, 11)}…` : s);
  const lines = nameWords.length > 1
    ? [clip(nameWords[0]), clip(nameWords.slice(1).join(' '))]
    : [clip(l.name)];
  parts.push(`<text x="20" y="${lines[1] ? 48 : 60}" font-family="${SANS}" font-size="17" font-weight="700" fill="${C.cream}">${esc(lines[0])}</text>`);
  if (lines[1]) parts.push(`<text x="20" y="70" font-family="${SANS}" font-size="17" font-weight="700" fill="${C.cream}">${esc(lines[1])}</text>`);
  parts.push(`<text x="20" y="112" font-family="${SANS}" font-size="12" font-weight="600" fill="${cat.color}">${esc(catText(l))}</text>`);
  parts.push(`<text x="20" y="132" font-family="${SANS}" font-size="11" fill="${C.muted}">press: details</text>`);
  parts.push('</svg>');
  return parts.join('');
}

function openCrm(pathname) {
  const { baseUrl, chromeProfile } = crmConfig();
  const url = `${baseUrl}${pathname}`;
  log(`open crm: ${url} chromeProfile=${chromeProfile || 'default browser'}`);
  if (chromeProfile) {
    execFile('/usr/bin/open', ['-na', 'Google Chrome', '--args', `--profile-directory=${chromeProfile}`, url], (e) => { if (e) log('chrome open failed:', e.message); });
  } else {
    execFile('/usr/bin/open', [url], (e) => { if (e) log('open url failed:', e.message); });
  }
}

function openLead(l) {
  if (!l || !l.qname) return openCrm('/admin/analytics/leads');
  openCrm(`/admin/analytics/contacts?q=${encodeURIComponent(l.qname)}`);
}

function launchCrmBrief() {
  const dir = path.join(os.homedir(), '.warp', 'launch_configurations');
  const prompt = 'Full CRM briefing from my miassist board: go through EVERY open lead one by one - where they are at (stage), their follow-up status, and the LAST note on each (read lead_notes). Then a short list of who to touch today and why. Use the crm skill.';
  try {
    fs.mkdirSync(dir, { recursive: true });
    const yaml = `---\nname: claude-crm\nwindows:\n  - tabs:\n      - title: claude · crm brief\n        layout:\n          cwd: ${os.homedir()}\n          commands:\n            - exec: claude "${prompt}"\n`;
    fs.writeFileSync(path.join(dir, 'claude-crm.yaml'), yaml);
    log('launch crm brief');
    execFile('/usr/bin/open', ['warp://launch/claude-crm.yaml'], (e) => { if (e) log('warp launch failed:', e.message); });
  } catch (e) { log('launchCrmBrief error:', e.message); }
}

// ═══════════════════ Ads page (Meta Ads Manager, read-only) ═══════════════════
// Today's spend / leads / cost-per-lead per ad account, polled gently (the
// Graph API rate-limits hard). Press an account -> that EXACT account opens
// in Ads Manager. This page never writes to any ad account.
const ADS_ACTION = 'com.fahim.claude-duo.ads';
const ADSKEY_ACTION = 'com.fahim.claude-duo.adskey';
const ADS_POLL_MS = 15 * 60_000;

function adsConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'accounts.json'), 'utf8')).ads || {}; } catch {}
  return {
    tokenPath: String(cfg.tokenPath || '').replace(/^~/, os.homedir()),
    accounts: (Array.isArray(cfg.accounts) ? cfg.accounts : []).filter((a) => a && a.act),
  };
}

const ADS_PRESETS = { today: 'Today', yesterday: 'Yesterday', last_7d: 'Last 7 Days', last_30d: 'Last 30 Days', maximum: 'All Time' };
const ADS_WIN_KEYS = [ // bottom-row window buttons; key 0 shows the LIVE window
  { toggle: true },
  { preset: 'last_7d', words: ['Last', '7 Days'] },
  { preset: 'last_30d', words: ['Last', '30 Days'] },
  { preset: 'maximum', words: ['All', 'Time'] },
];
const ADS_PRESET_WORDS = { today: ['Today'], yesterday: ['Yesterday'], last_7d: ['Last', '7 Days'], last_30d: ['Last', '30 Days'], maximum: ['All', 'Time'] };
const ADS_PRESET_ORDER = ['today', 'yesterday', 'last_7d', 'last_30d', 'maximum'];
let adsPreset = 'today';
let adsDialTimer = null;
const ads = { rows: [], preset: 'today', error: null, fetchedAt: 0 };
const ADS_CACHE_FILE = path.join(__dirname, '..', 'logs', 'ads-cache.json');
try {
  const saved = JSON.parse(fs.readFileSync(ADS_CACHE_FILE, 'utf8'));
  if (Array.isArray(saved.rows)) { ads.rows = saved.rows; ads.fetchedAt = saved.fetchedAt || 0; }
} catch {}

function adsToken() {
  const { tokenPath } = adsConfig();
  if (!tokenPath) return null;
  try { return fs.readFileSync(tokenPath, 'utf8').trim(); } catch { return null; }
}

async function fetchAds() {
  const { accounts } = adsConfig();
  const token = adsToken();
  if (!accounts.length || !token) { ads.error = accounts.length ? 'no ads token' : 'no ads accounts set up'; return; }
  try {
    const preset = adsPreset;
    // staggered-parallel: quick enough to feel instant, gentle enough for Meta
    const rows = await Promise.all(accounts.map((a, i) => (async () => {
      await new Promise((r) => setTimeout(r, i * 250));
      const res = await fetch(`https://graph.facebook.com/v21.0/act_${a.act}/insights?date_preset=${preset}&fields=spend,actions&access_token=${token}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const d = (json.data && json.data[0]) || {};
      const spend = parseFloat(d.spend || '0') || 0;
      let leads = 0;
      for (const act of d.actions || []) {
        if (act.action_type === 'lead') { leads = parseInt(act.value, 10) || 0; break; }
        if (act.action_type === 'offsite_conversion.fb_pixel_lead') leads = parseInt(act.value, 10) || leads;
      }
      return { label: a.label || `act ${a.act}`, act: a.act, spend, leads, cpl: leads ? spend / leads : null };
    })()));
    if (preset !== adsPreset) return; // user already switched again — discard
    const firstAdsFetch = !ads.fetchedAt;
    ads.rows = rows;
    ads.preset = preset;
    ads.error = null;
    ads.fetchedAt = Date.now();
    if (firstAdsFetch) log(`ads ok: ${rows.map((r) => `${r.label}=$${r.spend.toFixed(2)}/${r.leads}L`).join(' ')}`);
    try { fs.writeFileSync(ADS_CACHE_FILE, JSON.stringify({ rows, fetchedAt: ads.fetchedAt })); } catch {}
  } catch (e) {
    ads.error = e.message;
    log('fetchAds failed:', e.message);
  }
}

function money(n) { return n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`; }

function openAdsAccount(act) {
  const url = act
    ? `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${act}`
    : 'https://adsmanager.facebook.com/adsmanager/';
  log(`open ads: ${url}`);
  execFile('/usr/bin/open', [url], (e) => { if (e) log('open ads failed:', e.message); });
}

function launchAdsBrief() {
  const dir = path.join(os.homedir(), '.warp', 'launch_configurations');
  const prompt = 'Read-only status of my Meta ads today and last 3 days: spend, leads, and cost per lead for each account, plus anything that needs attention. Do not change anything on any account.';
  try {
    fs.mkdirSync(dir, { recursive: true });
    const yaml = `---\nname: claude-ads\nwindows:\n  - tabs:\n      - title: claude · ads status\n        layout:\n          cwd: ${os.homedir()}\n          commands:\n            - exec: claude "${prompt}"\n`;
    fs.writeFileSync(path.join(dir, 'claude-ads.yaml'), yaml);
    log('launch ads brief');
    execFile('/usr/bin/open', ['warp://launch/claude-ads.yaml'], (e) => { if (e) log('warp launch failed:', e.message); });
  } catch (e) { log('launchAdsBrief error:', e.message); }
}

function launchSlackSweep() {
  const dir = path.join(os.homedir(), '.warp', 'launch_configurations');
  let focus = [];
  try { focus = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'accounts.json'), 'utf8')).slackFocus || []; } catch {}
  const where = focus.length ? `Focus on these channels first: ${focus.join(', ')}.` : 'Focus on client channels and DMs.';
  const prompt = `Sweep my Slack for what needs me, channel by channel. ${where} Skip automation and ops noise. For each: what is going on and what I owe a reply to.`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const yaml = `---\nname: claude-slack\nwindows:\n  - tabs:\n      - title: claude · slack sweep\n        layout:\n          cwd: ${os.homedir()}\n          commands:\n            - exec: claude "${prompt}"\n`;
    fs.writeFileSync(path.join(dir, 'claude-slack.yaml'), yaml);
    log('launch slack sweep');
    execFile('/usr/bin/open', ['warp://launch/claude-slack.yaml'], (e) => { if (e) log('warp launch failed:', e.message); });
  } catch (e) { log('launchSlackSweep error:', e.message); }
}

function adsRowLine(r) {
  if (r.leads) return { text: `${r.leads} lead${r.leads > 1 ? 's' : ''} · ${money(r.cpl)} each`, color: GREEN };
  if (r.spend > 0) return { text: 'spending · no leads yet', color: C.amber };
  return { text: 'quiet today', color: C.muted };
}

function adsInner(w) {
  const parts = [];
  parts.push(`<rect width="${w}" height="100" fill="${C.bg}"/>`);
  parts.push(invader(8, 2, 1.3, C.coral));
  // the title tracks what you ASKED for the moment you press; numbers dim until they land
  const stale = adsPreset !== ads.preset;
  parts.push(`<text x="28" y="15" font-family="${SERIF}" font-size="14" font-weight="700" fill="${stale ? C.amber : C.cream}">Ads · ${esc(ADS_PRESETS[adsPreset] || 'Today')}</text>`);
  const total = ads.rows.reduce((a, r) => a + r.spend, 0);
  const headRight = ads.error ? `ads offline — ${ads.error}`
    : stale ? 'updating…'
    : ads.rows.length ? `${money(total)} total · tap: open account · hold: brief`
    : 'add accounts in accounts.json';
  parts.push(`<text x="${w - 10}" y="14" text-anchor="end" font-family="${SANS}" font-size="11" font-weight="600" fill="${ads.error ? C.red : C.muted}">${esc(headRight)}</text>`);
  if (!ads.rows.length) {
    parts.push(`<text x="${w / 2}" y="62" text-anchor="middle" font-family="${SANS}" font-size="13" fill="${C.muted}">no ad accounts configured</text>`);
    return parts.join('');
  }
  const { n, cardW } = cardGeometry(w);
  if (stale) parts.push('<g opacity="0.45">');
  ads.rows.slice(0, n).forEach((r, i) => {
    const x = CARD_MARGIN + i * (cardW + CARD_MARGIN);
    const line = adsRowLine(r);
    parts.push(`<rect x="${x}" y="${CARD_TOP}" width="${cardW}" height="${CARD_H}" rx="10" fill="${C.card}"/>`);
    parts.push(`<rect x="${x}" y="${CARD_TOP}" width="6" height="${CARD_H}" rx="3" fill="${line.color === C.muted ? C.track : line.color}"/>`);
    parts.push(`<text x="${x + 15}" y="${CARD_TOP + 22}" font-family="${SANS}" font-size="13" font-weight="700" fill="${C.cream}">${esc(r.label)}</text>`);
    parts.push(`<text x="${x + 15}" y="${CARD_TOP + 48}" font-family="${SANS}" font-size="22" font-weight="800" fill="${C.cream}">${esc(money(r.spend))}</text>`);
    parts.push(`<circle cx="${x + 20}" cy="${CARD_TOP + 63}" r="5" fill="${line.color}"/>`);
    parts.push(`<text x="${x + 30}" y="${CARD_TOP + 67}" font-family="${SANS}" font-size="11.5" font-weight="600" fill="${line.color}">${esc(line.text)}</text>`);
  });
  if (stale) parts.push('</g>');
  return parts.join('');
}

function adsSlice(sliceIndex, totalSlices) {
  const inner = adsInner(200 * totalSlices);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="${200 * sliceIndex} 0 200 100">${inner}</svg>`;
}

function adsKeySvg(col) {
  const r = ads.rows[col];
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">`);
  parts.push(`<rect width="144" height="144" rx="14" fill="${C.bg}"/>`);
  if (!r) {
    parts.push(`<text x="72" y="82" text-anchor="middle" font-family="${SANS}" font-size="22" fill="#2A2638">·</text>`);
    parts.push('</svg>');
    return parts.join('');
  }
  const line = adsRowLine(r);
  parts.push(`<rect x="0" y="0" width="8" height="144" fill="${line.color === C.muted ? C.track : line.color}"/>`);
  parts.push(`<text x="20" y="38" font-family="${SANS}" font-size="${r.label.length > 12 ? 13 : 16}" font-weight="700" fill="${C.cream}">${esc(r.label)}</text>`);
  parts.push(`<text x="20" y="78" font-family="${SANS}" font-size="26" font-weight="800" fill="${C.cream}">${esc(money(r.spend))}</text>`);
  parts.push(`<text x="20" y="106" font-family="${SANS}" font-size="12" font-weight="600" fill="${line.color}">${esc(r.leads ? `${r.leads} leads · ${money(r.cpl)}` : line.text)}</text>`);
  parts.push(`<text x="20" y="132" font-family="${SANS}" font-size="11" fill="${C.muted}">press: open account</text>`);
  parts.push('</svg>');
  return parts.join('');
}

// Bottom-row keys on the ads page: time-window buttons + the brief key
function adsWinKeySvg(col) {
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">`);
  parts.push(`<rect width="144" height="144" rx="14" fill="${C.bg}"/>`);
  const win = ADS_WIN_KEYS[col];
  if (!win) { parts.push('</svg>'); return parts.join(''); }
  if (win.toggle) {
    // the status key: its big label IS the window being shown right now
    parts.push(`<rect x="3" y="3" width="138" height="138" rx="12" fill="${C.coral}"/>`);
    const words = ADS_PRESET_WORDS[adsPreset] || ['Today'];
    const y0 = words.length > 1 ? 46 : 58;
    words.forEach((word, i) => {
      parts.push(`<text x="72" y="${y0 + i * 24}" text-anchor="middle" font-family="${SANS}" font-size="21" font-weight="800" fill="#17151E">${esc(word)}</text>`);
    });
    parts.push(`<text x="72" y="102" text-anchor="middle" font-family="${SANS}" font-size="12" font-weight="700" fill="#17151E">SHOWING NOW</text>`);
    parts.push(`<text x="72" y="126" text-anchor="middle" font-family="${SANS}" font-size="10" fill="#3A3226">${adsPreset === 'today' ? 'press: yesterday' : 'press: today'}</text>`);
    parts.push('</svg>');
    return parts.join('');
  }
  const active = adsPreset === win.preset;
  if (active) {
    // pressed state = the whole key lights up coral, no squinting required
    parts.push(`<rect x="3" y="3" width="138" height="138" rx="12" fill="${C.coral}"/>`);
  } else {
    parts.push(`<rect x="3" y="3" width="138" height="138" rx="12" fill="none" stroke="${C.coral}" stroke-width="2" opacity="0.55"/>`);
  }
  const ink = active ? '#17151E' : C.cream;
  const y0 = win.words.length > 1 ? 52 : 64;
  win.words.forEach((word, i) => {
    parts.push(`<text x="72" y="${y0 + i * 22}" text-anchor="middle" font-family="${SANS}" font-size="18" font-weight="800" fill="${ink}">${esc(word)}</text>`);
  });
  if (active) parts.push(`<text x="72" y="104" text-anchor="middle" font-family="${SANS}" font-size="12" font-weight="700" fill="#17151E">SHOWING NOW</text>`);
  parts.push(`<text x="72" y="126" text-anchor="middle" font-family="${SANS}" font-size="10" fill="${active ? '#3A3226' : C.muted}">${active ? 'press: back to today' : 'press: switch'}</text>`);
  parts.push('</svg>');
  return parts.join('');
}

// ---- session -> hosting app wiring ----
// Match each session to its live `claude` process (by launch cwd), walk the
// parent chain to the GUI app hosting it (Warp/Claude app/iTerm/...), so a
// tap opens the RIGHT app. `open -b` needs no macOS permissions.
const HOST_APPS = [
  ['/Warp.app/', 'dev.warp.Warp-Stable', 'Warp'],
  ['/Claude.app/', 'com.anthropic.claudefordesktop', 'Claude'],
  ['/iTerm.app/', 'com.googlecode.iterm2', 'iTerm'],
  ['/Terminal.app/', 'com.apple.Terminal', 'Terminal'],
  ['/Cursor.app/', 'com.todesktop.230313mzl4w4u92', 'Cursor'],
  ['/Visual Studio Code.app/', 'com.microsoft.VSCode', 'VS Code'],
];

// Each registry entry has the session's PID — walk its parent chain to find
// the GUI app hosting it. No cwd guessing.
function enrichSessionApps(done) {
  if (!sessions.list.length) return done && done();
  execFile('/bin/ps', ['-axo', 'pid=,ppid=,command='], { maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
    if (err || !out) return done && done();
    const table = {};
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (m) table[+m[1]] = { ppid: +m[2], cmd: m[3] };
    }
    const ancestorApp = (pid) => {
      let p = pid, hops = 0;
      while (p && p > 1 && hops++ < 25) {
        const row = table[p];
        if (!row) break;
        for (const [needle, bundle, name] of HOST_APPS) {
          if (row.cmd.includes(needle)) return { bundle, name };
        }
        p = row.ppid;
      }
      return null;
    };
    for (const s of sessions.list) {
      const app = s.pid ? ancestorApp(s.pid) : null;
      if (app) { s.bundle = app.bundle; s.appName = app.name; }
    }
    done && done();
  });
}

// Quick tap / dial press -> jump to the terminal hosting the session (raise
// the window whose title carries the session name).
// LONG press -> open the exact chat on claude.ai, in the Chrome profile that
// holds that Claude account's login (accounts.json "chromeProfile").
function focusSession(s, opts = {}) {
  if (opts.deep && s.bridge) {
    const acct = ACCOUNTS[`com.fahim.claude-duo.${s.src}`] || {};
    const url = `https://claude.ai/code/${s.bridge}`;
    log(`focus deep: "${s.name}" -> ${url} chromeProfile=${acct.chromeProfile || 'default browser'}`);
    if (acct.chromeProfile) {
      execFile('/usr/bin/open', ['-na', 'Google Chrome', '--args', `--profile-directory=${acct.chromeProfile}`, url], (e) => { if (e) log('chrome open failed:', e.message); });
    } else {
      execFile('/usr/bin/open', [url], (e) => { if (e) log('open url failed:', e.message); });
    }
    return;
  }
  const bundle = s.bundle || 'dev.warp.Warp-Stable';
  const words = tabKeywords(s.name);
  log(`focus: "${s.name}" app=${s.appName || 'default(Warp)'} keywords=${words.join(',')}`);
  execFile('/usr/bin/open', ['-b', bundle], (e) => { if (e) log('open -b failed:', e.message); });
  if (!words.length) return;
  // Terminal tabs can't be clicked from outside (no AX tree), but they CAN be
  // cycled: Ctrl+Tab through tabs, reading the window title after each hop,
  // stop when it matches the session's keywords. Needs Accessibility for
  // Stream Deck — the log says so explicitly if it's missing.
  const cond = words.map((w) => `t contains "${w}"`).join(' or ');
  const script = `
    tell application "System Events"
      tell (first process whose bundle identifier is "${bundle}")
        set frontmost to true
        delay 0.2
        set found to false
        repeat with i from 1 to 18
          set t to title of window 1
          if (${cond}) then
            set found to true
            exit repeat
          end if
          keystroke tab using control down
          delay 0.15
        end repeat
        return found
      end tell
    end tell`;
  execFile('/usr/bin/osascript', ['-e', script], (e, so, se) => {
    if (e) log('tab cycle BLOCKED — grant Stream Deck Accessibility in System Settings:', String(se || e.message).trim().slice(0, 140));
    else log('tab cycle result: found=' + String(so).trim());
  });
}

function tabKeywords(name) {
  const stop = new Set(['claude', 'session', 'sessions', 'about', 'their', 'there', 'which', 'would', 'could', 'should', 'going', 'want', 'need', 'have', 'that', 'this', 'with', 'look', 'through', 'make', 'sure', 'like', 'just']);
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !stop.has(w))
    .slice(0, 5);
}

// ---------- Stream Deck wiring ----------

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^-+/, '')] = process.argv[i + 1];
}

if (args.test !== undefined || process.argv.includes('--test') || process.argv.includes('--mock')) {
  (async () => {
    const mock = process.argv.includes('--mock');
    const future = (h) => new Date(Date.now() + h * 3600_000).toISOString();
    for (const uuid of Object.keys(ACCOUNTS)) {
      if (mock) {
        const personal = uuid.endsWith('personal');
        cache[uuid] = {
          data: {
            current: { pct: personal ? 29 : 10, resetsAt: future(1.2) },
            weekly: { pct: personal ? 36 : 7, resetsAt: personal ? future(129) : future(56) },
            model: null, modelName: null,
          },
          error: null, fetchedAt: Date.now(),
        };
      } else await fetchUsage(uuid);
      const entry = cache[uuid];
      const label = ACCOUNTS[uuid].label.replace(/\s+/g, '');
      console.log(label, JSON.stringify(entry.data || entry.error));
      const dir = path.join(__dirname, '..', 'logs');
      const pngOf = (svg) => Buffer.from(svgToPngDataUri(svg).split(',')[1], 'base64');
      fs.writeFileSync(path.join(dir, `test-key-${label}.png`), pngOf(renderSvg(uuid)));
    }
    const dir = path.join(__dirname, '..', 'logs');
    if (process.argv.includes('--mock')) {
      sessions.list = [
        { name: 'fahimshad-57', folder: 'miassist-studio', cwd: '/x/miassist-studio', state: 'waiting', ageMs: 14 * 60000, src: 'personal', bridge: 'session_x' },
        { name: 'fahimshad-7e', folder: 'homereel', cwd: '/x/homereel', state: 'working', ageMs: 30000, src: 'business', bridge: 'session_y' },
        { name: 'fahimshad-69', folder: 'lead-research', cwd: '/x/lead-research', state: 'working', ageMs: 120000, src: 'personal', bridge: 'session_z' },
      ];
    } else {
      scanSessions();
    }
    const duoSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="100">${duoInner(800)}</svg>`;
    fs.writeFileSync(path.join(dir, 'test-duo-800.png'), Buffer.from(svgToPngDataUri(duoSvg).split(',')[1], 'base64'));
    const sesSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="100">${sessionsInner(800)}</svg>`;
    fs.writeFileSync(path.join(dir, 'test-sessions-800.png'), Buffer.from(svgToPngDataUri(sesSvg).split(',')[1], 'base64'));
    const png = (name, svgInner, wpx = 800) => {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${wpx}" height="100">${svgInner}</svg>`;
      fs.writeFileSync(path.join(dir, name), Buffer.from(svgToPngDataUri(svg).split(',')[1], 'base64'));
    };
    const keyPng = (name, svg) => fs.writeFileSync(path.join(dir, name), Buffer.from(svgToPngDataUri(svg).split(',')[1], 'base64'));
    if (mock) {
      const mkLead = (name, stage, minsAgo, extra = {}) => ({
        id: name, name, stage, temperature: null,
        createdMs: Date.now() - minsAgo * 60000, ageMs: minsAgo * 60000,
        followMs: 0, savedMs: 0, workedMs: 0, due: false,
        phone: '+13215557214', email: `${name.split(' ')[0].toLowerCase()}@gmail.com`, src: 'facebook_ads',
        qname: name, ...extra,
      });
      crm.cats = {
        newtoday: [
          mkLead('Maria Gonzalez', 'new', 2),
          mkLead('Patricia Hill', 'new', 95),
          mkLead('Ismael Trevino', 'new', 240, { src: 'instagram_ads' }),
          mkLead('(321) 555-7214', 'new', 300, { email: null }),
        ],
        followup: [
          mkLead('Coastal Dental', 'follow_up', 3 * 1440, { followMs: Date.now() - 3 * 86400_000, due: true }),
          mkLead('J&R HVAC', 'booked', 26 * 60, { followMs: Date.now() + 3600_000 }),
        ],
        worked: [mkLead('On The Level Cleaning', 'talked', 95, { workedMs: Date.now() - 3600_000 })],
        saved: [mkLead('Palm Bay Nails', 'tried', 2 * 1440, { savedMs: Date.now() - 2 * 86400_000 })],
      };
      crmCat = 'newtoday'; crmMode = 'list'; crmSel = 0;
    } else {
      await fetchLeads();
      console.log('crm', JSON.stringify({
        counts: Object.fromEntries(Object.entries(crm.cats).map(([k, v]) => [k, v.length])),
        cat: crmCat, error: crm.error,
      }));
    }
    png('test-crm-800.png', crmInner(800));
    crmMode = 'detail';
    png('test-crm-detail-800.png', crmInner(800));
    crmMode = 'list';
    if (mock) {
      leadAlert = { name: 'Maria Gonzalez', at: Date.now() };
      png('test-crm-alert-800.png', crmInner(800));
      png('test-duo-newlead-800.png', duoInner(800));
      leadAlert = null;
    }
    if (mock) {
      ads.rows = [
        { label: 'My Studio', act: '1', spend: 12.47, leads: 3, cpl: 4.16 },
        { label: 'AgentNaf', act: '2', spend: 18.9, leads: 2, cpl: 9.45 },
        { label: 'CHS', act: '3', spend: 6.2, leads: 0, cpl: null },
      ];
      ads.fetchedAt = Date.now();
    } else {
      await fetchAds();
      console.log('ads', JSON.stringify(ads.rows.map((r) => ({ [r.label]: `$${r.spend} / ${r.leads}L` }))));
    }
    png('test-ads-800.png', adsInner(800));
    keyPng('test-key-ads-0.png', adsKeySvg(0));
    keyPng('test-key-ads-3.png', adsKeySvg(3));
    keyPng('test-key-adswin-1.png', adsWinKeySvg(1));
    keyPng('test-key-adswin-3.png', adsWinKeySvg(3));
    adsPreset = 'yesterday';
    keyPng('test-key-adswin-active.png', adsWinKeySvg(0));
    adsPreset = 'today';
    if (mock) {
      crm.cats.all = [...crm.cats.newtoday, ...crm.cats.followup, ...crm.cats.worked, ...crm.cats.saved];
      crmAllLeads = true; crmSel = 0; crmMode = 'list';
      png('test-crm-all-800.png', crmInner(800));
      keyPng('test-key-cat-all.png', crmCatKeySvg(3));
      crmAllLeads = false;
    }
    keyPng('test-key-crm.png', crmKeySvg());
    keyPng('test-key-cat-followup.png', crmCatKeySvg(2));
    keyPng('test-key-cat-newtoday.png', crmCatKeySvg(3));
    keyPng('test-key-person-0.png', crmPersonKeySvg(0));
    keyPng('test-key-skill-0.png', skillKeySvg(0));
    keyPng('test-key-skill-3.png', skillKeySvg(3));
    console.log('pngs -> logs/ (exact device output)');
    process.exit(0);
  })();
  return;
}

const ws = new WebSocket(`ws://127.0.0.1:${args.port}`);

function send(msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function allEncoders() {
  return [...contexts.entries()]
    .filter(([, info]) => info.controller === 'Encoder')
    .sort((a, b) => (a[1].column ?? 0) - (b[1].column ?? 0));
}

function renderContext(context) {
  const info = contexts.get(context);
  if (!info) return;
  if (info.action === SKILLS_ACTION) {
    if (info.controller === 'Encoder') {
      const group = allEncoders().filter(([, i]) => i.action === SKILLS_ACTION);
      const idx = Math.max(0, group.findIndex(([ctx]) => ctx === context));
      send({ event: 'setFeedback', context, payload: { canvas: svgToPngDataUri(skillsSlice(idx, Math.max(1, group.length))) } });
    } else {
      send({ event: 'setImage', context, payload: { image: svgToPngDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="28 0 144 100">${skillsInner(200)}</svg>`), target: 0 } });
    }
    return;
  }
  if (COMMS[info.action]) {
    if (info.controller === 'Encoder') {
      const group = allEncoders().filter(([, i]) => i.action === info.action);
      const idx = Math.max(0, group.findIndex(([ctx]) => ctx === context));
      send({ event: 'setFeedback', context, payload: { canvas: svgToPngDataUri(commsSlice(info.action, idx, Math.max(1, group.length))) } });
    } else {
      send({ event: 'setImage', context, payload: { image: svgToPngDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="28 0 144 100">${commsInner(info.action, 200)}</svg>`), target: 0 } });
    }
    return;
  }
  if (info.action === SESSIONS_ACTION) {
    if (info.controller === 'Encoder') {
      const group = allEncoders().filter(([, i]) => i.action === SESSIONS_ACTION);
      const idx = Math.max(0, group.findIndex(([ctx]) => ctx === context));
      send({ event: 'setFeedback', context, payload: { canvas: svgToPngDataUri(sessionsSlice(idx, Math.max(1, group.length))) } });
    } else {
      send({ event: 'setImage', context, payload: { image: svgToPngDataUri(sessionsKeySvg()), target: 0 } });
    }
    return;
  }
  if (info.action === CRM_ACTION) {
    if (info.controller === 'Encoder') {
      const group = allEncoders().filter(([, i]) => i.action === CRM_ACTION);
      const idx = Math.max(0, group.findIndex(([ctx]) => ctx === context));
      send({ event: 'setFeedback', context, payload: { canvas: svgToPngDataUri(crmSlice(idx, Math.max(1, group.length))) } });
    } else {
      send({ event: 'setImage', context, payload: { image: svgToPngDataUri(crmKeySvg()), target: 0 } });
    }
    return;
  }
  if (info.action === CRMLEAD_ACTION) {
    const svg = (info.row ?? 0) === 0 ? crmCatKeySvg(info.column ?? 0) : crmPersonKeySvg(info.column ?? 0);
    send({ event: 'setImage', context, payload: { image: svgToPngDataUri(svg), target: 0 } });
    return;
  }
  if (info.action === SKILLKEY_ACTION) {
    const idx = (info.settings?.base ?? 0) + (info.row ?? 0) * 4 + (info.column ?? 0);
    if (info.settings?.base !== undefined && !info.loggedOnce) {
      info.loggedOnce = true;
      log(`skill folder key col=${info.column} row=${info.row} base=${info.settings.base} idx=${idx} -> ${SKILLS[idx] || 'EMPTY'}`);
    }
    send({ event: 'setImage', context, payload: { image: svgToPngDataUri(skillKeySvg(idx)), target: 0 } });
    return;
  }
  if (info.action === ADS_ACTION) {
    if (info.controller === 'Encoder') {
      const group = allEncoders().filter(([, i]) => i.action === ADS_ACTION);
      const idx = Math.max(0, group.findIndex(([ctx]) => ctx === context));
      send({ event: 'setFeedback', context, payload: { canvas: svgToPngDataUri(adsSlice(idx, Math.max(1, group.length))) } });
    } else {
      send({ event: 'setImage', context, payload: { image: svgToPngDataUri(adsKeySvg(0)), target: 0 } });
    }
    return;
  }
  if (info.action === ADSKEY_ACTION) {
    const svg = (info.row ?? 0) === 0 ? adsKeySvg(info.column ?? 0) : adsWinKeySvg(info.column ?? 0);
    send({ event: 'setImage', context, payload: { image: svgToPngDataUri(svg), target: 0 } });
    return;
  }
  if (info.controller === 'Encoder') {
    const everyone = allEncoders().filter(([, i]) => i.action !== SESSIONS_ACTION && i.action !== CRM_ACTION && i.action !== CRMLEAD_ACTION);
    const distinct = new Set(everyone.map(([, i]) => i.action));
    const isAdjacent = (list) => list.every(([, i], idx) => idx === 0 || (i.column ?? 0) === (list[idx - 1][1].column ?? 0) + 1);
    let svg;
    if (distinct.size >= 2 && everyone.length >= 3 && isAdjacent(everyone)) {
      // both accounts filling adjacent slots -> one unified dashboard
      const idx = Math.max(0, everyone.findIndex(([ctx]) => ctx === context));
      svg = duoSlice(idx, everyone.length);
    } else {
      // stitch only same-account ADJACENT runs; anything else renders compact
      const group = everyone.filter(([, i]) => i.action === info.action);
      if (group.length >= 2 && isAdjacent(group)) {
        const idx = Math.max(0, group.findIndex(([ctx]) => ctx === context));
        svg = stripSlice(info.action, idx, group.length);
      } else {
        svg = stripSlice(info.action, 0, 1);
      }
    }
    send({
      event: 'setFeedback',
      context,
      payload: { canvas: svgToPngDataUri(svg) },
    });
  } else {
    send({
      event: 'setImage',
      context,
      payload: { image: svgToPngDataUri(renderSvg(info.action)), target: 0 },
    });
  }
}

function renderAll() {
  for (const context of contexts.keys()) renderContext(context);
}

async function fetchAll() {
  // sequential with a gap — bursts trip the endpoint's rate limit
  const active = new Set([...contexts.values()].map((info) => info.action).filter((a) => ACCOUNTS[a]));
  for (const uuid of active) {
    await fetchUsage(uuid);
    await new Promise((r) => setTimeout(r, 700));
  }
  renderAll();
}

ws.on('open', () => {
  log('connected, registering', args.pluginUUID);
  send({ event: args.registerEvent, uuid: args.pluginUUID });
  setTimeout(fetchAll, 3000); // one staggered initial fetch after willAppears settle
  setInterval(fetchAll, FETCH_INTERVAL_MS);
  setInterval(renderAll, RENDER_INTERVAL_MS);
  scanSessions();
  enrichSessionApps(renderAll);
  pollBadges();
  setInterval(pollBadges, 10_000);
  fetchLeads().then(renderAll);
  setInterval(() => fetchLeads().then(renderAll), CRM_POLL_MS);
  fetchAds().then(renderAll);
  setInterval(() => fetchAds().then(renderAll), ADS_POLL_MS);
  setInterval(() => {
    scanSessions();
    enrichSessionApps(renderAll);
  }, 15_000);
  // mascot heartbeat — always in motion, cycling idle routines
  setInterval(() => {
    if (!contexts.size) return;
    mascotFrame++;
    advanceMascot();
    renderAll();
  }, 450);
});

const keyDownAt = new Map(); // context -> press time, to tell a hold from a tap
ws.on('message', (buf) => {
  let ev;
  try { ev = JSON.parse(buf.toString()); } catch { return; }
  switch (ev.event) {
    case 'keyUp': {
      if (ev.action !== CRMLEAD_ACTION) break;
      const held = Date.now() - (keyDownAt.get(ev.context) || Date.now());
      keyDownAt.delete(ev.context);
      const info = contexts.get(ev.context) || {};
      const row = info.row ?? ev.payload?.coordinates?.row ?? 0;
      const col = info.column ?? ev.payload?.coordinates?.column ?? 0;
      if (row === 0) {
        const cat = CRM_CATS[col];
        if (!cat) break;
        if (cat.key === 'newtoday' && crmCat === 'newtoday' && held > 550) {
          // hold New Today -> widen the window: today -> 3 days -> 7 days
          const steps = [1, 3, 7];
          crmNewDays = steps[(steps.indexOf(crmNewDays) + 1) % steps.length];
          crmAllLeads = false;
          crmMode = 'list'; crmSel = 0;
          renderAll(); // show the new label instantly...
          fetchLeads().then(renderAll); // ...then the wider list
        } else if (cat.key === 'newtoday' && crmCat === 'newtoday') {
          // press New Today AGAIN -> flip to All Leads (newest first), and back
          crmAllLeads = !crmAllLeads;
          crmMode = 'list'; crmSel = 0; renderAll();
        } else {
          crmCat = cat.key;
          if (cat.key === 'newtoday') crmAllLeads = false;
          crmMode = 'list'; crmSel = 0; renderAll();
        }
      } else if (crmActiveList()[col]) {
        crmSel = col; crmMode = 'detail'; renderAll();
      }
      break;
    }
    case 'willAppear':
      contexts.set(ev.context, {
        action: ev.action,
        controller: ev.payload?.controller || 'Keypad',
        column: ev.payload?.coordinates?.column ?? 0,
        row: ev.payload?.coordinates?.row ?? 0,
        settings: ev.payload?.settings || {},
      });
      renderAll(); // re-render the whole group so wide panels re-stitch
      break;
    case 'willDisappear':
      contexts.delete(ev.context);
      renderAll();
      break;
    case 'keyDown':
    case 'touchTap':
    case 'dialDown': {
      if (COMMS[ev.action]) {
        if (ev.event === 'touchTap' && ev.payload?.hold && ev.action.endsWith('.slack')) {
          launchSlackSweep(); // hold the Slack card -> Claude sweeps the channels
          break;
        }
        execFile('/usr/bin/open', ['-b', COMMS[ev.action].bundle], () => {});
        break;
      }
      if (ev.action === SKILLS_ACTION) {
        launchSkill(SKILLS[skillSel]);
        break;
      }
      if (ev.action === SKILLKEY_ACTION) {
        const info = contexts.get(ev.context) || {};
        const idx = (info.settings?.base ?? 0) + (info.row ?? ev.payload?.coordinates?.row ?? 0) * 4 + (info.column ?? ev.payload?.coordinates?.column ?? 0);
        if (SKILLS[idx]) launchSkill(SKILLS[idx]);
        break;
      }
      if (ev.action === ADSKEY_ACTION) {
        const info = contexts.get(ev.context) || {};
        const keyRow = info.row ?? ev.payload?.coordinates?.row ?? 0;
        const col = info.column ?? ev.payload?.coordinates?.column ?? 0;
        if (keyRow === 0) {
          const row = ads.rows[col];
          openAdsAccount(row ? row.act : null); // empty slots (incl. "All Ads") -> Ads Manager home
          break;
        }
        const win = ADS_WIN_KEYS[col];
        if (win) {
          // status key toggles today<->yesterday (and returns from any window);
          // the other keys jump to their window, press again -> back to today
          if (win.toggle) adsPreset = adsPreset === 'today' ? 'yesterday' : 'today';
          else adsPreset = adsPreset === win.preset ? 'today' : win.preset;
          log('ads window ->', adsPreset);
          renderAll(); // title flips + cards dim instantly
          fetchAds().then(renderAll);
        }
        break;
      }
      if (ev.action === ADS_ACTION) {
        if (ev.event === 'touchTap' && Array.isArray(ev.payload?.tapPos)) {
          if (ev.payload.hold) { launchAdsBrief(); break; }
          const group = allEncoders().filter(([, i]) => i.action === ADS_ACTION);
          const sliceIdx = Math.max(0, group.findIndex(([ctx]) => ctx === ev.context));
          const w = 200 * Math.max(1, group.length);
          const absX = ev.payload.tapPos[0] + sliceIdx * 200;
          const { n, cardW } = cardGeometry(w);
          const cardIdx = Math.max(0, Math.min(n - 1, Math.floor((absX - CARD_MARGIN) / (cardW + CARD_MARGIN))));
          openAdsAccount(ads.rows[cardIdx] ? ads.rows[cardIdx].act : null);
          break;
        }
        openAdsAccount(null); // knob press / plain key -> Ads Manager home
        break;
      }
      if (ev.action === CRMLEAD_ACTION) {
        // act on keyUp so we can tell a hold from a press (see the keyUp case)
        keyDownAt.set(ev.context, Date.now());
        break;
      }
      if (ev.action === CRM_ACTION) {
        const list = crmActiveList();
        if (ev.event === 'dialDown') {
          // knob toggles list <-> detail of the highlighted person
          crmMode = crmMode === 'detail' || !list.length ? 'list' : 'detail';
          renderAll();
          break;
        }
        if (ev.event === 'touchTap' && Array.isArray(ev.payload?.tapPos)) {
          if (ev.payload.hold) { launchCrmBrief(); break; }
          const group = allEncoders().filter(([, i]) => i.action === CRM_ACTION);
          const sliceIdx = Math.max(0, group.findIndex(([ctx]) => ctx === ev.context));
          const w = 200 * Math.max(1, group.length);
          const absX = ev.payload.tapPos[0] + sliceIdx * 200;
          if (ev.payload.tapPos[1] < CARD_TOP) { openCrm('/admin/analytics/leads'); break; } // header tap -> board
          if (crmMode === 'detail') { openLead(list[crmSel]); break; } // detail tap -> that person on the board
          const { n, cardW } = cardGeometry(w);
          const cardIdx = Math.max(0, Math.min(n - 1, Math.floor((absX - CARD_MARGIN) / (cardW + CARD_MARGIN))));
          const pageStart = Math.floor(crmSel / n) * n;
          if (list[pageStart + cardIdx]) { crmSel = pageStart + cardIdx; crmMode = 'detail'; renderAll(); }
          break;
        }
        openCrm('/admin/analytics/leads'); // keypad press -> the board
        break;
      }
      if (ev.action === SESSIONS_ACTION) {
        if (ev.event === 'dialDown') {
          // press the knob -> open the highlighted session's exact chat
          const target = sessions.list[sessionSel];
          if (target) focusSession(target, { deep: true });
          break;
        }
        if (ev.event === 'touchTap' && Array.isArray(ev.payload?.tapPos)) {
          const group = allEncoders().filter(([, i]) => i.action === SESSIONS_ACTION);
          const sliceIdx = Math.max(0, group.findIndex(([ctx]) => ctx === ev.context));
          const w = 200 * Math.max(1, group.length);
          const { n, cardW } = cardGeometry(w);
          const absX = ev.payload.tapPos[0] + sliceIdx * 200;
          const cardIdx = Math.max(0, Math.min(n - 1, Math.floor((absX - CARD_MARGIN) / (cardW + CARD_MARGIN))));
          const pageStart = Math.floor(sessionSel / n) * n;
          const target = sessions.list[pageStart + cardIdx];
          if (target && ev.payload.tapPos[1] >= CARD_TOP) {
            sessionSel = pageStart + cardIdx;
            // quick tap -> exact chat on claude.ai; HOLD -> try the terminal
            focusSession(target, { deep: !ev.payload.hold });
            renderAll();
            break;
          }
        }
        scanSessions();
        renderAll();
        break;
      }
      if (ev.event === 'dialDown') {
        // usage page: press a knob -> NEW terminal session for that side
        // (left knobs = Claude 1 personal, right knobs = Claude 2 mi assist)
        const col = contexts.get(ev.context)?.column ?? ev.payload?.coordinates?.column ?? 0;
        launchClaude(col >= 2 ? 'business' : 'personal');
        break;
      }
      if (ev.event === 'touchTap' && Array.isArray(ev.payload?.tapPos)) {
        // route by which HALF of the dashboard was touched (personal cards
        // span up to x≈498 in the 800px duo layout)
        const col = contexts.get(ev.context)?.column ?? 0;
        const absX = col * 200 + ev.payload.tapPos[0];
        openUsage(absX < 498 ? 'personal' : 'business');
        break;
      }
      // keypad buttons: the action itself names the account
      openUsage(ev.action === 'com.fahim.claude-duo.business' ? 'business' : 'personal');
      break;
    }
    case 'dialRotate':
      if (ev.action === SKILLS_ACTION) {
        skillSel = (skillSel + (ev.payload?.ticks > 0 ? 1 : -1) + SKILLS.length) % SKILLS.length;
        renderAll();
        break;
      }
      if (ev.action === CRM_ACTION) {
        const maxLead = Math.max(0, crmActiveList().length - 1);
        crmSel = Math.max(0, Math.min(maxLead, crmSel + (ev.payload?.ticks > 0 ? 1 : -1)));
        renderAll();
        break;
      }
      if (ev.action === ADS_ACTION) {
        // twist the knob = flip the time window (fetch settles after the spin)
        const dir = ev.payload?.ticks > 0 ? 1 : -1;
        const at = ADS_PRESET_ORDER.indexOf(adsPreset);
        adsPreset = ADS_PRESET_ORDER[(at + dir + ADS_PRESET_ORDER.length) % ADS_PRESET_ORDER.length];
        renderAll();
        clearTimeout(adsDialTimer);
        adsDialTimer = setTimeout(() => fetchAds().then(renderAll), 500);
        break;
      }
      if (ev.action === SESSIONS_ACTION) {
        const max = Math.max(0, sessions.list.length - 1);
        sessionSel = Math.max(0, Math.min(max, sessionSel + (ev.payload?.ticks > 0 ? 1 : -1)));
        renderAll();
      } else {
        adjustVolume(ev.payload?.ticks ?? 0);
      }
      break;
  }
});

ws.on('close', () => { log('socket closed, exiting'); process.exit(0); });
ws.on('error', (err) => { log('socket error', err.message); });

// Dial rotation = system volume (throttled so fast spins don't spawn 20 processes)
let volPending = 0;
let volTimer = null;
function adjustVolume(ticks) {
  volPending += ticks;
  if (volTimer) return;
  volTimer = setTimeout(() => {
    const delta = volPending * 3;
    volPending = 0;
    volTimer = null;
    if (!delta) return;
    execFile('/usr/bin/osascript', ['-e',
      `set volume output volume ((output volume of (get volume settings)) + ${delta})`,
    ], () => {});
  }, 120);
}
