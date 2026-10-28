# claude-code-tab-guard

**A Claude Code hook that lets several sessions share one Chromium (one CDP port, one `chrome-devtools-mcp` setup) without touching each other's tabs.**
Each session may act only on tabs it opened itself. Anything else is denied with a message that tells the agent how to open its own tab.

> [!WARNING]
> **Experimental.** Built and used daily by one person on one Windows 11 machine since 2026-10-07. Tested on Claude Code 2.1.308, Node.js 22.22, PowerShell 7 and Windows 11 (2026-10-22). It parses the text output of `chrome-devtools-mcp`'s `list_pages`, which is not a stable API, so expect breakage after updates of that server. The Chromium helper scripts are Windows-only. Not published to npm.

**TL;DR**
- If you run several Claude Code sessions in parallel and they all drive the same browser through [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) on one debug port, they share one list of tabs. `click`, `navigate_page` or `close_page` acts on whatever page is "selected", and another session may have selected it a second ago. Sessions end up navigating, typing into, or closing each other's tabs.
- `guard.mjs` is a `PreToolUse` + `PostToolUse` hook. The post hook records which tabs each session opened (by CDP target id and by page id). The pre hook denies any browser tool call aimed at a tab the session does not own.
- `chromium/chromium-ensure.ps1` opens a tab in a chosen Chromium profile over CDP and prints its `targetId`, so the hook can assign ownership exactly instead of guessing.
- One person can hand a tab to a session with `! node guard.mjs claim <id>`. The agent itself cannot run `claim`; the hook denies it.
- Fails closed: if the hook crashes in the pre phase, the call is denied.

---

## The problem

One browser for all sessions is convenient: one set of logins, one window to watch, one `--remote-debugging-port`. But `chrome-devtools-mcp` keeps a per-server notion of the "selected page", page ids are small integers that change when the server restarts, and every MCP instance sees every tab in the browser. With three sessions running, these all happened here:

1. Session A called `navigate_page` without `pageId` and navigated the tab session B had just selected.
2. A session called `close_page` on a tab another session was filling in.
3. After an MCP server restart, page ids were renumbered, and a session's remembered "page 3" now pointed at someone else's tab.
4. `new_page` opened in whichever browser profile was used last, so a session meant to work in profile X ended up logged in as profile Y.

A rule in `CLAUDE.md` ("only touch your own tabs") is advice the agent may forget; a hook is enforced on every call.

---

## Install

Requirements: Windows 10/11 for the Chromium scripts (the hook itself is plain Node), Node.js 22+ (the CDP helper uses the global `WebSocket`), PowerShell 7, a Chromium build (for example `winget install Hibbiki.Chromium`), and `chrome-devtools-mcp` attached to it with `--browserUrl http://127.0.0.1:9222`.

```powershell
git clone https://github.com/MankhongGarden/claude-code-tab-guard C:\tools\claude-code-tab-guard
```

