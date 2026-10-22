const PORT = Number(process.env.TAB_GUARD_CDP_PORT) || 9222;
const [cmd, ...rest] = process.argv.slice(2);

async function browserWs() {
  const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
  let n = 0;
  const waiting = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); }
  };
  const send = (method, params = {}, sessionId) => new Promise((ok) => {
    const id = ++n;
    waiting.set(id, ok);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return { ws, send };
}

async function evalIn(send, targetId, expression) {
  const a = await send('Target.attachToTarget', { targetId, flatten: true });
  const sessionId = a.result.sessionId;
  for (let i = 0; i < 20; i++) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    const v = r.result?.result?.value;
    if (v !== undefined && v !== null && v !== '') return v;
    await new Promise((s) => setTimeout(s, 250));
  }
  return null;
}

const IDLE = /^(about:blank|chrome:\/\/|chrome-search:\/\/|chrome-untrusted:\/\/|devtools:\/\/|chrome-extension:\/\/)/;

async function probe() {
  const { ws, send } = await browserWs();
  const t = await send('Target.createTarget', { url: 'chrome://version', background: true });
  const targetId = t.result.targetId;
  const profilePath = await evalIn(send, targetId, "document.querySelector('#profile_path')?.innerText");
  const all = (await send('Target.getTargets')).result.targetInfos;
  const mine = all.find((x) => x.targetId === targetId);
  await send('Target.closeTarget', { targetId });
  const pages = all.filter((x) => x.type === 'page' && x.targetId !== targetId).map((x) => ({
    id: x.targetId, url: x.url, sameProfileAsNewPage: x.browserContextId === mine.browserContextId, idle: IDLE.test(x.url),
  }));
  ws.close();
  return { profileDir: profilePath ? profilePath.split(/[\\/]/).pop() : null, pages };
}

async function open(profileDir, url) {
  const { ws, send } = await browserWs();
  const all = (await send('Target.getTargets')).result.targetInfos;
  const contexts = [...new Set(all.filter((x) => x.type === 'page').map((x) => x.browserContextId))];
  for (const browserContextId of contexts) {
    const t = await send('Target.createTarget', { url: 'chrome://version', background: true, browserContextId });
    const targetId = t.result?.targetId;
    if (!targetId) continue;
    const p = await evalIn(send, targetId, "document.querySelector('#profile_path')?.innerText");
    await send('Target.closeTarget', { targetId });
    if (p && p.split(/[\\/]/).pop() === profileDir) {
      const n = await send('Target.createTarget', { url, background: true, browserContextId });
      ws.close();
      return { opened: !!n.result?.targetId, targetId: n.result?.targetId, profileDir, url };
    }
  }
  ws.close();
  return { opened: false, profileDir, reason: 'no open window of this profile' };
}

async function main() {
  if (cmd === 'probe') return probe();
  if (cmd === 'open') return open(rest[0], rest[1]);
  if (cmd === 'close') { const { send } = await browserWs(); send('Browser.close'); await new Promise((s) => setTimeout(s, 500)); return { closed: true }; }
  if (cmd === 'eval') {
    const [targetId, expression] = rest;
    const { ws, send } = await browserWs();
    const v = await evalIn(send, targetId, expression);
    ws.close();
    return { value: v };
  }
  if (cmd === 'find') {
    const [pattern] = rest;
    const { ws, send } = await browserWs();
    const all = (await send('Target.getTargets')).result.targetInfos;
    ws.close();
    return all.filter((x) => x.type === 'page' && x.url.includes(pattern)).map((x) => ({ id: x.targetId, url: x.url, title: x.title }));
  }
  throw new Error('usage: probe | close | open <profileDir> <url> | find <url-part> | eval <targetId> <js-expression>');
}

main().then((r) => { console.log(JSON.stringify(r)); process.exit(0); }, (e) => { console.log(JSON.stringify({ error: String(e.message || e) })); process.exit(1); });
