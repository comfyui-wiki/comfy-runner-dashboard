# agents.md — comfy-runner-dashboard

A local web dashboard for managing remote [comfy-runner](https://github.com/Kosinkadink/comfy-runner) instances over a Tailscale network. This file is written for AI coding agents joining the project for the first time.

## TL;DR

- **What**: a tiny FastAPI server (Python) + static SPA (vanilla ES modules, no framework, no build step) that runs on the developer's laptop.
- **Why**: comfy-runner exposes an HTTPS API on port `9189` of every machine in the tailnet. Browsers refuse to talk to those endpoints directly (self-signed certs, CORS, mixed content), so this dashboard acts as a thin local proxy + UI in front of them.
- **Run it**: `python3 server.py` → open http://localhost:7890.

## Architecture at a glance

```
Browser (localhost:7890)
  │  fetch /api/...
  ▼
server.py  (FastAPI on 127.0.0.1:7890)
  │  subprocess: curl -sk --noproxy '*'
  ▼
Tailscale peer  (https://<host>.tail*.ts.net:9189)  ── runs comfy-runner
  │
  ▼
ComfyUI installations (instance-a, instance-b, …) on local ports 8188+
```

Three discovery / control layers:

1. **`tailscale status --json`** is shelled out to enumerate online peers. That is the *only* place Tailscale is touched. No Tailscale auth tokens, no API keys.
2. **`/api/proxy/{host}/{path}`** transparently forwards any HTTP method to the remote comfy-runner. For Tailscale hosts this is `https://{host}:9189{path}`. For RunPod proxy hosts (`*-9189.proxy.runpod.net`) the port is already in the hostname, so no `:9189` is appended. Uses `curl -sk --noproxy '*'`.
3. **`/api/pods*`** talks to the RunPod REST API using `RUNPOD_API_KEY` from `.env` (via `python-dotenv` + `runpod_client.py`). List / start / stop / terminate machines. Opening **Manage instances** reuses the existing node UI against the pod’s runner proxy host.
4. **`/api/dashboard/*`** (if present) manages the dashboard process itself.

## Repo layout

```
comfy-runner-dashboard/
├── server.py                 # FastAPI app — Tailscale proxy + RunPod pod APIs
├── runpod_client.py          # RunPod REST helper (curl --noproxy)
├── .env.example              # RUNPOD_API_KEY=…
├── requirements.txt          # fastapi, uvicorn, httpx, python-dotenv, …
├── README.md                 # user-facing docs
├── agents.md                 # ← this file
└── static/
    ├── index.html
    ├── css/main.css
    └── js/
        ├── app.js
        ├── utils.js
        ├── nodes.js          # Tailscale sidebar
        ├── pods.js           # RunPod sidebar + pod detail page
        ├── endpoints.js
        └── modals/
```

## Backend (`server.py`)

- **Framework**: FastAPI + uvicorn. Run as `python3 server.py` (binds `127.0.0.1:7890` with `reload=True`).
- **Static mount**: `/static` → `static/`. `GET /` returns `static/index.html`.
- **Constants**: `COMFY_RUNNER_PORT = 9189`, `TIMEOUT = 30`. Edit these in-place (no env-var layer yet).
- **Outbound HTTP** uses `subprocess.run(["curl", "-sk", "--noproxy", "*", ...])` rather than `httpx`. Reasons: (a) skips self-signed cert verification with `-k`; (b) `--noproxy *` defends against a misconfigured corporate HTTP proxy; (c) returns raw bytes so the proxy can passthrough non-JSON responses untouched.

### Routes

| Route | Purpose |
|---|---|
| `GET  /` | serves `static/index.html` |
| `GET  /api/nodes` | parses `tailscale status --json`, returns online peers `[{hostname, dns_name, os, online, tailnet}]` |
| `GET  /api/nodes/{host}/status` | shortcut for `GET https://{host}:9189/status` (the homepage of each node) |
| `*    /api/proxy/{host}/{path:path}` | universal pass-through to the remote comfy-runner. Forwards method, body, content-type. |
| `POST /api/dashboard/restart` | `os.utime(server.py)` to trigger uvicorn's reload watcher |
| `POST /api/dashboard/self-update` | `git fetch` + `git pull --ff-only` (or `git reset --hard @{u}` if `{"force": true}`), then touch to reload |

The proxy is intentionally dumb: whatever method/body the browser sends, curl sends. Adding a new comfy-runner endpoint requires **no backend change** — only a row in `ENDPOINTS` in `endpoints.js`.

## Frontend (vanilla ES modules)

No bundler, no transpiler, no framework. Modules are loaded by `<script type="module" src="/static/js/app.js">`.

- **Wiring pattern**: `app.js` imports every public function and assigns it to `window.*` so that inline `onclick="window.foo(...)"` handlers in `index.html` resolve. If you add a function that needs to be invoked from HTML, **register it on `window` in `app.js`** — the most common bug for new contributors is forgetting this and silently getting `ReferenceError`.
- **State**: a couple of module-scope `let` variables (`_currentHost`, `_deployHost`, `_mmHost/_mmInst/_mmFile`). No store, no reactive layer. Re-renders are full-region replacements via `innerHTML = ...`.
- **Strings → DOM**: every dynamic value goes through `esc()` from `utils.js` before interpolation. Keep doing this — there is **no template engine** to escape for you.
- **API helper**: `callEndpoint(host, method, path, body?)` in `utils.js` is the canonical way to hit the proxy and render the response into `#ep-resp`. Modals build their own fetches when they need progress / polling (model upload, fanout).

### The endpoints catalog

`endpoints.js` has a single source of truth — the `ENDPOINTS` array — listing every comfy-runner API the UI exposes (Global / Instance / Nodes / Models / Outputs / Snapshot / Jobs sections). Each entry: `{ section, method, path, desc, hasBody?, pathParams? }`.

**Placeholder rules**: Anything matching `{xxx}` in `path` becomes a UI control on that row.
- `{name}` → instance dropdown (populated from the host's installations).
- Any other `{xxx}` (e.g. `{job_id}`, `{snapshot_id}`, `{other_id}`) → free-text input with `xxx` as placeholder text. The input id is `inp-{pathId}-{xxx}`. At click time the value is substituted in; empty input becomes the literal `unknown_{xxx}` so failures are visible.
- The optional `pathParams` field is informational only; placeholders are detected from the path string itself.

When comfy-runner ships a new endpoint, the typical change is a one-line addition to `ENDPOINTS`. If the new endpoint needs a custom body UI (e.g. download-model), add a special-case in `runEp()` that opens the right modal instead of the generic JSON editor.

### Modals

- `generic.js` — fallback for any `POST/PUT/PATCH` that takes a JSON body. Just shows a textarea pre-filled with `{}`.
- `deploy.js` — radios (`latest` / `pull` / `branch` / `tag` / `commit` / `pr` / `reset`) → builds the right body for `POST /{name}/deploy`. The conditional input row (`#dm-input-row`) shows for branch/tag/commit/pr only.
- `model.js` — two tabs (download from URL / upload local file). Download returns a `job_id` and `_pollJob` polls `GET /job/{id}` every 2s for up to 10 min. Upload uses raw `XMLHttpRequest` (not fetch) for upload-progress events.
- `tailnet.js` — two modals sharing the file:
  - **Tailnet viewer**: calls `GET /tailnet/runners` on the *currently-selected* node, which returns peers it has discovered through its own tailscale API key. (This is a comfy-runner feature, not a dashboard feature — older runners 404 here.)
  - **Fanout**: posts to `POST /pods/self-update` with optional `names` filter and `force` flag. Renders a per-pod result list.

### Self-management UI

`dashboard-self.js` adds a `⚙` dropdown in the header with: Restart dashboard, Update + restart, Force update + restart. After firing, it shows a toast and polls `/api/nodes` until uvicorn comes back, then `location.reload()`. The fact that the fetch's connection drops during reload is *expected*; both branches of the try/catch trigger the same wait-loop.

## Update flows (important — three different things)

The word "update" in this codebase means three different operations on three different layers. Don't confuse them:

| # | What gets updated | UI entry point | Backend call | Where the work happens |
|---|---|---|---|---|
| 1a | **A ComfyUI instance — fast path** (most common) | `⬆ Update to latest master` button on each instance card (green, primary) | `POST /api/proxy/{host}/{name}/deploy` with `{ branch: "master", start: true }` | remote machine |
| 1b | **A ComfyUI instance — full options** | `⬆ Deploy…` button on each instance card → deploy modal | `POST /api/proxy/{host}/{name}/deploy` (body varies by mode) | remote machine |
| 2 | **comfy-runner itself** (the server listening on 9189 on a remote machine) | header `⬆ Self-update` / `⬆ Force-update` buttons (per-node) | `POST /api/proxy/{host}/self-update` | remote machine |
| 2b | **comfy-runner across the whole tailnet** (fan-out) | header `⚡ Update all pods` button → fanout modal | `POST /api/proxy/{host}/pods/self-update` (the selected node fans out to its peers) | remote machine forwards to all peers |
| 3 | **This dashboard** (the FastAPI process you're using right now) | header `⚙` dropdown → *Update + restart* / *Force update + restart* | `POST /api/dashboard/self-update` (local) | local laptop |

### 1. Deploy a ComfyUI instance — `modals/deploy.js`

Two entry points on each instance card:

- **`⬆ Update to latest master`** (green, primary) — `deployLatestMaster()` posts `{ branch: "master", start: true }` directly to `/{name}/deploy`. No modal. This is the by-far most common operation, so it gets the loudest button.
- **`⬆ Deploy…`** (ghost) — opens the full modal for everything else.

The modal has seven mutually-exclusive modes; each maps to one field in the request body:

| Mode | Body sent | Effect |
|---|---|---|
| Latest release | `{ latest: true }` | check out the newest stable ComfyUI release tag |
| Pull current branch | `{ pull: true }` | `git pull` on whatever branch is currently tracked |
| Branch | `{ branch: "master" }` | switch to that branch (defaults to `master` — ComfyUI's upstream default — if blank) |
| Tag / release | `{ tag: "v0.3.27" }` | pin to a specific git tag |
| Commit SHA | `{ commit: "a1b2c3d" }` | pin to an exact commit |
| Pull Request | `{ pr: 1234 }` | check out an open PR |
| Reset | `{ reset: true }` | revert to original ref |

The `Start instance after deploy` checkbox adds `{ start: true|false }` to every payload. After submit, `callEndpoint` schedules a `refreshCurrent()` ~2 s later because deploy modifies status.

### 2. Self-update comfy-runner (single node) — `app.js::doSelfUpdate`

The two header buttons `⬆ Self-update` and `⬆ Force-update` post to the *currently-selected* node's `/self-update` endpoint:

- `{ force: false }` → runner runs `git pull --ff-only`
- `{ force: true }` → runner runs `git reset --hard origin/main` (browser confirms first; this discards local changes on the remote)

The runner restarts itself after a successful update; the dashboard waits ~4 s and refreshes the node view.

### 2b. Fanout — `modals/tailnet.js::submitFanout`

`⚡ Update all pods` opens a modal that posts `{ names?: string[], force: bool }` to `POST /pods/self-update` on the selected node. That node then iterates its tailnet peers and invokes their `/self-update` for you. Empty `names` → "all online pods, excluding self." Names match either hostname (`comfy-pr-1234`) or pod_name (`pr-1234`). The response (`{ total, ok_count, updated_count, failed_count, results: [...] }`) is rendered as one line per pod — `✓ name [updated]` or `✗ name — error`.

This is *one comfy-runner orchestrating the others.* The dashboard isn't doing the fan-out itself; it just sends one request and shows the aggregated result. A node without the `/pods/self-update` route (older runner) will return 404 and the modal surfaces that.

### 3. Update the dashboard itself — `dashboard-self.js`

The `⚙` dropdown's two update buttons hit local route `POST /api/dashboard/self-update`:

- `{ force: false }` → `git fetch --all && git pull --ff-only` in the dashboard's repo
- `{ force: true }` → `git fetch --all && git reset --hard @{u}` (browser confirms first)

Then `os.utime(__file__, None)` is called to touch `server.py`, which makes uvicorn's reloader restart the process. The browser drops connection during reload (expected), the toast says "Updating…", and `_waitForBackOnline()` polls `/api/nodes` until the server responds, then `location.reload()`s the page. Failure path (e.g. merge conflict, dirty tree on non-force) returns the git error in the response body — surfaced in the toast.

> All three update layers go through git on the target machine. There is no version-pinning UI in the dashboard for either the runner (#2) or the dashboard itself (#3) — they always go to upstream HEAD. Only ComfyUI instances (#1) support pinning to tag/commit/PR.

## How to run / hack

```bash
pip install -r requirements.txt   # only fastapi + uvicorn are actually used
python3 server.py                 # http://localhost:7890, auto-reloads on edit
```

- Editing `server.py` triggers uvicorn's reload (`reload=True`).
- Editing static files is hot — just refresh the browser (no cache headers, but you'll often need a hard reload because module imports are cached).
- The dashboard itself can be `git pull`-ed live via the `⚙ → Update + restart` menu without leaving the browser.

## Conventions for agents editing this code

- **Don't introduce a build step.** The whole point is "open server.py and read 180 lines to understand the backend; open one HTML file + a handful of small JS modules to understand the frontend." A bundler / framework / TS migration would defeat that.
- **Prefer extending `ENDPOINTS` over writing new server routes.** The proxy already covers any new comfy-runner API.
- **Always escape user-controlled / remote strings** with `esc()` before putting them into `innerHTML`. Hostnames, instance names, branch names, error messages — everything. Never assume comfy-runner's responses are safe.
- **Keep modules small and topic-scoped.** `nodes.js` knows about the sidebar; `endpoints.js` knows about the API panel; modals each own one feature. If a module starts doing two things, split it.
- **Inline `onclick=` is intentional.** It's terse and pairs well with `innerHTML` re-renders. Don't migrate to `addEventListener` wiring just for purity.
- **No JS or CSS minification.** Code is read in the browser as written.
- **Don't add error-handling that hides the curl/HTTP body.** Forwarding the raw status + body is the contract between dashboard and runner — if a runner returns a 400 with an error message, the user needs to see it verbatim.

## Common tasks

- **Add a new comfy-runner endpoint to the UI**: add a row to `ENDPOINTS` in `endpoints.js`. Done. If it needs a custom body UI, add a branch in `runEp()` that opens a new modal.
- **Change the dashboard port**: edit `uvicorn.run(..., port=7890)` at the bottom of `server.py`.
- **Change the comfy-runner port** (e.g. you run it on 9190): edit `COMFY_RUNNER_PORT` near the top of `server.py`.
- **Add a new sidebar action in the header**: drop a button in `index.html`'s `.header-actions`, export the handler from a JS module, and register it on `window` in `app.js`.
- **Debug a proxy call**: open DevTools → Network → look at `/api/proxy/<host>/...`. The status code and body are exactly what curl received from the runner. The dashboard does not transform either.

## What this dashboard is NOT

- It is **not a multi-user web app**. It binds `127.0.0.1` and assumes you, on your laptop, are the only user. Any auth lives at the Tailscale layer.
- It is **not a persistent backend**. It holds no DB, no cache, no session. Every page load re-queries Tailscale and the runners.
- It is **not a replacement for ComfyUI's own UI**. It manages the runner (deploy/start/stop/snapshot/models) but never opens the ComfyUI canvas itself — that's served separately on each instance's port (8188+).

## Related projects

- [comfy-runner](https://github.com/Kosinkadink/comfy-runner) — the remote service this dashboard talks to. The API surface listed in `ENDPOINTS` mirrors that project's routes; check there first when an endpoint behaves unexpectedly.