Add the hooks to your user `settings.json` (`%USERPROFILE%\.claude\settings.json`, or `$CLAUDE_CONFIG_DIR\settings.json`). Replace `C:\\tools\\claude-code-tab-guard` with your clone:

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "mcp__chrome-devtools__.*|mcp__deskctl__.*",
        "hooks": [ { "type": "command", "command": "node \"C:\\tools\\claude-code-tab-guard\\guard.mjs\" pre", "timeout": 10 } ] },
      { "matcher": "PowerShell",
        "hooks": [
          { "type": "command", "command": "node \"C:\\tools\\claude-code-tab-guard\\guard.mjs\" pre", "if": "PowerShell(*chromium-ensure*)", "timeout": 10 },
          { "type": "command", "command": "node \"C:\\tools\\claude-code-tab-guard\\guard.mjs\" pre", "if": "PowerShell(*9222*)", "timeout": 10 },
          { "type": "command", "command": "node \"C:\\tools\\claude-code-tab-guard\\guard.mjs\" pre", "if": "PowerShell(*guard.mjs*claim*)", "timeout": 10 }
        ] },
      { "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "node \"C:\\tools\\claude-code-tab-guard\\guard.mjs\" pre", "if": "Bash(*chromium-ensure*)", "timeout": 10 },
          { "type": "command", "command": "node \"C:\\tools\\claude-code-tab-guard\\guard.mjs\" pre", "if": "Bash(*9222*)", "timeout": 10 },
          { "type": "command", "command": "node \"C:\\tools\\claude-code-tab-guard\\guard.mjs\" pre", "if": "Bash(*guard.mjs*claim*)", "timeout": 10 }
        ] }
    ],
    "PostToolUse": [
      { "matcher": "mcp__chrome-devtools__.*|mcp__deskctl__browser_open",
        "hooks": [ { "type": "command", "command": "node \"C:\\tools\\claude-code-tab-guard\\guard.mjs\" post", "timeout": 5 } ] },
      { "matcher": "PowerShell",
        "hooks": [
          { "type": "command", "command": "node \"C:\\tools\\claude-code-tab-guard\\guard.mjs\" post", "if": "PowerShell(*chromium-ensure*)", "timeout": 5 },
          { "type": "command", "command": "node \"C:\\tools\\claude-code-tab-guard\\guard.mjs\" post", "if": "PowerShell(*9222*)", "timeout": 5 }
        ] },
      { "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "node \"C:\\tools\\claude-code-tab-guard\\guard.mjs\" post", "if": "Bash(*chromium-ensure*)", "timeout": 5 },
          { "type": "command", "command": "node \"C:\\tools\\claude-code-tab-guard\\guard.mjs\" post", "if": "Bash(*9222*)", "timeout": 5 }
        ] }
    ]
  }
}
```

The `if` conditions keep the hook from starting a Node process on every shell command; only commands that mention the helper script, the CDP port or `claim` are checked. If you change the port, change `9222` in the `if` patterns too. If you use a CDP command-line helper named `cdp.py`, add `*cdp.py*` patterns as well (the hook understands `cdp.py new|goto|shot|mouse|type|eval|close <tab id>`).

Then tell your agent how to open tabs, for example in `CLAUDE.md`:

```markdown
Before using chrome-devtools, open your own tab:
pwsh -NoProfile -File C:\tools\claude-code-tab-guard\chromium\chromium-ensure.ps1 -Profile <profile folder, email, or part before @> -Url <url>
then list_pages + select_page, and pass pageId on every call. Never use new_page. Never close or navigate a tab you did not open.
```

### Optional: detect `chrome-devtools-mcp` restarts exactly

When the MCP server restarts, page ids are renumbered. The hook notices this from the `list_pages` output (ids going backwards, or the server saying "page ids have changed"). If you start `chrome-devtools-mcp` through [mcp-fast-launch](https://github.com/MankhongGarden/mcp-fast-launch), the launcher can also write a per-session stamp the hook reads. Add to the MCP entry:

```json
"env": { "MCP_LAUNCH_STAMP_DIR": "C:\\Users\\you\\.claude\\tab-guard\\mcp" }
```

(the `mcp` folder inside the hook's state folder).

### Configuration (environment variables)

| Variable | Default | Used by | Meaning |
|---|---|---|---|
| `TAB_GUARD_STATE_DIR` | `$CLAUDE_CONFIG_DIR/tab-guard`, else `~/.claude/tab-guard` | hook | Per-session state, `owners.json`, `guard.log`. Create a file named `debug` here to log every invocation |
| `TAB_GUARD_CDP_PORT` | `9222` | all | Chromium remote-debugging port |
| `TAB_GUARD_CLI_FIRST_FILE` | unset | hook | Text file injected as context (at most every 20 min) when a session opens or navigates a tab. Use it to remind the agent to prefer a CLI or API. See `cli-first.example.txt` |
| `CHROMIUM_EXE` | `%LOCALAPPDATA%\Chromium\Application\chrome.exe` | scripts | Chromium binary |
| `CHROMIUM_USER_DATA_DIR` | `$CLAUDE_CONFIG_DIR/chromium-data`, else `~/.claude/chromium-data` | scripts | Chromium user-data folder used only by the agent. Keep it separate from your daily browser |
| `CHROMIUM_WINGET_ID` | unset | launcher | If set (e.g. `Hibbiki.Chromium`), `chromium-launch.ps1` runs `winget upgrade` at most every 20 h, only while that Chromium is closed |
| `TAB_GUARD_DESKCTL_DIR`, `TAB_GUARD_DESKCTL_PYTHON` | unset, `python` | hook | Only for the optional deskctl support below |

Hooks inherit Claude Code's environment, so set these as user environment variables or in the `env` block of `settings.json`.

---

## How it works

```
 PreToolUse (pre)                                          PostToolUse (post)
 ---------------------------------------------             ---------------------------------------------
 chrome-devtools call with pageId / selected page          list_pages / any devtools result:
   owned by this session?  -> allow                          parse "N: <url> [selected]" -> page id -> URL map
   select_page of a URL this session just opened             remap owned CDP target ids to page ids by URL
     with chromium-ensure?  -> allow + own                    detect renumbering -> drop page ids, keep target ids
   otherwise               -> deny + how-to                 new_page: own the page it selected
 list_pages, new_page      -> always allowed                chromium-ensure: own the "targetId" it printed;
 shell: .../json/close|activate/<id> on a foreign tab          without one, remember -Url as pending for 10 min
                           -> deny                          tab-opening calls without an id: diff the CDP tab
 shell: guard.mjs claim    -> deny (user only)                list before/after, own new tabs whose URL matches

 state: <state dir>/<session_id>.json  (owned page ids, owned target ids, pending URLs, last page map)
        <state dir>/owners.json         (target id -> session id, so two sessions never own one tab)
