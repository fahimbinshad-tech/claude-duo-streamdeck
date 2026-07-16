// Claude Duo Usage — Stream Deck plugin
// Shows session / weekly / Fable usage for two Claude Code accounts.
// Reads OAuth tokens from macOS Keychain (same entries Claude Code maintains),
// polls https://api.anthropic.com/api/oauth/usage every 60s.
//
// Look: dark Claude aesthetic — coral spark that slowly spins + breathes,
// glowing level bars (green -> amber -> red as limits approach), shimmer
// sweep, smooth easing when values change, flashing % when critical.
// Animation = frame pushing at ~7fps (Stream Deck has no native SVG animation).
//
// Touch strip: place the same account action on 1 slot (compact) or 2 adjacent
// slots (wide 400px panel stitched across both segments by column order).

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const LOG_FILE = path.join(__dirname, '..', 'logs', 'plugin.log');
fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.map(String).join(' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
}

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const FETCH_INTERVAL_MS = 60_000;
const TICK_MS = 150; // ~6.7fps animation

const ACCOUNTS = {
  'com.fahim.claude-duo.personal': {
    label: 'PERSONAL',
    service: 'Claude Code-credentials',
    account: 'fahimshad',
  },
  'com.fahim.claude-duo.business': {
    label: 'MI ASSIST',
    service: 'Claude Code-credentials-76f8fc95',
    account: 'fahimshad',
  },
};

// Claude dark palette
const C = {
  bg: '#1F1E1B',
  panel: '#262521',
  cream: '#F0EEE6',
  muted: '#8B8878',
  track: '#38362F',
  coral: '#D97757',
  green: '#4ADE80',
  greenGlow: '#22C55E',
  amber: '#FBBF24',
  red: '#F87171',
  redGlow: '#EF4444',
};

// actionUUID -> { data, error, fetchedAt }
const cache = {};
// actionUUID -> eased displayed percentages per row
const displayed = {};
// streamdeck context -> { action, controller, column }
const contexts = new Map();
let phase = 0;

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

async function fetchUsage(actionUUID) {
  const acct = ACCOUNTS[actionUUID];
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
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    cache[actionUUID] = { data: parseUsage(json), error: null, fetchedAt: Date.now() };
  } catch (err) {
    const prev = cache[actionUUID] || {};
    cache[actionUUID] = { ...prev, error: err.message, fetchedAt: prev.fetchedAt };
    log(`fetch ${acct.label} failed:`, err.message);
  }
}

function parseUsage(json) {
  const rows = [];
  const byKind = {};
  for (const lim of json.limits || []) byKind[lim.kind] = lim;
  if (byKind.session) rows.push({ tag: '5H', pct: byKind.session.percent, resetsAt: byKind.session.resets_at });
  if (byKind.weekly_all) rows.push({ tag: 'WK', pct: byKind.weekly_all.percent, resetsAt: byKind.weekly_all.resets_at });
  if (byKind.weekly_scoped) {
    const name = byKind.weekly_scoped.scope?.model?.display_name || 'Model';
    rows.push({ tag: name.slice(0, 2).toUpperCase(), pct: byKind.weekly_scoped.percent, resetsAt: byKind.weekly_scoped.resets_at });
  }
  return { rows, sessionResetsAt: byKind.session ? byKind.session.resets_at : null };
}

function severity(pct) {
  if (pct >= 90) return 'crit';
  if (pct >= 70) return 'warn';
  return 'ok';
}

