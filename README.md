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
| Branch | Switch to a specific branch (e.g. `main` for latest commits) |
| Tag / release | Pin to a specific git tag |
| Commit SHA | Pin to an exact commit |
| Pull Request | Check out an open PR |
| Reset | Revert to the original ref |

Check **"Start instance after deploy"** to automatically restart after deploying.

> To get the absolute latest commit on the main branch: first deploy with **Branch = `main`**, then use **Pull current branch** for subsequent updates.

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
| Request timeout | `30s` | Timeout for proxied requests |

The dashboard discovers remote nodes automatically via `tailscale status` and connects over HTTPS, accepting self-signed certificates.
