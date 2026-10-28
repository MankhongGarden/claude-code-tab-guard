import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const STATE_DIR = process.env.TAB_GUARD_STATE_DIR || join(CONFIG_DIR, 'tab-guard');
const PORT = String(Number(process.env.TAB_GUARD_CDP_PORT) || 9222);
const CDP_LIST = `http://127.0.0.1:${PORT}/json/list`;
const PENDING_TTL_MS = 10 * 60000;
const CLI_FIRST_MS = 20 * 60000;
const FREE_TOOLS = new Set(['list_pages', 'new_page']);
const DESK_TAB_TOOLS = new Set(['mcp__deskctl__web_click', 'mcp__deskctl__web_point', 'mcp__deskctl__browser_close']);
const DESK_WIN_TOOLS = new Set(['snapshot', 'click', 'key', 'type_text', 'act', 'scroll', 'wait_for', 'screenshot', 'read_text', 'window', 'dialog']);
const DESK_PY = process.env.TAB_GUARD_DESKCTL_PYTHON
  || (process.env.TAB_GUARD_DESKCTL_DIR ? join(process.env.TAB_GUARD_DESKCTL_DIR, '.venv', 'Scripts', 'python.exe') : 'python');
const DESKWIN = join(HERE, 'deskwin.py');
const GUARD = join(HERE, 'guard.mjs');
const ENSURE = join(HERE, 'chromium', 'chromium-ensure.ps1');
const CLOSES_WINDOW = /(^|\+)(alt\+f4|ctrl\+shift\+w|ctrl\+shift\+q)$/i;
const CLAIM_CMD = /guard\.mjs["']?\s+claim\b/i;
const CDP_SHELL = new RegExp(`cdp\\.py["']?\\s+(?:goto|shot|mouse|type|evalf?|close)\\s+["']?([0-9A-Fa-f]{6,})|${PORT}\\/json\\/(?:close|activate)\\/([0-9A-Fa-f]{6,})`, 'gi');
const CDP_SHELL_ANY = new RegExp(`cdp\\.py|${PORT}\\/json\\/(close|activate)`, 'i');
const SHELL_NEW = new RegExp(`cdp\\.py["']?\\s+new\\b|${PORT}\\/json\\/new`, 'i');
const CLI_FIRST = (() => {
  const f = process.env.TAB_GUARD_CLI_FIRST_FILE;
  if (!f) return '';
  try { return readFileSync(f, 'utf8').trim(); } catch { return ''; }
})();
const HOWTO = [
  `Each chat may only touch tabs it opened itself: pwsh -File "${ENSURE}" -Profile <p> -Url <url>, then list_pages + select_page (main route, lands in the right profile) · deskctl browser_open · cdp.py new · new_page (may land in another profile).`,
  'Normal fix: open your own tab and work in it (chrome-devtools: pass pageId · deskctl: pass tab=<8-char id>).',
  `If the user really wants you to use that tab: ask the user to type \`! node "${GUARD}" claim <pageId or tab id>\` themselves (Claude cannot run claim).`,
].join('\n');

const phase = process.argv[2];
let sid = 'nosession';
let s = null;
let tool = '';

function stateFile(id) { return join(STATE_DIR, `${id}.json`); }
function load(id) {
  let v = {};
  try { v = JSON.parse(readFileSync(stateFile(id), 'utf8')); } catch {}
  return { owned: [], selected: null, pages: {}, pending: [], targets: [], snap: null, ...v };
}
function save() {
  try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(stateFile(sid), JSON.stringify(s)); } catch {}
}
function log(line) {
  try { mkdirSync(STATE_DIR, { recursive: true }); appendFileSync(join(STATE_DIR, 'guard.log'), `${new Date().toISOString()} ${sid.slice(0, 8)} ${line}\n`); } catch {}
}
async function cdpTabs() {
  try {
    const r = await fetch(CDP_LIST, { signal: AbortSignal.timeout(1500) });
    return (await r.json()).filter(t => t.type === 'page');
  } catch { return null; }
}
const OWNERS = join(STATE_DIR, 'owners.json');
function loadOwners() { try { return JSON.parse(readFileSync(OWNERS, 'utf8')); } catch { return {}; } }
function own(targetId, via, exact = true) {
  if (!targetId) return;
  const owners = loadOwners();
  const prev = owners[targetId];
  if (prev && prev !== sid) {
    if (!exact) { log(`skip tab ${targetId.slice(0, 8)} via ${via} (owned by ${prev.slice(0, 8)})`); return; }
    try {
      const other = load(prev);
      other.targets = other.targets.filter(id => id !== targetId);
      writeFileSync(stateFile(prev), JSON.stringify(other));
      log(`take tab ${targetId.slice(0, 8)} from ${prev.slice(0, 8)} (exact ${via} wins over diff)`);
    } catch {}
  }
  owners[targetId] = sid;
  try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(OWNERS, JSON.stringify(owners)); } catch {}
  if (!s.targets.includes(targetId)) { s.targets.push(targetId); log(`own tab ${targetId.slice(0, 8)} via ${via}`); }
}
function pruneOwners(live) {
  if (!live) return;
  const owners = loadOwners();
  let changed = false;
  for (const id of Object.keys(owners)) if (!live.some(t => t.id === id)) { delete owners[id]; changed = true; }
  if (changed) try { writeFileSync(OWNERS, JSON.stringify(owners)); } catch {}
}
function responseText(r) {
  if (r == null) return '';
  if (typeof r === 'string') return r;
  if (Array.isArray(r)) return r.map(responseText).join('\n');
  if (typeof r === 'object') {
    if (typeof r.text === 'string') return r.text;
    if (r.content) return responseText(r.content);
    if (typeof r.stdout === 'string') return r.stdout;
    return Object.values(r).map(responseText).join('\n');
  }
  return String(r);
}
function parsePages(text) {
  const pages = {};
  let selected = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(\d+): (.*?)(?: \[selected\])?\s*$/);
    if (!m) continue;
    const id = Number(m[1]);
    const u = m[2].match(/\(([^()\s]+)\)$/);
    pages[id] = u ? u[1] : m[2];
    if (/\[selected\]\s*$/.test(line)) selected = id;
  }
  return Object.keys(pages).length ? { pages, selected } : null;
}
function sameOrigin(a, b) {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}
function sameTarget(pageUrl, wanted) {
  try {
    const a = new URL(pageUrl), b = new URL(wanted);
    return a.origin === b.origin && a.pathname.replace(/\/+$/, '') === b.pathname.replace(/\/+$/, '');
  } catch { return false; }
}
function resolveDeskTab(spec, tabs) {
  if (!spec) return { err: 'no tab given (deskctl would pick the front tab, which may belong to another chat) · pass tab=<8-char id from browser_tabs>' };
  const q = spec.toLowerCase();
  const byId = tabs.filter(t => t.id.toLowerCase().startsWith(q));
  if (byId.length) return { tab: byId[0] };
  const hits = tabs.filter(t => t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q));
  if (hits.length === 1) return { tab: hits[0] };
  return { err: hits.length ? `tab "${spec}" matches several tabs` : `no tab matches "${spec}"` };
}
function deskWindows(specs) {
  if (process.env.TABGUARD_TEST_DESKWIN) {
    try { const all = JSON.parse(readFileSync(process.env.TABGUARD_TEST_DESKWIN, 'utf8')); return all.filter(w => specs.includes(w.spec)); } catch { return null; }
  }
  const r = spawnSync(DESK_PY, ['-I', DESKWIN, JSON.stringify(specs)], { encoding: 'utf8', timeout: 6000, windowsHide: true, env: { ...process.env, TAB_GUARD_CDP_PORT: PORT } });
  try { return JSON.parse(r.stdout); } catch { return null; }
}
function deskTargets(name, ti) {
  const wins = [], tabs = [];
  const add = (op, a) => {
    if (op === 'web_click') return tabs.push(String(a.tab || ''));
    if (['launch', 'sleep'].includes(op)) return;
    if (op === 'dialog' && !a.window) return;
    if (op !== 'dialog' && !DESK_WIN_TOOLS.has(op) && !['select', 'toggle', 'choose', 'set_value', 'type', 'expect'].includes(op)) return;
    const pt = Array.isArray(a.screen_xy) && a.screen_xy.length === 2 ? a.screen_xy.map(Number) : null;
    wins.push({ spec: String(a.window || 'foreground'), op, winOp: String(a.winOp || ''), keys: String(a.keys || ''), point: pt });
  };
  if (name === 'batch') for (const st of ti?.steps || []) add(st.op, { ...st, winOp: st.op === 'window' ? 'close' : '' });
  else add(name, { ...(ti || {}), winOp: name === 'window' ? ti?.op : '' });
  return { wins, tabs };
}
function out(obj) { process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...obj } })); }
function deny(reason) { out({ permissionDecision: 'deny', permissionDecisionReason: reason }); process.exit(0); }
function allow(cliFirst) {
  if (cliFirst && CLI_FIRST && Date.now() - (s.cliFirstAt || 0) > CLI_FIRST_MS) {
    s.cliFirstAt = Date.now();
    save();
    out({ additionalContext: CLI_FIRST });
  }
  process.exit(0);
}
function mine() { return s.targets.map(id => id.slice(0, 8)).join(', ') || 'none yet'; }

