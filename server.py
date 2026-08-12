"""Local dashboard server for managing remote comfy-runner instances via Tailscale / RunPod."""

from __future__ import annotations

import json
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles

from runpod_client import (
    RunPodClient,
    fetch_account,
    fetch_gpu_stock,
    summarize_pod,
    summarize_volume,
)

_ROOT = Path(__file__).parent
load_dotenv(_ROOT / ".env")

app = FastAPI(title="comfy-runner dashboard")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_static_dir = _ROOT / "static"
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
# Short probe when filtering the sidebar to hosts that actually run comfy-runner.
PROBE_TIMEOUT = 2


def _runpod_api_key() -> str:
    return (os.environ.get("RUNPOD_API_KEY") or "").strip()


def _runpod() -> RunPodClient:
    key = _runpod_api_key()
    if not key:
        raise HTTPException(
            400,
            "RUNPOD_API_KEY not set. Add it to .env in the dashboard project.",
        )
    return RunPodClient(key)


def _api_url(host: str, path: str) -> str:
    """Build a comfy-runner URL for a Tailscale host or RunPod proxy hostname."""
    host = (host or "").strip().rstrip("/")
    if host.startswith("https://") or host.startswith("http://"):
        return f"{host.rstrip('/')}{path}"
    # RunPod public proxy embeds the port in the hostname
    # (e.g. {id}-9189.proxy.runpod.net) — do not append :9189 again.
    if host.endswith(".proxy.runpod.net"):
        return f"https://{host}{path}"
    return f"https://{host}:{COMFY_RUNNER_PORT}{path}"


def _curl(
    method: str,
    url: str,
    body: bytes | None = None,
    headers: dict | None = None,
    timeout: int | None = None,
) -> tuple[int, bytes, str]:
    """Run curl, bypassing any system proxy. Returns (status_code, body_bytes, content_type)."""
    max_time = TIMEOUT if timeout is None else timeout
    cmd = ["curl", "-sk", "-X", method, "-w", "\n__STATUS__%{http_code}", "--max-time", str(max_time)]
    if body:
        cmd += ["--data-binary", "@-"]
    if headers:
        for k, v in headers.items():
            cmd += ["-H", f"{k}: {v}"]
    cmd += ["--noproxy", "*", url]

    result = subprocess.run(cmd, input=body, capture_output=True, timeout=max_time + 5)
    raw = result.stdout
    if b"\n__STATUS__" in raw:
        body_part, status_part = raw.rsplit(b"\n__STATUS__", 1)
        status_code = int(status_part.strip())
    else:
        body_part = raw
        status_code = 200 if result.returncode == 0 else 502

    return status_code, body_part, "application/json"


def _probe_runner(host: str) -> bool:
    """True if comfy-runner answers GET /status on this host."""
    host = (host or "").strip()
    if not host:
        return False
    try:
        status, _, _ = _curl("GET", _api_url(host, "/status"), timeout=PROBE_TIMEOUT)
        return status == 200
    except Exception:
        return False