function barColors(pct) {
  const sev = severity(pct);
  if (sev === 'crit') return { fill: C.red, glow: C.redGlow };
  if (sev === 'warn') return { fill: C.amber, glow: C.amber };
  return { fill: C.green, glow: C.greenGlow };
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

// Eased display values so bars fill smoothly when data changes
function easedRows(actionUUID) {
  const entry = cache[actionUUID];
  if (!entry || !entry.data) return null;
  const targets = entry.data.rows;
  if (!displayed[actionUUID] || displayed[actionUUID].length !== targets.length) {
    displayed[actionUUID] = targets.map(() => 0);
  }
  const shown = displayed[actionUUID];
  return targets.map((row, i) => ({ ...row, shownPct: shown[i] }));
}

function stepEasing() {
  for (const [uuid, entry] of Object.entries(cache)) {
    if (!entry.data) continue;
    const targets = entry.data.rows.map((r) => Math.max(0, Math.min(100, r.pct)));
    if (!displayed[uuid] || displayed[uuid].length !== targets.length) displayed[uuid] = targets.map(() => 0);
    displayed[uuid] = displayed[uuid].map((cur, i) => {
      const diff = targets[i] - cur;
      return Math.abs(diff) < 0.4 ? targets[i] : cur + diff * 0.22;
    });
  }
}

// Claude spark (asterisk starburst) — slowly spins and breathes
function claudeSpark(cx, cy, r, color, opts = {}) {
  const rays = [
    [0, 1], [33, 0.82], [66, 0.95], [98, 0.78], [131, 1], [164, 0.85],
    [196, 0.92], [229, 0.8], [262, 1], [295, 0.84], [327, 0.9],
  ];
  const breathe = 1 + 0.06 * Math.sin(phase * 0.12);
  const angle = (phase * 1.2) % 360;
  const rr = r * breathe;
  const sw = Math.max(2, rr * 0.3);
  const parts = [`<g transform="rotate(${angle.toFixed(1)} ${cx} ${cy})" stroke="${color}" stroke-width="${sw.toFixed(1)}" stroke-linecap="round"${opts.opacity ? ` opacity="${opts.opacity}"` : ''}>`];
  for (const [deg, len] of rays) {
    const a = (deg * Math.PI) / 180;
    const x1 = cx + Math.cos(a) * rr * 0.18;
    const y1 = cy + Math.sin(a) * rr * 0.18;
    const x2 = cx + Math.cos(a) * rr * len;
    const y2 = cy + Math.sin(a) * rr * len;
    parts.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`);
  }
  parts.push('</g>');
  return parts.join('');
}

const SANS = "-apple-system, Helvetica";
const SERIF = "Georgia, 'Times New Roman', serif";

function errorInner(entry, cx, cy) {
  const parts = [];
  if (entry.error === 'EXPIRED') {
    parts.push(`<text x="${cx}" y="${cy}" text-anchor="middle" font-family="${SANS}" font-size="13" font-weight="700" fill="${C.red}">TOKEN EXPIRED</text>`);
    parts.push(`<text x="${cx}" y="${cy + 18}" text-anchor="middle" font-family="${SANS}" font-size="10" fill="${C.muted}">open claude to fix</text>`);
  } else if (entry.error) {
    parts.push(`<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-family="${SANS}" font-size="12" fill="${C.amber}">retrying…</text>`);
  } else {
    const dots = '.'.repeat(1 + (Math.floor(phase / 4) % 3));
    parts.push(`<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-family="${SANS}" font-size="12" fill="${C.muted}">loading${dots}</text>`);
  }
  return parts.join('');
}

// One glowing animated bar row. uid keeps clipPath ids unique per render.
let clipSeq = 0;
function barRow(row, x0, barX, barW, pctX, y, barH, fontSize) {
  const parts = [];
  const pct = Math.max(0, Math.min(100, Math.round(row.pct)));
  const shown = Math.max(0, Math.min(100, row.shownPct ?? pct));
  const { fill, glow } = barColors(pct);
  const sev = severity(pct);
  const fillW = Math.max(3, (shown / 100) * barW);
  const cid = `c${clipSeq++}`;

  // breathing glow — faster + stronger as severity rises
  const speed = sev === 'crit' ? 0.55 : sev === 'warn' ? 0.28 : 0.16;
  const base = sev === 'crit' ? 0.5 : sev === 'warn' ? 0.35 : 0.28;
  const pulse = base + (sev === 'crit' ? 0.4 : 0.22) * (0.5 + 0.5 * Math.sin(phase * speed));

  parts.push(`<text x="${x0}" y="${y + barH - 2}" font-family="${SANS}" font-size="${fontSize}" font-weight="700" fill="${C.muted}">${esc(row.tag)}</text>`);
  // glow layers (layered rects — no SVG filters, renders everywhere)
  parts.push(`<rect x="${barX - 3}" y="${y - 3}" width="${(fillW + 6).toFixed(1)}" height="${barH + 6}" rx="${(barH + 6) / 2}" fill="${glow}" opacity="${(pulse * 0.35).toFixed(2)}"/>`);
  parts.push(`<rect x="${barX - 1.5}" y="${y - 1.5}" width="${(fillW + 3).toFixed(1)}" height="${barH + 3}" rx="${(barH + 3) / 2}" fill="${glow}" opacity="${(pulse * 0.55).toFixed(2)}"/>`);
  // track + fill
  parts.push(`<rect x="${barX}" y="${y}" width="${barW}" height="${barH}" rx="${barH / 2}" fill="${C.track}"/>`);
  parts.push(`<clipPath id="${cid}"><rect x="${barX}" y="${y}" width="${fillW.toFixed(1)}" height="${barH}" rx="${barH / 2}"/></clipPath>`);
  parts.push(`<rect x="${barX}" y="${y}" width="${fillW.toFixed(1)}" height="${barH}" rx="${barH / 2}" fill="${fill}"/>`);
  // shimmer sweep across the filled portion
  const sweepSpan = barW + 60;
  const sx = barX - 30 + ((phase * 2.4) % sweepSpan);
  parts.push(`<g clip-path="url(#${cid})"><rect x="${sx.toFixed(1)}" y="${y}" width="22" height="${barH}" fill="#FFFFFF" opacity="0.30" transform="skewX(-18)"/></g>`);
  // percent — flashes when critical
  const txtOpacity = sev === 'crit' ? (0.55 + 0.45 * Math.sin(phase * 0.9)).toFixed(2) : '1';
  parts.push(`<text x="${pctX}" y="${y + barH - 2}" text-anchor="end" font-family="${SANS}" font-size="${fontSize + 1}" font-weight="700" fill="${fill}" opacity="${txtOpacity}">${pct}</text>`);
  return parts.join('');
}

function worstSeverity(rows) {
  let worst = 'ok';
  for (const r of rows) {
    const s = severity(Math.round(r.pct));
    if (s === 'crit') return 'crit';
    if (s === 'warn') worst = 'warn';
  }
  return worst;
}

function sparkColor(rows) {
  if (!rows) return C.coral;
  const sev = worstSeverity(rows);
  if (sev === 'crit') {
    // pulse between coral and red when critical
    return Math.sin(phase * 0.5) > 0 ? C.redGlow : C.coral;
  }
  return C.coral;
}

// 144x144 key
function renderSvg(actionUUID) {
  const acct = ACCOUNTS[actionUUID];
  const entry = cache[actionUUID] || {};
  const rows = easedRows(actionUUID);
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">`);
  parts.push(`<rect width="144" height="144" rx="16" fill="${C.bg}"/>`);
  parts.push(claudeSpark(18, 17, 10, sparkColor(rows && rows.length ? rows : null)));
  parts.push(`<text x="34" y="22" font-family="${SANS}" font-size="12" font-weight="700" letter-spacing="0.5" fill="${C.cream}">${esc(acct.label)}</text>`);

  if (rows && rows.length) {
    let y = 42;
    for (const row of rows) {
      parts.push(barRow(row, 10, 34, 74, 136, y, 11, 11));
      y += 27;
    }
    const cd = countdown(entry.data.sessionResetsAt);
    if (cd) parts.push(`<text x="72" y="136" text-anchor="middle" font-family="${SANS}" font-size="10" fill="${C.muted}">5h resets ${esc(cd)}${entry.error ? ' !' : ''}</text>`);
  } else {
    parts.push(errorInner(entry, 72, 78));
  }
  parts.push(`</svg>`);
  return parts.join('');
}

// Touch strip content, width = 200 (compact) or 400 (wide, spans 2 slots)
function stripInner(actionUUID, w) {
  const acct = ACCOUNTS[actionUUID];
  const entry = cache[actionUUID] || {};
  const rows = easedRows(actionUUID);
  const parts = [];
  parts.push(`<rect width="${w}" height="100" fill="${C.bg}"/>`);

  if (w >= 400) {
    parts.push(claudeSpark(36, 40, 23, sparkColor(rows && rows.length ? rows : null)));
    parts.push(`<text x="66" y="48" font-family="${SERIF}" font-size="27" fill="${C.cream}">Claude</text>`);
    parts.push(`<text x="67" y="68" font-family="${SANS}" font-size="11" font-weight="700" letter-spacing="1.5" fill="${C.coral}">${esc(acct.label)}</text>`);
    if (rows && rows.length) {
      const cd = countdown(entry.data.sessionResetsAt);
      if (cd) parts.push(`<text x="67" y="86" font-family="${SANS}" font-size="10" fill="${C.muted}">5h resets ${esc(cd)}${entry.error ? ' !' : ''}</text>`);
      let y = 16;
      for (const row of rows) {
        parts.push(barRow(row, 178, 206, 148, 388, y, 12, 11));
        y += 27;
      }
    } else {
      parts.push(errorInner(entry, 280, 50));
    }
  } else {
    parts.push(claudeSpark(16, 14, 9, sparkColor(rows && rows.length ? rows : null)));
    parts.push(`<text x="30" y="18" font-family="${SANS}" font-size="12" font-weight="700" fill="${C.cream}">${esc(acct.label)}</text>`);
    if (rows && rows.length) {
      const cd = countdown(entry.data.sessionResetsAt);
      if (cd) parts.push(`<text x="192" y="18" text-anchor="end" font-family="${SANS}" font-size="10" fill="${C.muted}">5h ${esc(cd)}${entry.error ? ' !' : ''}</text>`);
      let y = 28;
      for (const row of rows) {
        parts.push(barRow(row, 8, 32, 122, 192, y, 10, 11));
        y += 23;
      }
    } else {
      parts.push(errorInner(entry, 100, 52));
    }
  }
  return parts.join('');
}

function stripSlice(actionUUID, sliceIndex, totalSlices) {
  clipSeq = 0;
  const inner = stripInner(actionUUID, 200 * totalSlices);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="${200 * sliceIndex} 0 200 100">${inner}</svg>`;
}

// ---------- Stream Deck wiring ----------

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^-+/, '')] = process.argv[i + 1];
}

if (args.test !== undefined || process.argv.includes('--test')) {
  (async () => {
    for (const uuid of Object.keys(ACCOUNTS)) {
      await fetchUsage(uuid);
      // settle easing so test images show real values
      for (let i = 0; i < 60; i++) stepEasing();
      const entry = cache[uuid];
      const label = ACCOUNTS[uuid].label.replace(/\s+/g, '');
      console.log(label, JSON.stringify(entry.data || entry.error));
      const dir = path.join(__dirname, '..', 'logs');
      clipSeq = 0;
      fs.writeFileSync(path.join(dir, `test-key-${label}.svg`), renderSvg(uuid));
      clipSeq = 0;
      fs.writeFileSync(path.join(dir, `test-strip-${label}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">${stripInner(uuid, 200)}</svg>`);
      clipSeq = 0;
      fs.writeFileSync(path.join(dir, `test-wide-${label}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100">${stripInner(uuid, 400)}</svg>`);
    }
    console.log('svgs -> logs/');
    process.exit(0);
  })();
  return;
}