async function claimMain() {
  sid = String(process.env.CLAUDE_CODE_SESSION_ID || '').replace(/[^\w-]/g, '');
  if (phase === 'whoami') { console.log(`session=${sid || '(CLAUDE_CODE_SESSION_ID not set)'} claude_pid=${process.env.CLAUDE_PID || '-'}`); return; }
  const spec = String(process.argv[3] || '');
  if (!sid || !spec) { console.log(`usage: ! node "${GUARD}" claim <pageId or tab id> (type it in the chat that should get the tab)`); process.exit(1); }
  s = load(sid);
  const live = (await cdpTabs()) || [];
  if (/^\d+$/.test(spec)) {
    const id = Number(spec);
    if (!s.owned.includes(id)) s.owned.push(id);
    const same = live.filter(t => t.url === s.pages[id]);
    if (same.length === 1) own(same[0].id, 'user claim');
    log(`user claim page ${id}`);
    console.log(`claimed: page ${id} (${s.pages[id] || 'URL not known yet'})${same.length === 1 ? ` = tab ${same[0].id.slice(0, 8)}` : ''}`);
  } else {
    const t = live.find(x => x.id.toLowerCase().startsWith(spec.toLowerCase()));
    if (!t) { console.log(`no tab ${spec}`); process.exit(1); }
    own(t.id, 'user claim');
    console.log(`claimed: tab ${t.id.slice(0, 8)} "${t.title}"`);
  }
  save();
}

