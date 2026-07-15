// Claude Duo Usage — Stream Deck plugin
// Shows session / weekly / Fable usage for two Claude Code accounts.
// Reads OAuth tokens from macOS Keychain (same entries Claude Code maintains),
// polls https://api.anthropic.com/api/oauth/usage every 60s.

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
const RENDER_INTERVAL_MS = 30_000;

const ACCOUNTS = {
  'com.fahim.claude-duo.personal': {
    label: 'PERSONAL',
    service: 'Claude Code-credentials',
    account: 'fahimshad',
    accent: '#60a5fa',
  },
  'com.fahim.claude-duo.business': {
    label: 'MIASSIST',
    service: 'Claude Code-credentials-76f8fc95',
    account: 'fahimshad',
    accent: '#c084fc',
  },
};

// actionUUID -> { data, error, fetchedAt }
const cache = {};
// streamdeck context -> { action, controller }  (controller: "Keypad" | "Encoder")
const contexts = new Map();

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

function severityColor(pct) {
  if (pct >= 90) return '#ef4444';
  if (pct >= 70) return '#f59e0b';
  return '#22c55e';
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

function renderSvg(actionUUID) {
  const acct = ACCOUNTS[actionUUID];
  const entry = cache[actionUUID] || {};
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">`);
  parts.push(`<rect width="144" height="144" rx="14" fill="#16161d"/>`);
  parts.push(`<text x="72" y="24" text-anchor="middle" font-family="-apple-system, Helvetica" font-size="15" font-weight="700" fill="${acct.accent}">${esc(acct.label)}</text>`);

  if (entry.data && entry.data.rows.length) {
    let y = 44;
    for (const row of entry.data.rows) {
      const pct = Math.max(0, Math.min(100, Math.round(row.pct)));
      const color = severityColor(pct);
      const barW = Math.max(2, Math.round((pct / 100) * 74));
      parts.push(`<text x="10" y="${y + 9}" font-family="-apple-system, Helvetica" font-size="12" font-weight="600" fill="#9ca3af">${esc(row.tag)}</text>`);
      parts.push(`<rect x="34" y="${y}" width="74" height="11" rx="5.5" fill="#2b2b33"/>`);
      parts.push(`<rect x="34" y="${y}" width="${barW}" height="11" rx="5.5" fill="${color}"/>`);
      parts.push(`<text x="136" y="${y + 10}" text-anchor="end" font-family="-apple-system, Helvetica" font-size="12" font-weight="700" fill="${color}">${pct}</text>`);
      y += 26;
    }
    const cd = countdown(entry.data.sessionResetsAt);
    if (cd) {
      parts.push(`<text x="72" y="136" text-anchor="middle" font-family="-apple-system, Helvetica" font-size="11" fill="#6b7280">5h resets ${esc(cd)}</text>`);
    }
    if (entry.error) {
      parts.push(`<text x="134" y="24" text-anchor="end" font-size="13" fill="#f59e0b">!</text>`);
    }
  } else if (entry.error === 'EXPIRED') {
    parts.push(`<text x="72" y="70" text-anchor="middle" font-family="-apple-system, Helvetica" font-size="14" font-weight="700" fill="#ef4444">TOKEN</text>`);
    parts.push(`<text x="72" y="88" text-anchor="middle" font-family="-apple-system, Helvetica" font-size="14" font-weight="700" fill="#ef4444">EXPIRED</text>`);
    parts.push(`<text x="72" y="112" text-anchor="middle" font-family="-apple-system, Helvetica" font-size="10" fill="#6b7280">open claude to fix</text>`);
  } else if (entry.error) {
    parts.push(`<text x="72" y="78" text-anchor="middle" font-family="-apple-system, Helvetica" font-size="13" fill="#f59e0b">retrying…</text>`);
  } else {
    parts.push(`<text x="72" y="78" text-anchor="middle" font-family="-apple-system, Helvetica" font-size="13" fill="#6b7280">loading…</text>`);
  }
  parts.push(`</svg>`);
  return parts.join('');
}

// 200x100 landscape render for the Stream Deck + touch strip
function renderStripSvg(actionUUID) {
  const acct = ACCOUNTS[actionUUID];
  const entry = cache[actionUUID] || {};
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">`);
  parts.push(`<rect width="200" height="100" fill="#16161d"/>`);
  parts.push(`<text x="8" y="17" font-family="-apple-system, Helvetica" font-size="13" font-weight="700" fill="${acct.accent}">${esc(acct.label)}</text>`);

  if (entry.data && entry.data.rows.length) {
    const cd = countdown(entry.data.sessionResetsAt);
    if (cd) {
      parts.push(`<text x="192" y="17" text-anchor="end" font-family="-apple-system, Helvetica" font-size="10" fill="#6b7280">5h ${esc(cd)}${entry.error ? ' !' : ''}</text>`);
    }
    let y = 28;
    for (const row of entry.data.rows) {
      const pct = Math.max(0, Math.min(100, Math.round(row.pct)));
      const color = severityColor(pct);
      const barW = Math.max(2, Math.round((pct / 100) * 122));
      parts.push(`<text x="8" y="${y + 9}" font-family="-apple-system, Helvetica" font-size="11" font-weight="600" fill="#9ca3af">${esc(row.tag)}</text>`);
      parts.push(`<rect x="32" y="${y}" width="122" height="10" rx="5" fill="#2b2b33"/>`);
      parts.push(`<rect x="32" y="${y}" width="${barW}" height="10" rx="5" fill="${color}"/>`);
      parts.push(`<text x="192" y="${y + 9}" text-anchor="end" font-family="-apple-system, Helvetica" font-size="11" font-weight="700" fill="${color}">${pct}</text>`);
      y += 23;
    }
  } else if (entry.error === 'EXPIRED') {
    parts.push(`<text x="100" y="55" text-anchor="middle" font-family="-apple-system, Helvetica" font-size="13" font-weight="700" fill="#ef4444">TOKEN EXPIRED</text>`);
    parts.push(`<text x="100" y="74" text-anchor="middle" font-family="-apple-system, Helvetica" font-size="10" fill="#6b7280">open claude to fix</text>`);
  } else if (entry.error) {
    parts.push(`<text x="100" y="58" text-anchor="middle" font-family="-apple-system, Helvetica" font-size="12" fill="#f59e0b">retrying…</text>`);
  } else {
    parts.push(`<text x="100" y="58" text-anchor="middle" font-family="-apple-system, Helvetica" font-size="12" fill="#6b7280">loading…</text>`);
  }
  parts.push(`</svg>`);
  return parts.join('');
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
      const entry = cache[uuid];
      console.log(ACCOUNTS[uuid].label, JSON.stringify(entry.data || entry.error));
      const svgPath = path.join(__dirname, '..', 'logs', `test-${ACCOUNTS[uuid].label}.svg`);
      fs.writeFileSync(svgPath, renderSvg(uuid));
      const stripPath = path.join(__dirname, '..', 'logs', `test-strip-${ACCOUNTS[uuid].label}.svg`);
      fs.writeFileSync(stripPath, renderStripSvg(uuid));
      console.log('svg ->', svgPath, '|', stripPath);
    }
    process.exit(0);
  })();
  return;
}

const ws = new WebSocket(`ws://127.0.0.1:${args.port}`);

function send(msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function renderContext(context) {
  const info = contexts.get(context);
  if (!info) return;
  if (info.controller === 'Encoder') {
    const svg = renderStripSvg(info.action);
    send({
      event: 'setFeedback',
      context,
      payload: { canvas: 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64') },
    });
  } else {
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
  renderAll();
}

ws.on('open', () => {
  log('connected, registering', args.pluginUUID);
  send({ event: args.registerEvent, uuid: args.pluginUUID });
  setInterval(fetchAll, FETCH_INTERVAL_MS);
  setInterval(renderAll, RENDER_INTERVAL_MS);
});

ws.on('message', (buf) => {
  let ev;
  try { ev = JSON.parse(buf.toString()); } catch { return; }
  switch (ev.event) {
    case 'willAppear':
      contexts.set(ev.context, { action: ev.action, controller: ev.payload?.controller || 'Keypad' });
      renderContext(ev.context);
      if (!cache[ev.action]) fetchUsage(ev.action).then(() => renderContext(ev.context));
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