const ws = new WebSocket(`ws://127.0.0.1:${args.port}`);

function send(msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function encoderGroup(actionUUID) {
  return [...contexts.entries()]
    .filter(([, info]) => info.controller === 'Encoder' && info.action === actionUUID)
    .sort((a, b) => (a[1].column ?? 0) - (b[1].column ?? 0));
}

function renderContext(context) {
  const info = contexts.get(context);
  if (!info) return;
  if (info.controller === 'Encoder') {
    const group = encoderGroup(info.action);
    const idx = Math.max(0, group.findIndex(([ctx]) => ctx === context));
    const svg = stripSlice(info.action, idx, Math.max(1, group.length));
    send({
      event: 'setFeedback',
      context,
      payload: { canvas: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64') },
    });
  } else {
    clipSeq = 0;
    const svg = renderSvg(info.action);
    send({
      event: 'setImage',
      context,
      payload: { image: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'), target: 0 },
    });
  }
}

function renderAll() {
  for (const context of contexts.keys()) renderContext(context);
}

async function fetchAll() {
  const active = new Set([...contexts.values()].map((info) => info.action));
  await Promise.all([...active].map((uuid) => fetchUsage(uuid)));
}

function tick() {
  if (contexts.size === 0) return;
  phase++;
  stepEasing();
  renderAll();
}

ws.on('open', () => {
  log('connected, registering', args.pluginUUID);
  send({ event: args.registerEvent, uuid: args.pluginUUID });
  setInterval(fetchAll, FETCH_INTERVAL_MS);
  setInterval(tick, TICK_MS);
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
      if (!cache[ev.action]) fetchUsage(ev.action);
      break;
    case 'willDisappear':
      contexts.delete(ev.context);
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