```

- **Two kinds of ids.** CDP target ids (32 hex characters) are stable for the life of a tab and are the real ownership record. `chrome-devtools-mcp` page ids are small integers that the agent must pass; the hook maps between them by URL after every `list_pages`.
- **Exact beats guessed.** An id printed by `chromium-ensure.ps1` or `deskctl browser_open` always wins. A tab found by diffing the tab list before and after is taken only if no other session owns it. If the site redirected (the new tab's URL no longer matches `-Url`), the diff still takes it when it is the only new tab on the same origin.
- **Live URL of owned tabs.** Before denying a page id, the hook compares its URL with the current URL of the tabs this session owns by target id, so a tab that redirected after it was opened stays usable.
- **Sessions are told what to do.** Every deny message lists the session's own tabs and the commands that open a new one.
- **`claim`.** `! node guard.mjs claim <pageId|tab id>` typed by the user (the `!` prefix runs it as the user, and Claude Code passes `CLAUDE_CODE_SESSION_ID`) gives that tab to the current session. `whoami` prints the session id.
- **Fail closed.** An exception in the pre phase denies the call and logs to `guard.log`. If the CDP port does not answer, devtools calls still go through the page-id checks.

### `chromium/` helpers (Windows)

- `chromium-launch.ps1` starts Chromium with `--remote-debugging-port` and its own `--user-data-dir`, so your daily browser is never put on a debug port.
- `chromium-ensure.ps1 [-Profile <p>] [-Url <url>]` makes sure that Chromium is running and returns JSON:
  - `mode: "tab"`: a tab was opened in that profile over CDP (`Target.createTarget` in the profile's browser context); `targetId` is included.
  - `mode: "mcp"`: Chromium was started, or restarted because it was on another profile and had no busy tabs, so `new_page` and the opened URL are in the right profile.
  - `mode: "window"`: Chromium is busy on another profile, so a separate window for the requested profile was opened. No `targetId`; the hook falls back to the pending-URL rule.
- `chromium-cdp.mjs probe|open|close|find|eval` is the small CDP client the script uses. It finds a profile's browser context by opening `chrome://version` in it and reading the profile path.

### Optional: deskctl support

`deskctl` is the author's own Windows desktop-automation MCP server (not published). If an MCP server named `deskctl` is configured, the hook also checks its calls: `web_click`/`web_point`/`browser_close` must name an owned tab, and window-level actions on a Chromium window (click, type, keys, `window close`, `Alt+F4`, `Ctrl+Shift+W`) are allowed only while that window shows one of the session's tabs. `deskwin.py` answers "which tab does this window show" using deskctl's Python window helpers. Without deskctl none of this runs; `mcp__deskctl__*` tools simply do not occur.

---

## Limitations

- **Text parsing of `list_pages`.** Page ids and URLs come from `chrome-devtools-mcp`'s human-readable output (`N: <url> [selected]`). A format change will make the hook deny everything until it is updated. Fails closed, so this is annoying but not dangerous.
- **Same URL in two tabs.** Page-id to target-id mapping is by URL. If two tabs show the same URL and all of them belong to this session, all their page ids are bound. If any of them belongs to another session or to no one, the hook does not bind either by guesswork.
- **Not a security boundary.** It stops accidents between cooperating sessions. A session that writes its own CDP client (Python, a fresh script) bypasses it. It also does not isolate cookies: every session shares the profile's logins.
- **Windows-only helpers.** `chromium-*.ps1` use `Get-CimInstance`, `Start-Process` and `%LOCALAPPDATA%`. The hook itself is plain Node and only needs the CDP HTTP endpoint.
- **Uses hook features of recent Claude Code.** The `if` field on hook entries and the `CLAUDE_PID` / `CLAUDE_CODE_SESSION_ID` variables were present on Claude Code 2.1.308. Without `if`, drop those entries' conditions and the hook still works, just started more often.
- **Hook latency.** Each checked call starts Node and may make one HTTP request to the CDP port (1.5 s timeout).

---

## Development

```powershell
npm test     # node --test; runs the hook against a fake CDP /json/list server and a temporary state folder
```

## License

MIT, see [LICENSE](LICENSE).
