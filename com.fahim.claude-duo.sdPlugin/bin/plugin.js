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

const ACCOUNTS = {
  'com.fahim.claude-duo.personal': {
    label: 'Personal',
    service: 'Claude Code-credentials',
    account: 'fahimshad',
  },
  'com.fahim.claude-duo.business': {
    label: 'Mi Assist',
    service: 'Claude Code-credentials-76f8fc95',
    account: 'fahimshad',
  },
};

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

function pill(xRight, yTop, text, fontSize) {
  const w = Math.round(text.length * fontSize * 0.62) + 14;
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
  parts.push(`<text x="${x + pad}" y="${y + pad + pctSize * 0.78}" font-family="${SANS}" font-size="${pctSize}" font-weight="800" fill="${C.cream}">${pct}%</text>`);
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
    parts.push(spark(36, 50, 28, C.coral));
    parts.push(`<text x="74" y="60" font-family="${SERIF}" font-size="32" font-weight="700" fill="${C.cream}">Claude</text>`);
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
    const duoSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="100">${duoInner(800)}</svg>`;
    fs.writeFileSync(path.join(dir, 'test-duo-800.png'), Buffer.from(svgToPngDataUri(duoSvg).split(',')[1], 'base64'));
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
  if (info.controller === 'Encoder') {
    const everyone = allEncoders();
    const distinct = new Set(everyone.map(([, i]) => i.action));
    let svg;
    if (distinct.size >= 2) {
      // both accounts on the bar -> one unified dashboard across every slot
      const idx = Math.max(0, everyone.findIndex(([ctx]) => ctx === context));
      svg = duoSlice(idx, Math.max(1, everyone.length));
    } else {
      const group = everyone.filter(([, i]) => i.action === info.action);
      const idx = Math.max(0, group.findIndex(([ctx]) => ctx === context));
      svg = stripSlice(info.action, idx, Math.max(1, group.length));
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
  const active = new Set([...contexts.values()].map((info) => info.action));
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
    case 'dialDown':
      send({ event: 'openUrl', payload: { url: 'https://claude.ai/settings/usage' } });
      break;
  }
});

ws.on('close', () => { log('socket closed, exiting'); process.exit(0); });
ws.on('error', (err) => { log('socket error', err.message); });
