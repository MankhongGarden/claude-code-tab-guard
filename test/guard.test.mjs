import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const GUARD = join(dirname(fileURLToPath(import.meta.url)), '..', 'guard.mjs');
const TAB_A = 'A'.repeat(32), TAB_B = 'B'.repeat(32), TAB_R1 = 'C'.repeat(32), TAB_R2 = 'D'.repeat(32);
let tabs = [];
let server, port, stateDir;

before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/json/list') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(tabs)); }
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  stateDir = mkdtempSync(join(tmpdir(), 'tab-guard-'));
});
after(() => { server.close(); rmSync(stateDir, { recursive: true, force: true }); });

function run(phase, input, extraEnv = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, TAB_GUARD_STATE_DIR: stateDir, TAB_GUARD_CDP_PORT: String(port), ...extraEnv };
    for (const k of ['CLAUDE_PID', 'CLAUDE_CODE_SESSION_ID', 'TAB_GUARD_CLI_FIRST_FILE']) if (!(k in extraEnv)) delete env[k];
    const p = spawn(process.execPath, [GUARD, phase], { env });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('exit', (code) => resolve({ code, out, json: out ? JSON.parse(out) : null }));
    p.stdin.end(JSON.stringify(input));
  });
}
const denied = (r) => r.json?.hookSpecificOutput?.permissionDecision === 'deny';
const pagesText = (lines) => [{ type: 'text', text: `## Pages\n${lines.join('\n')}` }];

test('chrome-devtools call without an own tab is denied', async () => {
  const r = await run('pre', { session_id: 's1', tool_name: 'mcp__chrome-devtools__click', tool_input: { uid: '1' } });
  assert.ok(denied(r));
  assert.match(r.json.hookSpecificOutput.permissionDecisionReason, /not opened by this chat/);
});

test('new_page makes the selected page this session\'s; others stay blocked', async () => {
  tabs = [];
  await run('pre', { session_id: 's1', tool_name: 'mcp__chrome-devtools__new_page', tool_input: { url: 'https://a.example/' } });
  await run('post', { session_id: 's1', tool_name: 'mcp__chrome-devtools__new_page', tool_input: { url: 'https://a.example/' },
    tool_response: pagesText(['1: https://other.example/', '2: https://a.example/ [selected]']) });
  assert.ok(!denied(await run('pre', { session_id: 's1', tool_name: 'mcp__chrome-devtools__click', tool_input: { pageId: 2 } })));
  assert.ok(denied(await run('pre', { session_id: 's1', tool_name: 'mcp__chrome-devtools__click', tool_input: { pageId: 1 } })));
  assert.ok(denied(await run('pre', { session_id: 's2', tool_name: 'mcp__chrome-devtools__click', tool_input: { pageId: 2 } })));
});

test('chromium-ensure targetId is owned and mapped to its page id', async () => {
  tabs = [{ id: TAB_A, type: 'page', url: 'https://b.example/x', title: 'B' }, { id: TAB_B, type: 'page', url: 'https://c.example/', title: 'C' }];
  const cmd = 'pwsh -File chromium-ensure.ps1 -Url https://b.example/x';
  await run('pre', { session_id: 's3', tool_name: 'PowerShell', tool_input: { command: cmd } });
  await run('post', { session_id: 's3', tool_name: 'PowerShell', tool_input: { command: cmd },
    tool_response: { stdout: `{"ok":true,"mode":"tab","targetId":"${TAB_A}"}` } });
  await run('post', { session_id: 's3', tool_name: 'mcp__chrome-devtools__list_pages', tool_input: {},
    tool_response: pagesText(['1: https://c.example/', '2: https://b.example/x']) });
  assert.ok(!denied(await run('pre', { session_id: 's3', tool_name: 'mcp__chrome-devtools__take_snapshot', tool_input: { pageId: 2 } })));
  assert.ok(denied(await run('pre', { session_id: 's3', tool_name: 'mcp__chrome-devtools__take_snapshot', tool_input: { pageId: 1 } })));
});

