"""Thin RunPod client for the dashboard (REST + GraphQL).

Uses curl --noproxy so corporate HTTP proxies do not break API calls.
"""

from __future__ import annotations

import json
import subprocess
from typing import Any
from urllib.parse import urlencode

BASE_URL = "https://rest.runpod.io/v1"
GRAPHQL_URL = "https://api.runpod.io/graphql"
_TIMEOUT = 30

DEFAULT_IMAGE = "ghcr.io/kosinkadink/comfy-runner:latest"
DEFAULT_PORTS = ["8188/http", "9189/http"]
DEFAULT_CUDA_VERSIONS = ["13.0"]


def _curl_json(
    method: str,
    url: str,
    *,
    api_key: str,
    json_body: Any = None,
    timeout: int = _TIMEOUT,
) -> Any:
    cmd = [
        "curl", "-sS", "-X", method,
        "-H", f"Authorization: Bearer {api_key}",
        "-H", "Content-Type: application/json",
        "-w", "\n__STATUS__%{http_code}",
        "--max-time", str(timeout),
        "--noproxy", "*",
        url,
    ]
    body_bytes = None
    if json_body is not None:
        body_bytes = json.dumps(json_body).encode()
        cmd = [
            "curl", "-sS", "-X", method,
            "-H", f"Authorization: Bearer {api_key}",
            "-H", "Content-Type: application/json",
            "--data-binary", "@-",
            "-w", "\n__STATUS__%{http_code}",
            "--max-time", str(timeout),
            "--noproxy", "*",
            url,
        ]

    try:
        result = subprocess.run(
            cmd, input=body_bytes, capture_output=True, timeout=timeout + 5,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"RunPod API timed out ({url})") from exc
    except FileNotFoundError as exc:
        raise RuntimeError("curl not found in PATH") from exc

    raw = result.stdout
    if b"\n__STATUS__" in raw:
        body_part, status_part = raw.rsplit(b"\n__STATUS__", 1)
        try:
            status_code = int(status_part.strip())
        except ValueError:
            status_code = 502
    else:
        body_part = raw
        status_code = 200 if result.returncode == 0 else 502
        if result.returncode != 0 and result.stderr:
            raise RuntimeError(
                f"Failed to reach RunPod API ({url}): {result.stderr.decode()[:300]}"
            )

    if status_code == 204:
        return None
    text = body_part.decode("utf-8", errors="replace")
    if 200 <= status_code < 300:
        if not text.strip():
            return None
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"Invalid JSON from RunPod: {text[:200]}") from exc
    raise RuntimeError(f"RunPod API {status_code} on {method} {url}: {text[:500]}")


def graphql(api_key: str, query: str, variables: dict | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"query": query}
    if variables is not None:
        payload["variables"] = variables
    data = _curl_json("POST", GRAPHQL_URL, api_key=api_key, json_body=payload)
    if not isinstance(data, dict):
        raise RuntimeError("RunPod GraphQL returned unexpected payload")
    if data.get("errors"):
        raise RuntimeError(f"RunPod GraphQL error: {data['errors']!r}"[:400])
    return data.get("data") or {}


class RunPodClient:
    def __init__(self, api_key: str) -> None:
        self.api_key = api_key

    def _request(self, method: str, path: str, *, params: dict | None = None, json_body: Any = None) -> Any:
        url = f"{BASE_URL}{path}"
        if params:
            url = f"{url}?{urlencode(params)}"
        return _curl_json(method, url, api_key=self.api_key, json_body=json_body)

    def list_pods(self) -> list[dict[str, Any]]:
        return self._request("GET", "/pods", params={"includeMachine": "true"}) or []

    def get_pod(self, pod_id: str) -> dict[str, Any] | None:
        return self._request(
            "GET", f"/pods/{pod_id}", params={"includeMachine": "true"},
        )

    def start_pod(self, pod_id: str) -> dict[str, Any]:
        return self._request("POST", f"/pods/{pod_id}/start")

    def stop_pod(self, pod_id: str) -> None:
        self._request("POST", f"/pods/{pod_id}/stop")

    def terminate_pod(self, pod_id: str) -> None:
        self._request("DELETE", f"/pods/{pod_id}")

    def list_volumes(self) -> list[dict[str, Any]]:
        return self._request("GET", "/networkvolumes") or []

    def create_volume(self, *, name: str, size_gb: int, datacenter: str) -> dict[str, Any]:
        return self._request(
            "POST",
            "/networkvolumes",
            json_body={
                "name": name,
                "size": size_gb,
                "dataCenterId": datacenter,
            },
        )

    def create_pod(
        self,
        *,
        name: str,
        gpu_type: str,
        datacenter: str | None = None,
        cloud_type: str = "COMMUNITY",
        network_volume_id: str | None = None,
        container_disk_gb: int = 100,
        image: str | None = None,
        allowed_cuda_versions: list[str] | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "name": name,
            "gpuTypeIds": [gpu_type],
            "gpuCount": 1,
            "imageName": image or DEFAULT_IMAGE,
            "ports": list(DEFAULT_PORTS),
            "containerDiskInGb": container_disk_gb,
            "volumeMountPath": "/workspace",
            "cloudType": cloud_type,
            "allowedCudaVersions": allowed_cuda_versions or list(DEFAULT_CUDA_VERSIONS),
        }
        if datacenter:
            body["dataCenterIds"] = [datacenter]
        if network_volume_id:
            body["networkVolumeId"] = network_volume_id
        return self._request("POST", "/pods", json_body=body)


