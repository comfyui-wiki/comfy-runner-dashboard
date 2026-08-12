# comfy-runner-dashboard

A local web dashboard for managing remote [comfy-runner](https://github.com/Kosinkadink/comfy-runner) instances. It discovers machines on your Tailscale network, can also drive RunPod pods via API key, and proxies the runner HTTPS API so the browser never has to talk to self-signed `:9189` endpoints directly.

## Requirements

- Python 3.x
- [Tailscale](https://tailscale.com/) installed and logged in on this machine (for the **Nodes** sidebar)
- Remote machines running [comfy-runner](https://github.com/Kosinkadink/comfy-runner) on port `9189`
- Optional: a RunPod API key for the **RunPod** sidebar (`RUNPOD_API_KEY`)

## Setup

```bash
pip install -r requirements.txt
cp .env.example .env   # then set RUNPOD_API_KEY=rk_… if you use RunPod
```

## Running

**macOS — double-click:** `start-dashboard.command` (first time: right-click → Open).

**Terminal:**

```bash
python3 server.py
```

Open [http://localhost:7890](http://localhost:7890). The server binds `127.0.0.1` only.

## How it works

```
Browser (localhost:7890)
  → FastAPI (server.py)
      → tailscale status --json          # list online peers
      → curl -sk --noproxy '*'          # proxy to https://<host>:9189/…
      → RunPod REST API                 # pods / stock / volumes (optional)
```

Browsers cannot call comfy-runner directly (self-signed certs, CORS). The dashboard is a thin local proxy plus UI. No Tailscale auth tokens are stored; discovery is just the local `tailscale` CLI.

## Tailscale nodes

The sidebar **Nodes** section lists online Tailscale peers from `tailscale status --json`.

- Click a peer to load its comfy-runner status (installations, hardware chips, instance cards).
- **Runners only** checkbox: when on, the dashboard probes each online peer on `:9189` and only keeps hosts that answer. Useful on a busy tailnet; turn it off if a slow runner is missing.
- Last selected node is remembered in `localStorage`.
- Header actions for the selected node:
  - **Self-update / Force-update** — update comfy-runner on that machine (`POST /self-update`)
  - **ngrok** — edit that node’s ngrok authtoken / reserved domain pool

Proxy targets use the peer’s MagicDNS name (`https://<host>.tail….ts.net:9189`). If `curl -k https://<host>:9189/status` works from this laptop, the dashboard can reach it too (`--noproxy '*'` bypasses a misconfigured system HTTP proxy).

RunPod hosts use `*-9189.proxy.runpod.net` instead; the port is already in the hostname, so `:9189` is not appended again.

## RunPod pods

Needs `RUNPOD_API_KEY` in `.env`. The sidebar **RunPod** section then shows:

- Account balance / spend
- **Launch** — pick GPU + datacenter (stock-aware), Keep my files / Temporary, then create a machine. With “Keep my files”, reuses a same-place network volume or creates a 200GB one
- **Start / Stop** — GPU lifecycle. Stopped pods stay pinned to one host; if Start fails with “not enough free GPUs”, use **Launch** / **Find a free machine**
- **Open** — ComfyUI public proxy URL
- **Manage instances** — same instance UI as Tailscale nodes, aimed at the pod’s runner proxy
- **Terminate** — delete the pod (network volumes kept)

Launch image: `ghcr.io/kosinkadink/comfy-runner:latest`, ports `8188` + `9189`, Community cloud.

## Instances

Selecting a Tailscale node or **Manage instances** on a RunPod pod shows the instance grid.

Each card:

- Health (stopped / healthy / unhealthy), port, uptime, PID
- Deployed version (tag, branch, commit); **PR badge** when checked out at a PR head
- **Open** / **ngrok** links when the instance is running and has a serve / tunnel URL
- **Start / Stop / Restart**, **Deploy**, **Launch args**, **Tunnel**, **Models**, **Nodes**
- ⋮ menu: force unlock, view logs, delete instance

**+ New instance** initialises a fresh install via `POST /<name>/deploy` with `{latest: true}` (auto-init when no record exists). Optional advanced GPU variant / CUDA compat overrides.

### Deploy

| Mode | Effect |
|------|--------|
| Latest release | Newest stable ComfyUI release |
| Pull current branch | `git pull` on the tracked branch |
| Branch / Tag / Commit / PR | Pin to that ref |
| Reset | Revert to the original ref |

Options: start after deploy; **Force** (`git reset --hard` + clean, runtime dirs preserved). Default without Force is stash non-runtime dirty files.

**Branch** and **PR** modes can override repo + optional GitHub token (private forks). Token is injected only for `https://github.com/…` URLs. Prefer a fine-scoped PAT.

### Models

Per-instance **Models** modal:

- **Download** — multi-entry queue (URL + folder each); optional HuggingFace token; live job polling
- **Upload** — local file to a model subfolder (or Custom…)
- **Manage** — browse folders / files, move or copy between dirs

### Custom nodes

Per-instance **Nodes** modal:

- Install from a **git URL** (`https://…` / `git@…`) or a **CNR** node id (optional version)
- List installed nodes; enable / disable / remove
- `add` / `rm` are async jobs and are polled in the modal

Restart ComfyUI after installing nodes so they load.

### Launch args & tunnels

- **Launch args** — edit ComfyUI process flags (including disable-all-custom-nodes) via instance config
- **Tunnel** — start/stop ngrok or Tailscale tunnel for that instance’s ComfyUI port (runner must allow tunnels)

### Job log

Bottom **Job log** console keeps a persistent trail of proxy calls and polled async jobs (`job_id`). Expand / clear from the header strip. Long ops (deploy, model download, node install, …) update in place instead of flooding the panel.

## API endpoint browser

Below the instance grid, a tabbed panel exposes runner routes for ad-hoc calls (Global, Instance, Nodes, Models, Outputs, ComfyUI proxy, Snapshot, Reviews, Jobs). Dedicated UIs open for deploy, models, custom nodes, and tunnel start; other body endpoints use the generic JSON editor.

## Configuration

Edit constants in `server.py`:

| Setting | Default | Description |
|---------|---------|-------------|
| Dashboard port | `7890` | Local UI |
| Remote port | `9189` | comfy-runner |
| Request timeout | `30s` | Initial proxied request only (jobs are polled separately) |

Env (`.env`):

| Variable | Purpose |
|----------|---------|
| `RUNPOD_API_KEY` | RunPod sidebar + Launch / stock / volumes |

## Development

- Static assets are served with `Cache-Control: no-store`. Edit HTML/CSS/JS and refresh.
- Plain ES modules + FastAPI; no bundler.
- New comfy-runner routes usually need only a row in `ENDPOINTS` (`static/js/endpoints.js`), unless you want a custom modal.