test('chromium-ensure without targetId: select_page of the pending URL claims it', async () => {
  tabs = [];
  const cmd = 'pwsh -File chromium-ensure.ps1 -Url "https://d.example/path/"';
  await run('pre', { session_id: 's4', tool_name: 'PowerShell', tool_input: { command: cmd } });
  await run('post', { session_id: 's4', tool_name: 'PowerShell', tool_input: { command: cmd }, tool_response: { stdout: '{"ok":true,"mode":"window"}' } });
  await run('post', { session_id: 's4', tool_name: 'mcp__chrome-devtools__list_pages', tool_input: {},
    tool_response: pagesText(['1: https://e.example/', '2: https://d.example/path']) });
  assert.ok(denied(await run('pre', { session_id: 's4', tool_name: 'mcp__chrome-devtools__select_page', tool_input: { pageId: 1 } })));
  assert.ok(!denied(await run('pre', { session_id: 's4', tool_name: 'mcp__chrome-devtools__select_page', tool_input: { pageId: 2 } })));
  assert.ok(!denied(await run('pre', { session_id: 's4', tool_name: 'mcp__chrome-devtools__click', tool_input: { pageId: 2 } })));
});

test('chromium-ensure without targetId: a redirected new tab on the same origin is owned', async () => {
  tabs = [{ id: 'F'.repeat(32), type: 'page', url: 'https://old.example/', title: 'old' }];
  const cmd = 'pwsh -File chromium-ensure.ps1 -Url https://r.example/settings';
  await run('pre', { session_id: 's7', tool_name: 'PowerShell', tool_input: { command: cmd } });
  tabs = [{ id: TAB_R1, type: 'page', url: 'https://r.example/new#settings', title: 'R' }];
  await run('post', { session_id: 's7', tool_name: 'PowerShell', tool_input: { command: cmd }, tool_response: { stdout: '{"ok":true,"mode":"mcp"}' } });
  await run('post', { session_id: 's7', tool_name: 'mcp__chrome-devtools__list_pages', tool_input: {},
    tool_response: pagesText(['1: https://r.example/new#settings']) });
  assert.ok(!denied(await run('pre', { session_id: 's7', tool_name: 'mcp__chrome-devtools__select_page', tool_input: { pageId: 1 } })));
  assert.ok(!denied(await run('pre', { session_id: 's7', tool_name: 'mcp__chrome-devtools__take_snapshot', tool_input: { pageId: 1 } })));
});

test('duplicate-URL tabs: allowed when all are this chat\'s, denied when one is another chat\'s', async () => {
  const dup = 'https://r.example/new#settings';
  tabs = [{ id: TAB_R1, type: 'page', url: dup, title: 'R' }, { id: TAB_R2, type: 'page', url: dup, title: 'R' }];
  const cmd = 'pwsh -File chromium-ensure.ps1 -Url https://r.example/settings';
  await run('pre', { session_id: 's7', tool_name: 'PowerShell', tool_input: { command: cmd } });
  await run('post', { session_id: 's7', tool_name: 'PowerShell', tool_input: { command: cmd }, tool_response: { stdout: `{"ok":true,"mode":"tab","targetId":"${TAB_R2}"}` } });
  await run('post', { session_id: 's7', tool_name: 'mcp__chrome-devtools__list_pages', tool_input: {}, tool_response: pagesText([`1: ${dup}`, `2: ${dup}`]) });
  assert.ok(!denied(await run('pre', { session_id: 's7', tool_name: 'mcp__chrome-devtools__take_snapshot', tool_input: { pageId: 2 } })));
  const T = '9'.repeat(32), U = '8'.repeat(32), other = 'https://dup.example/';
  tabs = [{ id: T, type: 'page', url: other, title: 'D' }, { id: U, type: 'page', url: other, title: 'D' }];
  for (const [sid, id] of [['s8', T], ['s9', U]]) {
    const c = `pwsh -File chromium-ensure.ps1 -Url ${other}`;
    await run('pre', { session_id: sid, tool_name: 'PowerShell', tool_input: { command: c } });
    await run('post', { session_id: sid, tool_name: 'PowerShell', tool_input: { command: c }, tool_response: { stdout: `{"ok":true,"mode":"tab","targetId":"${id}"}` } });
  }
  await run('post', { session_id: 's8', tool_name: 'mcp__chrome-devtools__list_pages', tool_input: {}, tool_response: pagesText([`1: ${other}`, `2: ${other}`]) });
  assert.ok(denied(await run('pre', { session_id: 's8', tool_name: 'mcp__chrome-devtools__take_snapshot', tool_input: { pageId: 1 } })));
  assert.ok(denied(await run('pre', { session_id: 's8', tool_name: 'mcp__chrome-devtools__take_snapshot', tool_input: { pageId: 2 } })));
});

