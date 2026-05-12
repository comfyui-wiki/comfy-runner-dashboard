"""Local dashboard server for managing remote comfy-runner instances via Tailscale."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

app = FastAPI(title="comfy-runner dashboard")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_static_dir = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=_static_dir), name="static")


@app.middleware("http")
async def _no_cache_static(request: Request, call_next):
    resp = await call_next(request)
    if request.url.path.startswith("/static/") or request.url.path == "/":
        resp.headers["Cache-Control"] = "no-store, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
    return resp

COMFY_RUNNER_PORT = 9189
TIMEOUT = 30


def _api_url(host: str, path: str) -> str:
    return f"https://{host}:{COMFY_RUNNER_PORT}{path}"


def _curl(method: str, url: str, body: bytes | None = None, headers: dict | None = None) -> tuple[int, bytes, str]:
    """Run curl, bypassing any system proxy. Returns (status_code, body_bytes, content_type)."""
    cmd = ["curl", "-sk", "-X", method, "-w", "\n__STATUS__%{http_code}", "--max-time", str(TIMEOUT)]
    if body:
        cmd += ["--data-binary", "@-"]
    if headers:
        for k, v in headers.items():
            cmd += ["-H", f"{k}: {v}"]
    # explicitly bypass proxy
    cmd += ["--noproxy", "*", url]

    result = subprocess.run(cmd, input=body, capture_output=True, timeout=TIMEOUT + 5)
    raw = result.stdout
    # split status code appended at the end
    if b"\n__STATUS__" in raw:
        body_part, status_part = raw.rsplit(b"\n__STATUS__", 1)
        status_code = int(status_part.strip())
    else:
        body_part = raw
        status_code = 200 if result.returncode == 0 else 502

    return status_code, body_part, "application/json"


def _discover_tailscale_peers() -> dict:
    """Return {nodes, error, meta} for /api/nodes. `error` is set when tailscale failed; `meta` summarizes Peer counts when JSON parsed."""
    out: dict = {"nodes": [], "error": None, "meta": None}
    try:
        proc = subprocess.run(
            ["tailscale", "status", "--json"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except FileNotFoundError:
        out["error"] = "tailscale CLI not found in PATH"
        return out
    except subprocess.TimeoutExpired:
        out["error"] = "tailscale status timed out after 10s"
        return out
    except Exception as e:
        out["error"] = str(e)
        return out

    if proc.returncode != 0:
        hint = (proc.stderr or proc.stdout or "").strip()[:800]
        out["error"] = f"tailscale exited {proc.returncode}" + (f": {hint}" if hint else "")
        return out

    try:
        data = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError as e:
        out["error"] = f"invalid JSON from tailscale: {e}"
        return out

    peers = data.get("Peer") or {}
    if not isinstance(peers, dict):
        peers = {}

    online_n = sum(1 for p in peers.values() if isinstance(p, dict) and p.get("Online", False))
    out["meta"] = {
        "total_peers": len(peers),
        "online_peers": online_n,
        "tailnet": data.get("MagicDNSSuffix") or "",
    }

    tailnet = data.get("MagicDNSSuffix", "")
    for peer in peers.values():
        if not isinstance(peer, dict) or not peer.get("Online", False):
            continue
        out["nodes"].append({
            "hostname": peer.get("HostName", ""),
            "dns_name": peer.get("DNSName", "").rstrip("."),
            "os": peer.get("OS", ""),
            "online": True,
            "tailnet": tailnet,
        })
    return out


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
async def index():
    return HTMLResponse((_static_dir / "index.html").read_text())


@app.get("/api/nodes")
async def list_nodes():
    return _discover_tailscale_peers()


@app.get("/api/nodes/{host}/status")
async def node_status(host: str):
    try:
        status, body, ct = _curl("GET", _api_url(host, "/status"))
        return Response(content=body, media_type=ct, status_code=status)
    except Exception as e:
        raise HTTPException(502, str(e))


@app.api_route("/api/proxy/{host}/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def proxy(host: str, path: str, request: Request):
    remote_path = "/" + path
    url = _api_url(host, remote_path)
    body = await request.body() or None
    headers = {}
    if body:
        ct = request.headers.get("content-type", "application/json")
        headers["Content-Type"] = ct
    try:
        status, resp_body, ct = _curl(request.method, url, body, headers or None)
        return Response(content=resp_body, media_type=ct, status_code=status)
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "Request timed out")
    except Exception as e:
        raise HTTPException(502, str(e))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="127.0.0.1", port=7890, reload=True)
