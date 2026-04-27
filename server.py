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


def _tailscale_nodes() -> list[dict]:
    try:
        out = subprocess.check_output(["tailscale", "status", "--json"], timeout=10)
        data = json.loads(out)
    except Exception:
        return []

    nodes = []
    tailnet = data.get("MagicDNSSuffix", "")
    for _, peer in data.get("Peer", {}).items():
        if not peer.get("Online", False):
            continue
        nodes.append({
            "hostname": peer.get("HostName", ""),
            "dns_name": peer.get("DNSName", "").rstrip("."),
            "os": peer.get("OS", ""),
            "online": True,
            "tailnet": tailnet,
        })
    return nodes


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
async def index():
    return HTMLResponse((_static_dir / "index.html").read_text())


@app.get("/api/nodes")
async def list_nodes():
    return {"nodes": _tailscale_nodes()}


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