async function hookMain() {
  let input;
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
  tool = input.tool_name || '';
  const cmd = String(input.tool_input?.command || '');
  sid = String(input.session_id || 'nosession').replace(/[^\w-]/g, '');
  if (existsSync(join(STATE_DIR, 'debug'))) log(`invoke ${phase} ${tool} ${cmd.slice(0, 60)}`);
  s = load(sid);

  const isShell = tool === 'PowerShell' || tool === 'Bash';
  const isDevtools = tool.startsWith('mcp__chrome-devtools__');
  const short = tool.replace('mcp__chrome-devtools__', '');
  const ensureCmd = isShell && /chromium-ensure/i.test(cmd);
  const opensTab = tool === 'mcp__chrome-devtools__new_page' || tool === 'mcp__deskctl__browser_open'
    || (isShell && (/chromium-ensure/i.test(cmd) || SHELL_NEW.test(cmd)));
  const cliFirstTool = ensureCmd || /^mcp__chrome-devtools__(new_page|navigate_page)$|^mcp__deskctl__browser_open$/.test(tool);

  function resetPages(why) {
    if (!s.owned.length && !Object.keys(s.pages).length) return;
    log(`page ids reset (${why}) · drop ${s.owned.join(',') || '-'} · remap by tab id`);
    s.owned = []; s.pages = {}; s.selected = null; s.maxSeen = 0;
  }
  async function remapOwned() {
    if (!s.targets.length && !s.owned.length) return;
    const live = await cdpTabs();
    if (!live) return;
    s.targets = s.targets.filter(id => live.some(t => t.id === id));
    for (const tid of s.targets) {
      const t = live.find(x => x.id === tid);
      if (!t) continue;
      const ids = Object.keys(s.pages).filter(k => s.pages[k] === t.url).map(Number);
      const sameLive = live.filter(x => x.url === t.url);
      if (!ids.length || ids.length !== sameLive.length || !sameLive.every(x => s.targets.includes(x.id))) continue;
      for (const id of ids) if (!s.owned.includes(id)) { s.owned.push(id); log(`map tab ${tid.slice(0, 8)} -> page ${id}`); }
    }
    const mineUrls = new Set(s.targets.map(id => live.find(t => t.id === id)?.url));
    for (const pid of s.owned) {
      const url = s.pages[pid];
      if (!url || mineUrls.has(url)) continue;
      const same = live.filter(t => t.url === url);
      if (same.length === 1) { own(same[0].id, `bind page ${pid}`, false); mineUrls.add(url); }
    }
  }

  if (isDevtools) {
    if (!process.env.CLAUDE_PID && !s.warnedNoPid) { log('no CLAUDE_PID in hook env · restart detection = page-id fallback only'); s.warnedNoPid = true; }
    try {
      const stamp = readFileSync(join(STATE_DIR, 'mcp', `${process.env.CLAUDE_PID}-chrome-devtools-mcp.txt`), 'utf8').trim();
      if (s.mcpStamp && s.mcpStamp !== stamp) resetPages('chrome-devtools MCP restarted');
      s.mcpStamp = stamp;
    } catch {}
  }

  if (phase === 'post') {
    const txt = responseText(input.tool_response);
    if (opensTab) {
      let exact = null;
      if (tool === 'mcp__deskctl__browser_open') {
        const m = txt.match(/"tab"\s*:\s*"([0-9A-Fa-f]{6,})"/);
        const live = m ? await cdpTabs() : null;
        exact = live?.find(t => t.id.toUpperCase().startsWith(m[1].toUpperCase()))?.id || null;
      } else if (SHELL_NEW.test(cmd)) {
        exact = (txt.match(/\b([0-9A-F]{32})\b/) || [])[1] || null;
      } else if (ensureCmd) {
        exact = (txt.match(/"targetId"\s*:\s*"([0-9A-Fa-f]{32})"/) || [])[1]?.toUpperCase() || null;
      }
      if (exact) own(exact, tool === 'mcp__deskctl__browser_open' ? 'browser_open' : ensureCmd ? 'chromium-ensure' : 'shell new');
      else if (s.snap) {
        let now = await cdpTabs();
        for (let i = 0; ensureCmd && i < 3 && (!now || now.every(t => s.snap.ids.includes(t.id))); i++) {
          await new Promise(r => setTimeout(r, 1000));
          now = await cdpTabs();
        }
        if (now) {
          pruneOwners(now);
          const owners = loadOwners();
          const fresh = now.filter(t => !s.snap.ids.includes(t.id) && (!owners[t.id] || owners[t.id] === sid));
          const want = input.tool_input?.url || (cmd.match(/-Url\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i) || []).slice(1).find(Boolean);
          let chosen = want ? fresh.filter(t => sameTarget(t.url, want) || t.url === want) : [];
          if (!chosen.length && want) {
            const redirected = fresh.filter(t => sameOrigin(t.url, want));
            if (redirected.length === 1) { chosen = redirected; log(`new tab ${redirected[0].id.slice(0, 8)} redirected ${want} -> ${redirected[0].url}`); }
          }
          if (!chosen.length && fresh.length) log(`${fresh.length} new tab(s) after ${tool.split('__').pop()} but none match ${want ? 'the URL' : '(no -Url)'} · own none`);
          for (const t of chosen) own(t.id, `${tool.split('__').pop()} (diff)`, false);
        }
      }
      s.snap = null;
    }
    if (isDevtools) {
      if (/page ids have changed/i.test(txt)) resetPages('devtools: page ids have changed');
      const parsed = parsePages(txt);
      if (parsed) {
        const maxNew = Math.max(...Object.keys(parsed.pages).map(Number));
        const kept = Object.keys(parsed.pages).filter(k => s.pages[k] && s.pages[k] === parsed.pages[k]).length;
        if (s.maxSeen && maxNew < s.maxSeen && short !== 'close_page' && !kept) resetPages(`page ids went back ${s.maxSeen} -> ${maxNew}`);
        else if (s.maxSeen && maxNew < s.maxSeen && kept) log(`max page id ${s.maxSeen} -> ${maxNew} but ${kept} page(s) kept their URL · tabs closed elsewhere, not a reset`);
        s.maxSeen = Math.max(s.maxSeen || 0, maxNew);
        s.pages = parsed.pages;
        await remapOwned();
        if (parsed.selected != null) s.selected = parsed.selected;
        if (short === 'new_page' && parsed.selected != null && !s.owned.includes(parsed.selected)) {
          s.owned.push(parsed.selected);
          log(`own ${parsed.selected} via new_page`);
        }
        s.owned = s.owned.filter(id => id in s.pages);
      }
    } else if (ensureCmd) {
      const m = cmd.match(/-Url\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
      const url = m && (m[1] || m[2] || m[3]);
      if (url) { s.pending.push({ url, ts: Date.now() }); log(`pending ${url}`); }
    }
    save();
    process.exit(0);
  }

  if (isShell && CLAIM_CMD.test(cmd)) {
    log('deny claim by Claude');
    deny(`TAB-GUARD: Claude cannot run the claim command itself · if the user wants you to use that tab, ask them to type \`! node "${GUARD}" claim <pageId or tab id>\` themselves`);
  }

  if (isShell && CDP_SHELL_ANY.test(cmd)) {
    const ids = [...cmd.matchAll(CDP_SHELL)].map(m => (m[1] || m[2]).toUpperCase());
    const all = await cdpTabs();
    if (all) s.targets = s.targets.filter(id => all.some(t => t.id === id));
    const bad = ids.filter(id => !s.targets.some(t => t.startsWith(id)));
    if (bad.length) {
      save();
      log(`deny shell-cdp ${bad.map(id => id.slice(0, 8)).join(',')}`);
      deny([
        `TAB-GUARD: this command touches tab ${bad.map(id => { const t = (all || []).find(x => x.id.startsWith(id)); return `${id.slice(0, 8)}${t ? ` "${t.title}"` : ''}`; }).join(', ')}, which this chat did not open (this chat's tabs: ${mine()})`,
        'Shell CDP commands may only target tabs this chat opened · open a tab (`cdp.py new` or /json/new) in one command, then use its id in a separate command',
        HOWTO,
      ].join('\n'));
    }
  }

  if (opensTab) {
    const now = await cdpTabs();
    if (now) s.snap = { ids: now.map(t => t.id), ts: Date.now() };
    save();
    allow(cliFirstTool);
  }

  if (tool.startsWith('mcp__deskctl__') && !DESK_TAB_TOOLS.has(tool)) {
    const { wins, tabs: tabSpecs } = deskTargets(tool.replace('mcp__deskctl__', ''), input.tool_input);
    if (!wins.length && !tabSpecs.length) process.exit(0);
    const problems = [];
    const all = await cdpTabs();
    if (all) { s.targets = s.targets.filter(id => all.some(t => t.id === id)); save(); }
    for (const spec of tabSpecs) {
      if (!all) break;
      const r = resolveDeskTab(spec, all);
      if (r.err) problems.push(`web_click in batch: ${r.err}`);
      else if (!s.targets.includes(r.tab.id)) problems.push(`web_click in batch: tab ${r.tab.id.slice(0, 8)} "${r.tab.title}" is not this chat's`);
    }
    if (wins.length) {
      const specs = [...new Set(wins.flatMap(w => [w.spec, ...(w.point ? [`point:${w.point[0]},${w.point[1]}`] : [])]))];
      const res = deskWindows(specs);
      if (!res) deny(`TAB-GUARD: the window helper (deskwin.py) did not answer · denied to be safe (fail-closed) · try again; if it keeps failing, tell the user\n${HOWTO}`);
      const info = new Map(res.map(w => [w.spec, w]));
      const checkTabs = (w, label) => {
        if (!w.tabs.length) problems.push(`Chromium window "${w.title}" (${label}): cannot tell which tab it shows`);
        for (const id of w.tabs) if (!s.targets.includes(id)) problems.push(`window "${w.title}" (${label}) shows tab ${id.slice(0, 8)}, which is not this chat's`);
      };
      for (const it of wins) {
        const w = info.get(it.spec);
        if (/^(foreground)?$/i.test(it.spec.trim())) {
          problems.push(`${it.op} uses window=foreground (the front window can change between this check and the action) · name the window, e.g. window="${w?.hwnd || '0x...'}"${w?.title ? ` (the front window now is "${w.title}")` : ''}`);
          continue;
        }
        if (it.point && w && !w.error) {
          const [x, y] = it.point, [l, t, r, b] = w.rect || [0, 0, 0, 0];
          const inside = x >= l && x < r && y >= t && y < b;
          const pw = inside ? null : info.get(`point:${x},${y}`);
          if (pw && !pw.error && pw.root !== w.root && pw.chromium && !pw.dialog) checkTabs(pw, `screen_xy=[${x},${y}] is outside window ${it.spec} and lands on Chromium`);
        }
        if (!w || w.error || !w.chromium || w.dialog) continue;
        if (it.op === 'window' && /close/i.test(it.winOp)) {
          problems.push(`do not close a whole Chromium window ("${w.title}"; it may hold other chats' background tabs) · close only your own tab with close_page or browser_close`);
          continue;
        }
        if (it.op === 'key' && CLOSES_WINDOW.test(it.keys.replace(/\s+/g, ''))) {
          problems.push(`do not press ${it.keys} in a Chromium window (closes the whole window or browser) · close only your own tab with close_page or browser_close`);
          continue;
        }
        checkTabs(w, `window=${w.spec}`);
      }
    }
    if (!problems.length) process.exit(0);
    log(`deny ${tool.split('__').pop()} ${problems[0].slice(0, 120)}`);
    deny([
      `TAB-GUARD: ${[...new Set(problems)].join(' · ')} (this chat's deskctl tabs: ${mine()})`,
      'deskctl actions on a Chromium window are allowed only while that window shows one of this chat\'s tabs · find the hwnd with list_open_windows or the attention field of an earlier result',
      HOWTO,
    ].join('\n'));
  }

  if (DESK_TAB_TOOLS.has(tool)) {
    const tabs = await cdpTabs();
    if (!tabs) process.exit(0);
    s.targets = s.targets.filter(id => tabs.some(t => t.id === id));
    const r = resolveDeskTab(String(input.tool_input?.tab || ''), tabs);
    if (r.tab && s.targets.includes(r.tab.id)) {
      if (tool === 'mcp__deskctl__browser_close') s.targets = s.targets.filter(id => id !== r.tab.id);
      save();
      process.exit(0);
    }
    save();
    log(`deny ${tool.split('__').pop()} tab=${r.tab ? r.tab.id.slice(0, 8) : input.tool_input?.tab || '(none)'}`);
    deny([`TAB-GUARD: ${r.err || `tab ${r.tab.id.slice(0, 8)} "${r.tab.title}" was not opened by this chat`} (this chat's deskctl tabs: ${mine()})`, HOWTO].join('\n'));
  }

  if (!isDevtools || FREE_TOOLS.has(short)) { save(); process.exit(0); }

  s.pending = s.pending.filter(p => Date.now() - p.ts < PENDING_TTL_MS);
  const target = input.tool_input?.pageId ?? (short === 'select_page' ? null : s.selected);

  if (target != null && s.owned.includes(target)) {
    if (short === 'close_page') s.owned = s.owned.filter(id => id !== target);
    save();
    allow(cliFirstTool);
  }

  if (short === 'select_page' && target != null) {
    const url = s.pages[target];
    const i = url ? s.pending.findIndex(p => sameTarget(url, p.url)) : -1;
    if (i >= 0) {
      s.owned.push(target);
      s.pending.splice(i, 1);
      save();
      log(`own ${target} via chromium-ensure ${url}`);
      process.exit(0);
    }
  }

  if (target != null && s.pages[target] && s.targets.length) {
    const live = await cdpTabs();
    const same = (live || []).filter(t => t.url === s.pages[target]);
    if (same.length && same.every(t => s.targets.includes(t.id))) {
      s.owned.push(target);
      if (short === 'close_page') s.owned = s.owned.filter(id => id !== target);
      save();
      log(`own ${target} via tab id ${same[0].id.slice(0, 8)} (live url ${s.pages[target]})`);
      allow(cliFirstTool);
    }
  }

  save();
  const where = target == null ? 'the selected tab (this chat has not opened a tab of its own yet)' : `tab ${target} (${s.pages[target] || 'URL unknown · run list_pages first'})`;
  log(`deny ${short} target=${target ?? 'selected'}`);
  deny([`TAB-GUARD: ${where} was not opened by this chat (this chat's tabs: ${s.owned.join(', ') || 'none yet'})`, HOWTO].join('\n'));
}

if (phase === 'claim' || phase === 'whoami') {
  await claimMain();
} else {
  try {
    await hookMain();
  } catch (e) {
    log(`ERROR ${tool} ${e?.stack?.split('\n')[0] || e}`);
    if (phase === 'pre') deny(`TAB-GUARD internal error (${e?.message || e}) · denied to be safe (fail-closed) · try again; if it keeps failing, tell the user to check ${join(STATE_DIR, 'guard.log')}`);
  }
}
