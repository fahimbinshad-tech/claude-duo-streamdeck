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
function svgToPngDataUri(svg) {
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
    out[`com.fahim.claude-duo.${key}`] = { label: c.label, service: c.service, account: c.account || user };
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

// ---- the little Claude creature ----
// state-driven pixel mascot: chill (blinks), sleep, working (typing),
// alert (a session needs you), panic (a usage limit is critical)
let mascotFrame = 0;

function mascotGrid({ eyes = 'open', mouth = 'smile', arms = null }) {
  const r = (s) => s.split('');
  const g = [
    r('..oooooooooo..'),
    r('.oooooooooooo.'),
    r('oooooooooooooo'),
    r('oooooooooooooo'),
    r('oooooooooooooo'),
    r('oooooooooooooo'),
    r('oooooooooooooo'),
    r('oooooooooooooo'),
    r('.oooooooooooo.'),
    r('..oooooooooo..'),
    r('..dd......dd..'),
  ];
  const setPx = (row, col, ch) => { if (g[row] && g[row][col] !== undefined) g[row][col] = ch; };
  if (eyes === 'open') {
    [[3, 3], [3, 4], [4, 3], [4, 4], [3, 9], [3, 10], [4, 9], [4, 10]].forEach(([r2, c]) => setPx(r2, c, 'd'));
  } else if (eyes === 'closed') {
    [[4, 3], [4, 4], [4, 9], [4, 10]].forEach(([r2, c]) => setPx(r2, c, 'd'));
  } else if (eyes === 'down') {
    [[4, 3], [4, 4], [5, 3], [5, 4], [4, 9], [4, 10], [5, 9], [5, 10]].forEach(([r2, c]) => setPx(r2, c, 'd'));
  }
  if (mouth === 'smile') {
    [[6, 5], [7, 6], [7, 7], [6, 8]].forEach(([r2, c]) => setPx(r2, c, 'd'));
  } else if (mouth === 'o') {
    [[6, 6], [6, 7], [7, 6], [7, 7]].forEach(([r2, c]) => setPx(r2, c, 'd'));
  }
  if (arms === 'up') {
    [[1, 0], [0, 0], [1, 13], [0, 13]].forEach(([r2, c]) => setPx(r2, c, 'd'));
  } else if (arms === 'type-a') {
    [[7, 0], [8, 1]].forEach(([r2, c]) => setPx(r2, c, 'd'));
  } else if (arms === 'type-b') {
    [[8, 0], [7, 1], [7, 12], [8, 13]].forEach(([r2, c]) => setPx(r2, c, 'd'));
  }
  return g;
}

const MASCOT_STATES = {
  chill: (f) => ({ grid: mascotGrid({ eyes: f % 5 === 4 ? 'closed' : 'open' }), body: C.coral, bob: f % 2 }),
  sleep: (f) => ({ grid: mascotGrid({ eyes: 'closed', mouth: 'o' }), body: C.coral, bob: 0, zzz: f % 2 }),
  working: (f) => ({ grid: mascotGrid({ eyes: 'down', arms: f % 2 ? 'type-a' : 'type-b' }), body: C.coral, bob: 0 }),
  alert: (f) => ({ grid: mascotGrid({ eyes: 'open', mouth: 'o', arms: 'up' }), body: C.coral, bob: f % 2 ? 2 : 0, bang: true }),
  panic: (f) => ({ grid: mascotGrid({ eyes: 'open', mouth: 'o', arms: 'up' }), body: C.red, bob: f % 2 ? 3 : 0, bang: true, sweat: f % 2 }),
};

function mascotState() {
  let worst = 0;
  for (const entry of Object.values(cache)) {
    for (const m of [entry.data?.current, entry.data?.weekly]) {
      if (m && m.pct > worst) worst = m.pct;
    }
  }
  if (worst >= 90) return 'panic';
  if (waitingCount() > 0) return 'alert';
  if (sessions.list.some((s) => s.state === 'working')) return 'working';
  if (!sessions.list.length) return 'sleep';
  return 'chill';
}

function mascotSvg(x, y, scale, state, frame) {
  const { grid, body, bob = 0, zzz, bang, sweat } = MASCOT_STATES[state](frame);
  const colors = { o: body, d: '#332017', w: '#BFDBFE' };
  const parts = [`<g>`];
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
    parts.push(mascotSvg(14, 22, 4, st, mascotFrame));
    parts.push(`<text x="86" y="52" font-family="${SERIF}" font-size="30" font-weight="700" fill="${C.cream}">Claude</text>`);
    const waiting = waitingCount();
    if (waiting) {
      parts.push(`<circle cx="92" cy="68" r="4" fill="${C.amber}"/>`);
      parts.push(`<text x="100" y="72" font-family="${SANS}" font-size="11" font-weight="700" fill="${C.amber}">${waiting} need${waiting > 1 ? '' : 's'} you</text>`);
    } else {
      const label = { chill: 'all good', sleep: 'sleeping', working: 'working…', panic: 'limit close!', alert: '' }[st];
      if (label) parts.push(`<text x="88" y="72" font-family="${SANS}" font-size="11" fill="${st === 'panic' ? C.red : C.muted}">${label}</text>`);
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
const ACCOUNT_COLORS = { personal: '#60A5FA', business: '#F472B6' };

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
  if (info.controller === 'Encoder') {
    const everyone = allEncoders().filter(([, i]) => i.action !== SESSIONS_ACTION);
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
  setInterval(() => {
    scanSessions();
    enrichSessionApps(renderAll);
  }, 15_000);
  // mascot heartbeat — gentle 2-frame animation, state-driven
  setInterval(() => {
    if (!contexts.size) return;
    mascotFrame++;
    renderAll();
  }, 700);
});

ws.on('message', (buf) => {
  let ev;
  try { ev = JSON.parse(buf.toString()); } catch { return; }
  switch (ev.event) {
    case 'willAppear':
      contexts.set(ev.context, {
        action: ev.action,
        controller: ev.payload?.controller || 'Keypad',
        column: ev.payload?.coordinates?.column ?? 0,
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
      if (ev.action === SESSIONS_ACTION) {
        if (ev.event === 'dialDown') {
          // press the knob -> open the highlighted session
          const target = sessions.list[sessionSel];
          if (target) focusSession(target);
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
            focusSession(target, { deep: !!ev.payload.hold });
            renderAll();
            break;
          }
        }
        scanSessions();
        renderAll();
        break;
      }
      if (ev.event === 'dialDown') {
        // on the usage page: press a knob -> jump to the session waiting longest
        const needy = sessions.list.filter((s) => s.state === 'waiting').sort((a, b) => b.ageMs - a.ageMs)[0];
        if (needy) { focusSession(needy); break; }
      }
      send({ event: 'openUrl', payload: { url: 'https://claude.ai/settings/usage' } });
      break;
    }
    case 'dialRotate':
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