def format_pod_proxy_url(pod_id: str, port: int) -> str:
    return f"https://{pod_id}-{port}.proxy.runpod.net"


def fetch_account(api_key: str) -> dict[str, Any]:
    """Fetch balance / spend via RunPod GraphQL ``myself``."""
    data = graphql(
        api_key,
        "{ myself { clientBalance currentSpendPerHr spendLimit notifyLowBalance } }",
    )
    myself = data.get("myself") or {}
    if not myself:
        raise RuntimeError("RunPod GraphQL returned no myself payload")
    balance = myself.get("clientBalance")
    spend = myself.get("currentSpendPerHr")
    limit = myself.get("spendLimit")
    return {
        "balance_usd": float(balance) if balance is not None else None,
        "spend_per_hr_usd": float(spend) if spend is not None else None,
        "spend_limit_usd": float(limit) if limit is not None else None,
        "notify_low_balance": bool(myself.get("notifyLowBalance")),
    }


def fetch_gpu_stock(api_key: str, *, gpu_id: str | None = None) -> list[dict[str, Any]]:
    """Return GPU types with global stock + per-datacenter availability.

    RunPod does not expose a REST stock endpoint; GraphQL ``gpuTypes`` +
    ``dataCenters.gpuAvailability`` is the same data the console uses.
    """
    gpus_data = graphql(
        api_key,
        """
        {
          gpuTypes {
            id displayName memoryInGb
            communityPrice securePrice communityCloud secureCloud
            lowestPrice(input: { gpuCount: 1 }) {
              stockStatus uninterruptablePrice minimumBidPrice
            }
          }
        }
        """,
    )
    dcs_data = graphql(
        api_key,
        """
        {
          dataCenters {
            id name location listed
            gpuAvailability { gpuTypeId available stockStatus }
          }
        }
        """,
    )

    dc_by_gpu: dict[str, list[dict[str, Any]]] = {}
    for dc in dcs_data.get("dataCenters") or []:
        for ga in dc.get("gpuAvailability") or []:
            if not ga:
                continue
            gid = ga.get("gpuTypeId") or ""
            if not gid:
                continue
            if ga.get("available") is not True and not ga.get("stockStatus"):
                continue
            dc_by_gpu.setdefault(gid, []).append({
                "id": dc.get("id") or "",
                "name": dc.get("name") or dc.get("id") or "",
                "location": dc.get("location") or "",
                "available": bool(ga.get("available")),
                "stock": ga.get("stockStatus") or (
                    "Available" if ga.get("available") else "Unavailable"
                ),
            })

    out: list[dict[str, Any]] = []
    for g in gpus_data.get("gpuTypes") or []:
        gid = g.get("id") or ""
        if not gid:
            continue
        if gpu_id and gid != gpu_id and (g.get("displayName") or "") != gpu_id:
            continue
        lp = g.get("lowestPrice") or {}
        stock = lp.get("stockStatus") or "Unavailable"
        price = lp.get("uninterruptablePrice")
        if price is None:
            price = g.get("communityPrice")
        dcs = sorted(
            dc_by_gpu.get(gid, []),
            key=lambda d: (
                0 if d["available"] else 1,
                {"High": 0, "Medium": 1, "Low": 2}.get(d["stock"], 3),
                d["id"],
            ),
        )
        out.append({
            "id": gid,
            "display_name": g.get("displayName") or gid,
            "memory_gb": g.get("memoryInGb"),
            "community_price": g.get("communityPrice"),
            "secure_price": g.get("securePrice"),
            "community_cloud": bool(g.get("communityCloud")),
            "secure_cloud": bool(g.get("secureCloud")),
            "stock": stock,
            "price_usd": float(price) if price is not None else None,
            "datacenters": dcs,
            "available_dc_count": sum(1 for d in dcs if d["available"]),
        })

    stock_rank = {"High": 0, "Medium": 1, "Low": 2, "Unavailable": 9}
    out.sort(key=lambda x: (
        stock_rank.get(x["stock"], 5),
        -(x["available_dc_count"] or 0),
        x["display_name"].lower(),
    ))
    return out