def _filter_nodes_with_runner(nodes: list[dict]) -> list[dict]:
    """Keep only Tailscale peers that respond on the comfy-runner port."""
    if not nodes:
        return []

    def _check(n: dict) -> dict | None:
        host = n.get("dns_name") or n.get("hostname") or ""
        return n if _probe_runner(host) else None

    kept: list[dict] = []
    workers = min(32, max(1, len(nodes)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(_check, n) for n in nodes]
        for fut in as_completed(futures):
            try:
                hit = fut.result()
            except Exception:
                continue
            if hit is not None:
                kept.append(hit)

    # Stable order matching Tailscale discovery order.
    by_host = {(n.get("dns_name") or n.get("hostname")): n for n in kept}
    return [n for n in nodes if (n.get("dns_name") or n.get("hostname")) in by_host]


def _discover_tailscale_peers(runners_only: bool = False) -> dict:
    """Return {nodes, error, meta} for /api/nodes.

    When runners_only is True, probe :9189 and keep only peers that respond.
    Otherwise return every online Tailscale peer.
    """
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
    tailnet = data.get("MagicDNSSuffix", "")

    online: list[dict] = []
    for peer in peers.values():
        if not isinstance(peer, dict) or not peer.get("Online", False):
            continue
        online.append({
            "hostname": peer.get("HostName", ""),
            "dns_name": peer.get("DNSName", "").rstrip("."),
            "os": peer.get("OS", ""),
            "online": True,
            "tailnet": tailnet,
        })

    nodes = _filter_nodes_with_runner(online) if runners_only else online
    out["nodes"] = nodes
    out["meta"] = {
        "total_peers": len(peers),
        "online_peers": online_n,
        "runner_peers": len(nodes) if runners_only else None,
        "runners_only": runners_only,
        "tailnet": data.get("MagicDNSSuffix") or "",
    }
    return out


def _local_name_map() -> dict[str, str]:
    """Map RunPod pod id → friendly name from ~/.comfy-runner if present."""
    cfg_path = Path.home() / ".comfy-runner" / "config.json"
    if not cfg_path.is_file():
        return {}
    try:
        cfg = json.loads(cfg_path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    hosted = cfg.get("hosted") or {}
    providers = hosted.get("providers") or hosted
    runpod = providers.get("runpod") if isinstance(providers, dict) else {}
    if not isinstance(runpod, dict):
        runpod = hosted.get("runpod") if isinstance(hosted.get("runpod"), dict) else {}
    pods = runpod.get("pods") or {}
    out: dict[str, str] = {}
    if isinstance(pods, dict):
        for name, rec in pods.items():
            if isinstance(rec, dict) and rec.get("id"):
                out[str(rec["id"])] = str(name)
    return out


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
async def index():
    return HTMLResponse((_static_dir / "index.html").read_text())


@app.get("/api/nodes")
async def list_nodes(runners_only: bool = Query(False)):
    return _discover_tailscale_peers(runners_only=runners_only)


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


# ---------------------------------------------------------------------------
# RunPod pods
# ---------------------------------------------------------------------------

@app.get("/api/runpod/status")
async def runpod_status():
    key = _runpod_api_key()
    out: dict = {
        "configured": bool(key),
        "key_preview": (key[:4] + "…" + key[-4:]) if len(key) >= 12 else ("***" if key else ""),
        "account": None,
        "account_error": None,
    }
    if key:
        try:
            out["account"] = fetch_account(key)
        except Exception as e:
            out["account_error"] = str(e)
    return out


@app.get("/api/runpod/stock")
async def runpod_stock(gpu: str | None = None):
    """GPU + datacenter availability from RunPod GraphQL."""
    key = _runpod_api_key()
    if not key:
        raise HTTPException(400, "RUNPOD_API_KEY not configured")
    try:
        gpus = fetch_gpu_stock(key, gpu_id=gpu.strip() if gpu else None)
    except Exception as e:
        raise HTTPException(502, str(e)) from e
    return {"ok": True, "gpus": gpus}


@app.get("/api/runpod/volumes")
async def runpod_volumes():
    try:
        raw = _runpod().list_volumes()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, str(e)) from e
    vols = [summarize_volume(v) for v in raw]
    vols.sort(key=lambda v: (v["datacenter"], v["name"].lower()))
    return {"ok": True, "volumes": vols}


@app.post("/api/runpod/volumes")
async def create_runpod_volume(request: Request):
    """Create a network volume in a datacenter (persists across pod terminate)."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "JSON body required") from None

    name = str(body.get("name") or "").strip()
    datacenter = str(body.get("datacenter") or "").strip()
    try:
        size_gb = int(body.get("size_gb") or 200)
    except (TypeError, ValueError):
        raise HTTPException(400, "size_gb must be an integer") from None

    if not name or len(name) > 64 or "/" in name or "\\" in name or ".." in name:
        raise HTTPException(400, "Invalid volume name")
    if not datacenter or len(datacenter) > 32 or "/" in datacenter or "\\" in datacenter:
        raise HTTPException(400, "Invalid datacenter")
    if size_gb < 10 or size_gb > 4000:
        raise HTTPException(400, "size_gb must be between 10 and 4000")

    try:
        raw = _runpod().create_volume(name=name, size_gb=size_gb, datacenter=datacenter)
    except Exception as e:
        raise HTTPException(502, str(e)) from e
    if not isinstance(raw, dict):
        raise HTTPException(502, "Unexpected response creating volume")
    return {"ok": True, "volume": summarize_volume(raw)}


@app.get("/api/pods")
async def list_pods():
    try:
        raw_pods = _runpod().list_pods()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(502, str(e)) from e

    # Enrich VRAM from live GPU catalog when pod payloads omit memory
    # (common for EXITED pods with an empty machine object).
    vram_by_id: dict[str, int] = {}
    key = _runpod_api_key()
    if key:
        try:
            for g in fetch_gpu_stock(key):
                if g.get("memory_gb") is not None:
                    vram_by_id[g["id"]] = int(g["memory_gb"])
                    vram_by_id[g.get("display_name") or ""] = int(g["memory_gb"])
        except Exception:
            pass

    names = _local_name_map()
    pods = []
    for raw in raw_pods:
        info = summarize_pod(raw)
        if info.get("vram_gb") is None and info.get("gpu_type"):
            gt = info["gpu_type"]
            info["vram_gb"] = vram_by_id.get(gt) or vram_by_id.get(
                gt.replace("NVIDIA GeForce ", "").replace("NVIDIA ", "")
            )
        local = names.get(info["id"])
        if local:
            info["local_name"] = local
            if not info["name"] or info["name"] == info["id"]:
                info["name"] = local
        pods.append(info)
    pods.sort(key=lambda p: (0 if p["status"] == "RUNNING" else 1, p["name"].lower()))
    return {"ok": True, "pods": pods}


@app.get("/api/pods/{pod_id}")
async def get_pod(pod_id: str):
    try:
        raw = _runpod().get_pod(pod_id)
    except Exception as e:
        raise HTTPException(502, str(e)) from e
    if not raw:
        raise HTTPException(404, f"Pod '{pod_id}' not found")
    info = summarize_pod(raw)
    if info.get("vram_gb") is None and info.get("gpu_type"):
        key = _runpod_api_key()
        if key:
            try:
                gt = info["gpu_type"]
                for g in fetch_gpu_stock(key):
                    if (
                        g.get("id") == gt
                        or g.get("display_name") == gt
                        or (g.get("display_name") or "") in gt
                        or gt.endswith(g.get("display_name") or "___")
                    ):
                        if g.get("memory_gb") is not None:
                            info["vram_gb"] = int(g["memory_gb"])
                            break
            except Exception:
                pass
    local = _local_name_map().get(pod_id)
    if local:
        info["local_name"] = local
    return {"ok": True, "pod": info}


@app.post("/api/pods")
async def create_pod(request: Request):
    """Create a new RunPod pod in a chosen datacenter (when stock allows)."""
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "JSON body required") from None

    name = str(body.get("name") or "").strip()
    gpu_type = str(body.get("gpu_type") or "").strip()
    datacenter = str(body.get("datacenter") or "").strip() or None
    cloud_type = str(body.get("cloud_type") or "COMMUNITY").strip().upper() or "COMMUNITY"
    network_volume_id = str(body.get("network_volume_id") or "").strip() or None
    image = str(body.get("image") or "").strip() or None

    if not name or len(name) > 64 or "/" in name or "\\" in name or ".." in name:
        raise HTTPException(400, "Invalid pod name")
    if not gpu_type or len(gpu_type) > 120 or "/" in gpu_type or "\\" in gpu_type:
        raise HTTPException(400, "Invalid gpu_type")
    if datacenter and (len(datacenter) > 32 or "/" in datacenter or "\\" in datacenter):
        raise HTTPException(400, "Invalid datacenter")
    if cloud_type not in ("COMMUNITY", "SECURE", "ALL"):
        raise HTTPException(400, "cloud_type must be COMMUNITY, SECURE, or ALL")
    if network_volume_id and (
        len(network_volume_id) > 64
        or "/" in network_volume_id
        or "\\" in network_volume_id
    ):
        raise HTTPException(400, "Invalid network_volume_id")

    try:
        container_disk_gb = int(body.get("container_disk_gb") or 100)
    except (TypeError, ValueError):
        raise HTTPException(400, "container_disk_gb must be an integer") from None
    if container_disk_gb < 20 or container_disk_gb > 500:
        raise HTTPException(400, "container_disk_gb must be between 20 and 500")

    try:
        raw = _runpod().create_pod(
            name=name,
            gpu_type=gpu_type,
            datacenter=datacenter,
            cloud_type=cloud_type,
            network_volume_id=network_volume_id,
            container_disk_gb=container_disk_gb,
            image=image,
        )
    except Exception as e:
        raise HTTPException(502, str(e)) from e

    info = summarize_pod(raw if isinstance(raw, dict) else {"id": "", "name": name})
    return {"ok": True, "pod": info}


@app.post("/api/pods/{pod_id}/start")
async def start_pod(pod_id: str):
    try:
        raw = _runpod().start_pod(pod_id)
    except Exception as e:
        raise HTTPException(502, str(e)) from e
    return {"ok": True, "pod": summarize_pod(raw or {"id": pod_id, "desiredStatus": "RUNNING"})}


@app.post("/api/pods/{pod_id}/stop")
async def stop_pod(pod_id: str):
    try:
        _runpod().stop_pod(pod_id)
    except Exception as e:
        raise HTTPException(502, str(e)) from e
    return {"ok": True}


@app.delete("/api/pods/{pod_id}")
async def terminate_pod(pod_id: str):
    try:
        _runpod().terminate_pod(pod_id)
    except Exception as e:
        raise HTTPException(502, str(e)) from e
    return {"ok": True}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="127.0.0.1", port=7890, reload=True)
