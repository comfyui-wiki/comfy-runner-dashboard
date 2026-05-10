# comfy-runner-dashboard

A local web dashboard for managing remote [comfy-runner](https://github.com/Kosinkadink/comfy-runner) instances over your Tailscale network. Monitor status, deploy versions, control instances, and browse all API endpoints from one place.

## Requirements

- Python 3.x
- [Tailscale](https://tailscale.com/) installed and authenticated on your machine
- Remote machines running [comfy-runner](https://github.com/Kosinkadink/comfy-runner) on port `9189`

## Setup

```bash
pip install -r requirements.txt
```

## Running

**macOS — double-click:**

Double-click `start-dashboard.command` in Finder. The first time, right-click → Open to bypass the Gatekeeper prompt.

**Terminal:**

```bash
python3 server.py
```

Then open [http://localhost:7890](http://localhost:7890) in your browser.

## Features

### Instance Cards

Each ComfyUI installation shows:
- Running status, port, uptime, PID
- Deployed version (release tag, branch, commit hash)
- **Start / Stop / Restart** buttons

### Deploy

Click **Deploy** on any instance to open the deploy modal. Options:

| Mode | Description |
|------|-------------|
| Latest release | Update to the newest stable ComfyUI release |
| Pull current branch | Fetch latest commits on the currently tracked branch |
| Branch | Switch to a specific branch (default fallback is `master` — ComfyUI's default branch) |
| Tag / release | Pin to a specific git tag |
| Commit SHA | Pin to an exact commit |
| Pull Request | Check out an open PR |
| Reset | Revert to the original ref |

Two checkboxes:
- **Start instance after deploy** — automatically restart after deploying.
- **Force (drop dirty changes)** — destructive: `git reset --hard` + `git clean -fd` on the ComfyUI clone before deploying. Runtime directories (`styles/`, `output/`, `input/`, `temp/`, `user/`, `models/`, `custom_nodes/`) are still preserved. Default behavior (unchecked) is to stash any non-runtime dirty files and continue, recoverable via `git stash list` on the box.

> To get the absolute latest commit on master: first deploy with **Branch = `master`**, then use **Pull current branch** for subsequent updates.

### Models

The Models modal (per instance) handles both downloading from a URL and uploading from your local machine.

- **Directory** is a dropdown of all 25 model subfolders ComfyUI knows about (`checkpoints`, `loras`, `vae`, `controlnet`, `upscale_models`, `clip`, `clip_vision`, `text_encoders`, `embeddings`, `unet`, `diffusion_models`, `diffusers`, `ipadapter`, `hypernetworks`, `style_models`, `gligen`, `photomaker`, `audio_encoders`, `vae_approx`, `model_patches`, `configs`, `background_removal`, `frame_interpolation`, `optical_flow`, `latent_upscale_models`). Pick **Custom…** at the bottom to type any folder name the runner accepts.
- **HuggingFace token** field (download tab) is optional. Required for private / gated repos — without it, HF returns `404 Not Found` (it deliberately hides existence from unauthorized requests).
- Download progress is polled every 2s and reported live in the modal. On completion, the result panel splits into `Downloaded` / `Skipped` / `Failed` with per-file errors — no silent "Done!" when the runner actually returned a 4xx for the URL.

### Async job tracking

Long-running endpoints (deploy, download-model, self-update, init, …) on the runner return immediately with `{ "job_id": "..." }`. The dashboard now follows these automatically:

- The global response panel polls `GET /job/<id>` every second after any 200 response that contains `job_id`.
- It shows live `status / label / output tail` and switches the panel red when the final state is `error` or `cancelled`.
- A 30-minute hard cap (deploy/global poller) and 6-hour cap (model-download poller) keep the UI from polling forever; falling off the cap shows a clear "stopped polling, recover via `GET /job/<id>`" message rather than silently giving up.
- Only one job poll is in-flight at a time per panel — kicking off a new request aborts the previous poll cleanly.

### Self-update

Two buttons in the top-right update the comfy-runner server itself on the remote machine:

- **Self-update** — runs `git pull --ff-only`
- **Force-update** — runs `git reset --hard origin/main` (discards local changes, prompts for confirmation)

### API Endpoint Browser

A tabbed panel exposes all comfy-runner API endpoints for interactive testing:

| Tab | Endpoints |
|-----|-----------|
| Global | status, installations, system-info, jobs, config, deploy, restart, stop, self-update |
| Instance | status, info, logs, start, stop, restart, deploy, config, rename, unlock, delete |
| Nodes | list, add/remove/enable/disable |
| Models | download, move, upload, upload status |
| Outputs | list output files |
| Snapshot | list, save, restore, import |
| Jobs | poll status, cancel |

Endpoints that accept a request body open a JSON editor modal before sending.

## Configuration

All configuration is in `server.py`:

| Setting | Default | Description |
|---------|---------|-------------|
| Dashboard port | `7890` | Local port for the dashboard UI |
| Remote port | `9189` | Port comfy-runner listens on |
| Request timeout | `30s` | Timeout for proxied requests (note: long-running operations return a `job_id` and are polled, so this only caps the *initial* request) |

The dashboard discovers remote nodes automatically via `tailscale status` and connects over HTTPS, accepting self-signed certificates.

## Development

- All static assets under `/static/` (and `/`) are served with `Cache-Control: no-store`. Edit any HTML/CSS/JS file and a normal page refresh picks it up — no Cmd+Shift+R hard refresh needed during dev.
- The dashboard is plain ES modules + a small FastAPI backend (`server.py`); no build step.
- `server.py` shells out to `curl --noproxy '*'` for the proxy so requests to your tailnet bypass any system-wide HTTP proxy / VPN. If you can reach the runner with `curl -k https://<host>:9189/status` from the same machine, the dashboard can too.