test('shell CDP close of another chat\'s tab is denied, own tab allowed', async () => {
  tabs = [{ id: TAB_A, type: 'page', url: 'https://b.example/x', title: 'B' }, { id: TAB_B, type: 'page', url: 'https://c.example/', title: 'C' }];
  const bad = await run('pre', { session_id: 's3', tool_name: 'Bash', tool_input: { command: `curl http://127.0.0.1:${port}/json/close/${TAB_B}` } });
  assert.ok(denied(bad));
  const ok = await run('pre', { session_id: 's3', tool_name: 'Bash', tool_input: { command: `curl http://127.0.0.1:${port}/json/close/${TAB_A}` } });
  assert.ok(!denied(ok));
});

test('Claude cannot run claim through a shell tool', async () => {
  const r = await run('pre', { session_id: 's1', tool_name: 'PowerShell', tool_input: { command: 'node guard.mjs claim 1' } });
  assert.ok(denied(r));
});

test('deskctl web_click needs an own tab; window actions are checked against what the window shows', async () => {
  tabs = [{ id: TAB_A, type: 'page', url: 'https://b.example/x', title: 'B' }, { id: TAB_B, type: 'page', url: 'https://c.example/', title: 'C' }];
  assert.ok(denied(await run('pre', { session_id: 's3', tool_name: 'mcp__deskctl__web_click', tool_input: { tab: TAB_B.slice(0, 8) } })));
  assert.ok(!denied(await run('pre', { session_id: 's3', tool_name: 'mcp__deskctl__web_click', tool_input: { tab: TAB_A.slice(0, 8) } })));
  const wins = join(stateDir, 'wins.json');
  writeFileSync(wins, JSON.stringify([
    { spec: '0x1', hwnd: '0x1', root: '0x1', rect: [0, 0, 100, 100], title: 'B - Chromium', chromium: true, dialog: false, tabs: [TAB_A] },
    { spec: '0x2', hwnd: '0x2', root: '0x2', rect: [0, 0, 100, 100], title: 'C - Chromium', chromium: true, dialog: false, tabs: [TAB_B] },
  ]));
  const env = { TABGUARD_TEST_DESKWIN: wins };
  assert.ok(!denied(await run('pre', { session_id: 's3', tool_name: 'mcp__deskctl__click', tool_input: { window: '0x1', target: 'x' } }, env)));
  assert.ok(denied(await run('pre', { session_id: 's3', tool_name: 'mcp__deskctl__click', tool_input: { window: '0x2', target: 'x' } }, env)));
  assert.ok(denied(await run('pre', { session_id: 's3', tool_name: 'mcp__deskctl__key', tool_input: { window: '0x1', keys: 'ctrl+shift+w' } }, env)));
  assert.ok(denied(await run('pre', { session_id: 's3', tool_name: 'mcp__deskctl__click', tool_input: { target: 'x' } }, env)));
});

test('CLI-first reminder is injected only when configured', async () => {
  const f = join(stateDir, 'cli-first.txt');
  writeFileSync(f, 'Prefer a CLI or API over the browser.');
  tabs = [];
  const plain = await run('pre', { session_id: 's5', tool_name: 'mcp__chrome-devtools__new_page', tool_input: { url: 'https://x.example/' } });
  assert.equal(plain.out, '');
  const withFile = await run('pre', { session_id: 's6', tool_name: 'mcp__chrome-devtools__new_page', tool_input: { url: 'https://x.example/' } }, { TAB_GUARD_CLI_FIRST_FILE: f });
  assert.match(withFile.json.hookSpecificOutput.additionalContext, /Prefer a CLI/);
});