def summarize_volume(raw: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": raw.get("id") or "",
        "name": raw.get("name") or raw.get("id") or "",
        "size_gb": raw.get("size") or raw.get("sizeInGb") or 0,
        "datacenter": raw.get("dataCenterId") or raw.get("datacenterId") or "",
    }


# Common RunPod GPU display / id → VRAM (GB). Used when the pod payload
# has no machine.gpuType (typical for EXITED pods).
_VRAM_GB_BY_GPU: dict[str, int] = {
    "NVIDIA GeForce RTX 5090": 32,
    "RTX 5090": 32,
    "NVIDIA GeForce RTX 5080": 16,
    "RTX 5080": 16,
    "NVIDIA GeForce RTX 4090": 24,
    "RTX 4090": 24,
    "NVIDIA GeForce RTX 4080 SUPER": 16,
    "RTX 4080 SUPER": 16,
    "NVIDIA GeForce RTX 3090": 24,
    "RTX 3090": 24,
    "NVIDIA RTX A6000": 48,
    "NVIDIA A100 80GB PCIe": 80,
    "NVIDIA A100-SXM4-80GB": 80,
    "A100 PCIe": 80,
    "A100 SXM": 80,
    "NVIDIA H100 PCIe": 80,
    "NVIDIA H100 80GB HBM3": 80,
    "H100 PCIe": 80,
    "H100 SXM": 80,
    "NVIDIA L40S": 48,
    "L40S": 48,
    "NVIDIA L4": 24,
    "L4": 24,
    "NVIDIA RTX PRO 6000": 96,
    "RTX PRO 6000": 96,
}


def _lookup_vram_gb(gpu_type: str, machine: dict[str, Any] | None = None) -> int | None:
    machine = machine or {}
    gpu_obj = machine.get("gpuType") or {}
    for key in ("memoryInGb", "memoryInGB", "vramGb", "vram"):
        val = gpu_obj.get(key) if isinstance(gpu_obj, dict) else None
        if val is None:
            val = machine.get(key)
        if val is not None:
            try:
                return int(float(val))
            except (TypeError, ValueError):
                pass
    if not gpu_type:
        return None
    if gpu_type in _VRAM_GB_BY_GPU:
        return _VRAM_GB_BY_GPU[gpu_type]
    short = gpu_type.replace("NVIDIA GeForce ", "").replace("NVIDIA ", "")
    if short in _VRAM_GB_BY_GPU:
        return _VRAM_GB_BY_GPU[short]
    for key, gb in _VRAM_GB_BY_GPU.items():
        if key in gpu_type or gpu_type in key:
            return gb
    return None


def summarize_pod(raw: dict[str, Any]) -> dict[str, Any]:
    """Normalize a RunPod pod payload for the dashboard UI."""
    pod_id = raw.get("id") or ""
    machine = raw.get("machine") or {}
    gpu_ids = raw.get("gpuTypeIds") or []
    gpu_type = (
        machine.get("gpuTypeId")
        or (machine.get("gpuType") or {}).get("displayName")
        or (machine.get("gpuType") or {}).get("id")
        or raw.get("gpuTypeId")
        or (gpu_ids[0] if gpu_ids else "")
        or ""
    )
    status = raw.get("desiredStatus") or raw.get("status") or "UNKNOWN"
    vram_gb = _lookup_vram_gb(str(gpu_type), machine if isinstance(machine, dict) else {})
    return {
        "id": pod_id,
        "name": raw.get("name") or pod_id,
        "status": status,
        "gpu_type": gpu_type,
        "vram_gb": vram_gb,
        "cost_per_hr": float(raw.get("costPerHr") or 0),
        "datacenter": (
            machine.get("dataCenterId")
            or machine.get("location")
            or raw.get("dataCenterId")
            or ""
        ),
        "machine_id": raw.get("machineId") or machine.get("machineId") or "",
        "image": raw.get("imageName") or raw.get("image") or "",
        "network_volume_id": raw.get("networkVolumeId") or "",
        "server_url": format_pod_proxy_url(pod_id, 9189) if pod_id else "",
        "comfy_url": format_pod_proxy_url(pod_id, 8188) if pod_id else "",
        "server_host": f"{pod_id}-9189.proxy.runpod.net" if pod_id else "",
    }
