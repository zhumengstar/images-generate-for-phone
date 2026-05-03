from __future__ import annotations

import json
import os
import uuid
import urllib.error
import urllib.request
from contextlib import asynccontextmanager
from datetime import datetime
from threading import Event, Lock, Thread
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from api import accounts, ai, image_tasks, register, system
from api.support import resolve_web_asset, start_limited_account_watcher
from services.config import DATA_DIR, config

IP_IMAGE_QUOTA_LIMIT = int(os.getenv("IMAGE_PROXY_IP_QUOTA_LIMIT", "20"))
IMAGE_PROXY_BASE_URL = os.getenv("IMAGE_PROXY_BASE_URL", "http://165.154.254.130:3000").rstrip("/")
IP_QUOTAS_PATH = DATA_DIR / "ip_image_quotas.json"
IP_IMAGE_TASKS_PATH = DATA_DIR / "ip_image_tasks.json"
IP_QUOTA_LOCK = Lock()
IP_IMAGE_TASKS_LOCK = Lock()


def _now_iso() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _client_ip(request: Request) -> str:
    cf_ip = request.headers.get("cf-connecting-ip", "").strip()
    if cf_ip:
        return cf_ip
    forwarded_for = request.headers.get("x-forwarded-for", "")
    if forwarded_for:
        return forwarded_for.split(",", 1)[0].strip()
    real_ip = request.headers.get("x-real-ip", "").strip()
    if real_ip:
        return real_ip
    return request.client.host if request.client else "unknown"


def _device_fingerprint(request: Request) -> str:
    fingerprint = request.headers.get("x-device-fingerprint", "").strip()
    return fingerprint or "unknown"


def _quota_key(ip: str, fingerprint: str) -> str:
    return f"{ip}|{fingerprint}"


def _load_ip_quotas() -> dict[str, int]:
    try:
        data = json.loads(IP_QUOTAS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    return {str(key): max(0, int(value or 0)) for key, value in data.items()}


def _save_ip_quotas(items: dict[str, int]) -> None:
    IP_QUOTAS_PATH.parent.mkdir(parents=True, exist_ok=True)
    IP_QUOTAS_PATH.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")


def _consume_ip_quota(ip: str, fingerprint: str, count: int) -> int:
    with IP_QUOTA_LOCK:
        items = _load_ip_quotas()
        key = _quota_key(ip, fingerprint)
        used = max(0, int(items.get(key, 0)))
        remaining = max(0, IP_IMAGE_QUOTA_LIMIT - used)
        if count > remaining:
            raise HTTPException(
                status_code=429,
                detail={"error": f"当前公网 IP + 浏览器指纹剩余额度不足，还剩 {remaining} 张"},
            )
        items[key] = used + count
        _save_ip_quotas(items)
        return max(0, IP_IMAGE_QUOTA_LIMIT - items[key])


def _refund_ip_quota(ip: str, fingerprint: str, count: int) -> None:
    with IP_QUOTA_LOCK:
        items = _load_ip_quotas()
        key = _quota_key(ip, fingerprint)
        items[key] = max(0, int(items.get(key, 0)) - count)
        _save_ip_quotas(items)


def _remaining_ip_quota(ip: str, fingerprint: str) -> int:
    with IP_QUOTA_LOCK:
        used = _load_ip_quotas().get(_quota_key(ip, fingerprint), 0)
        return max(0, IP_IMAGE_QUOTA_LIMIT - used)


def _usable_image_count(data: dict[str, Any]) -> int:
    items = data.get("data")
    if not isinstance(items, list):
        return 0
    return sum(
        1
        for item in items
        if isinstance(item, dict) and (item.get("b64_json") or item.get("url"))
    )


def _error_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return _error_text(value.get("message")) or _error_text(value.get("error")) or _error_text(value.get("detail"))
    return ""


def _public_ip_task(task: dict[str, Any]) -> dict[str, Any]:
    item = {
        "id": task.get("id"),
        "status": task.get("status"),
        "mode": task.get("mode"),
        "model": task.get("model"),
        "size": task.get("size"),
        "created_at": task.get("created_at"),
        "updated_at": task.get("updated_at"),
    }
    if task.get("data") is not None:
        item["data"] = task.get("data")
    if task.get("error"):
        item["error"] = task.get("error")
    return item


def _load_ip_tasks() -> dict[str, dict[str, Any]]:
    try:
        data = json.loads(IP_IMAGE_TASKS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}
    raw_items = data.get("tasks") if isinstance(data, dict) else data
    if not isinstance(raw_items, list):
        return {}
    items: dict[str, dict[str, Any]] = {}
    for task in raw_items:
        if not isinstance(task, dict):
            continue
        task_id = str(task.get("id") or "").strip()
        owner = str(task.get("owner") or "").strip()
        if not task_id or not owner:
            continue
        status = str(task.get("status") or "").strip()
        if status not in {"queued", "running", "success", "error"}:
            status = "error"
        items[f"{owner}:{task_id}"] = {
            "id": task_id,
            "owner": owner,
            "status": status,
            "mode": "edit" if task.get("mode") == "edit" else "generate",
            "model": str(task.get("model") or "gpt-image-2").strip(),
            "size": str(task.get("size") or "").strip(),
            "created_at": str(task.get("created_at") or _now_iso()),
            "updated_at": str(task.get("updated_at") or _now_iso()),
            "data": task.get("data") if isinstance(task.get("data"), list) else None,
            "error": str(task.get("error") or "").strip(),
        }
    return items


def _save_ip_tasks(items: dict[str, dict[str, Any]]) -> None:
    IP_IMAGE_TASKS_PATH.parent.mkdir(parents=True, exist_ok=True)
    sorted_items = sorted(items.values(), key=lambda item: str(item.get("updated_at") or ""), reverse=True)
    IP_IMAGE_TASKS_PATH.write_text(
        json.dumps({"tasks": sorted_items[:1000]}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _update_ip_task(task_key: str, **updates: Any) -> None:
    with IP_IMAGE_TASKS_LOCK:
        items = _load_ip_tasks()
        task = items.get(task_key)
        if task is None:
            return
        task.update(updates)
        task["updated_at"] = _now_iso()
        items[task_key] = task
        _save_ip_tasks(items)


def _run_ip_image_task(
    task_key: str,
    *,
    ip: str,
    fingerprint: str,
    count: int,
    mode: str,
    payload: dict[str, Any] | None = None,
    fields: dict[str, str] | None = None,
    files: list[tuple[str, str, str, bytes]] | None = None,
    headers: dict[str, str],
) -> None:
    _update_ip_task(task_key, status="running", error="")
    try:
        if mode == "edit":
            status, data = _proxy_image_edit(fields or {}, files or [], headers)
        else:
            status, data = _proxy_image_generation(payload or {}, headers)
        if status >= 400:
            _refund_ip_quota(ip, fingerprint, count)
            message = _error_text(data) if isinstance(data, dict) else ""
            raise RuntimeError(message or f"图片生成失败 ({status})")
        usable_count = _usable_image_count(data) if isinstance(data, dict) else 0
        if usable_count < count:
            _refund_ip_quota(ip, fingerprint, count - usable_count)
        if usable_count == 0:
            raise RuntimeError("接口没有返回图片数据")
        _update_ip_task(task_key, status="success", data=data.get("data", []), error="")
    except Exception as exc:
        _update_ip_task(task_key, status="error", data=[], error=str(exc) or "图片生成失败")


def _proxy_image_generation(payload: dict[str, Any], headers: dict[str, str]) -> tuple[int, dict[str, Any]]:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{IMAGE_PROXY_BASE_URL}/v1/images/generations",
        data=body,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            response_body = response.read().decode("utf-8")
            return response.status, json.loads(response_body or "{}")
    except urllib.error.HTTPError as exc:
        response_body = exc.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(response_body or "{}")
        except Exception:
            data = {"error": response_body or str(exc)}
        return exc.code, data


def _build_multipart_body(fields: dict[str, str], files: list[tuple[str, str, str, bytes]]) -> tuple[str, bytes]:
    boundary = f"----imagesgenerate{uuid.uuid4().hex}"
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.extend(
            [
                f"--{boundary}\r\n".encode("utf-8"),
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"),
                str(value).encode("utf-8"),
                b"\r\n",
            ]
        )
    for field_name, file_name, content_type, content in files:
        chunks.extend(
            [
                f"--{boundary}\r\n".encode("utf-8"),
                (
                    f'Content-Disposition: form-data; name="{field_name}"; '
                    f'filename="{file_name or "image.png"}"\r\n'
                ).encode("utf-8"),
                f"Content-Type: {content_type or 'image/png'}\r\n\r\n".encode("utf-8"),
                content,
                b"\r\n",
            ]
        )
    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
    return f"multipart/form-data; boundary={boundary}", b"".join(chunks)


def _proxy_image_edit(fields: dict[str, str], files: list[tuple[str, str, str, bytes]], headers: dict[str, str]) -> tuple[int, dict[str, Any]]:
    content_type, body = _build_multipart_body(fields, files)
    request_headers = {**headers, "Content-Type": content_type}
    request = urllib.request.Request(
        f"{IMAGE_PROXY_BASE_URL}/v1/images/edits",
        data=body,
        headers=request_headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            response_body = response.read().decode("utf-8")
            return response.status, json.loads(response_body or "{}")
    except urllib.error.HTTPError as exc:
        response_body = exc.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(response_body or "{}")
        except Exception:
            data = {"error": response_body or str(exc)}
        return exc.code, data


def create_app() -> FastAPI:
    app_version = config.app_version

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        stop_event = Event()
        thread = start_limited_account_watcher(stop_event)
        config.cleanup_old_images()
        try:
            yield
        finally:
            stop_event.set()
            thread.join(timeout=1)

    app = FastAPI(title="images-generate", version=app_version, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(ai.create_router())
    app.include_router(accounts.create_router())
    app.include_router(image_tasks.create_router())
    app.include_router(register.create_router())
    app.include_router(system.create_router(app_version))
    if config.images_dir.exists():
        app.mount("/images", StaticFiles(directory=str(config.images_dir)), name="images")

    @app.get("/api/ip-limited/quota")
    async def get_ip_quota(request: Request):
        ip = _client_ip(request)
        fingerprint = _device_fingerprint(request)
        return {
            "ip": ip,
            "fingerprint": fingerprint,
            "limit": IP_IMAGE_QUOTA_LIMIT,
            "remaining": _remaining_ip_quota(ip, fingerprint),
        }

    @app.post("/api/ip-limited/quota/refund")
    async def refund_ip_quota(request: Request):
        ip = _client_ip(request)
        fingerprint = _device_fingerprint(request)
        payload = await request.json()
        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail={"error": "invalid request body"})
        count = max(1, min(2, int(payload.get("count") or 1)))
        _refund_ip_quota(ip, fingerprint, count)
        return {
            "ip": ip,
            "fingerprint": fingerprint,
            "limit": IP_IMAGE_QUOTA_LIMIT,
            "remaining": _remaining_ip_quota(ip, fingerprint),
        }

    @app.get("/api/ip-limited/image-tasks")
    async def list_ip_image_tasks(request: Request, ids: str = ""):
        ip = _client_ip(request)
        fingerprint = _device_fingerprint(request)
        owner = _quota_key(ip, fingerprint)
        requested_ids = [item.strip() for item in ids.split(",") if item.strip()]
        with IP_IMAGE_TASKS_LOCK:
            items = _load_ip_tasks()
            tasks = []
            missing_ids = []
            for task_id in requested_ids:
                task = items.get(f"{owner}:{task_id}")
                if task is None:
                    missing_ids.append(task_id)
                else:
                    tasks.append(_public_ip_task(task))
            if not requested_ids:
                tasks = [_public_ip_task(task) for task in items.values() if task.get("owner") == owner]
                tasks.sort(key=lambda task: str(task.get("updated_at") or ""), reverse=True)
        return {"items": tasks, "missing_ids": missing_ids}

    @app.post("/api/ip-limited/image-tasks/generations")
    async def create_ip_image_generation_task(request: Request):
        ip = _client_ip(request)
        fingerprint = _device_fingerprint(request)
        owner = _quota_key(ip, fingerprint)
        payload = await request.json()
        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail={"error": "invalid request body"})
        task_id = str(payload.get("client_task_id") or "").strip()
        prompt = str(payload.get("prompt") or "").strip()
        if not task_id:
            raise HTTPException(status_code=400, detail={"error": "client_task_id is required"})
        if not prompt:
            raise HTTPException(status_code=400, detail={"error": "prompt is required"})

        task_key = f"{owner}:{task_id}"
        with IP_IMAGE_TASKS_LOCK:
            items = _load_ip_tasks()
            existing = items.get(task_key)
            if existing is not None:
                return _public_ip_task(existing)
            _consume_ip_quota(ip, fingerprint, 1)
            now = _now_iso()
            task = {
                "id": task_id,
                "owner": owner,
                "status": "queued",
                "mode": "generate",
                "model": str(payload.get("model") or "gpt-image-2"),
                "size": str(payload.get("size") or ""),
                "created_at": now,
                "updated_at": now,
                "data": None,
                "error": "",
            }
            items[task_key] = task
            _save_ip_tasks(items)

        generation_payload = {
            "prompt": prompt,
            "model": task["model"],
            "n": 1,
            "response_format": "b64_json",
        }
        if task["size"]:
            generation_payload["size"] = task["size"]
        headers = {
            "Content-Type": "application/json",
            "Authorization": request.headers.get("authorization", ""),
            "X-Device-Fingerprint": fingerprint,
            "X-Forwarded-For": ip,
        }
        Thread(
            target=_run_ip_image_task,
            kwargs={
                "task_key": task_key,
                "ip": ip,
                "fingerprint": fingerprint,
                "count": 1,
                "mode": "generate",
                "payload": generation_payload,
                "headers": headers,
            },
            daemon=True,
            name=f"ip-image-task-{task_id[:16]}",
        ).start()
        return _public_ip_task(task)

    @app.post("/api/ip-limited/image-tasks/edits")
    async def create_ip_image_edit_task(
        request: Request,
        image: list[UploadFile] = File(...),
        client_task_id: str = Form(...),
        prompt: str = Form(...),
        model: str = Form("gpt-image-2"),
        size: str = Form(""),
    ):
        ip = _client_ip(request)
        fingerprint = _device_fingerprint(request)
        owner = _quota_key(ip, fingerprint)
        task_id = client_task_id.strip()
        if not task_id:
            raise HTTPException(status_code=400, detail={"error": "client_task_id is required"})
        if not prompt.strip():
            raise HTTPException(status_code=400, detail={"error": "prompt is required"})
        if not image:
            raise HTTPException(status_code=400, detail={"error": "image is required"})

        task_key = f"{owner}:{task_id}"
        with IP_IMAGE_TASKS_LOCK:
            items = _load_ip_tasks()
            existing = items.get(task_key)
            if existing is not None:
                return _public_ip_task(existing)
            _consume_ip_quota(ip, fingerprint, 1)
            now = _now_iso()
            task = {
                "id": task_id,
                "owner": owner,
                "status": "queued",
                "mode": "edit",
                "model": model or "gpt-image-2",
                "size": size or "",
                "created_at": now,
                "updated_at": now,
                "data": None,
                "error": "",
            }
            items[task_key] = task
            _save_ip_tasks(items)

        files = [
            ("image", upload.filename or "image.png", upload.content_type or "image/png", await upload.read())
            for upload in image
        ]
        fields = {
            "prompt": prompt,
            "model": model or "gpt-image-2",
            "n": "1",
            "response_format": "b64_json",
        }
        if size:
            fields["size"] = size
        headers = {
            "Authorization": request.headers.get("authorization", ""),
            "X-Device-Fingerprint": fingerprint,
            "X-Forwarded-For": ip,
        }
        Thread(
            target=_run_ip_image_task,
            kwargs={
                "task_key": task_key,
                "ip": ip,
                "fingerprint": fingerprint,
                "count": 1,
                "mode": "edit",
                "fields": fields,
                "files": files,
                "headers": headers,
            },
            daemon=True,
            name=f"ip-image-task-{task_id[:16]}",
        ).start()
        return _public_ip_task(task)

    @app.post("/api/ip-limited/images/generations")
    async def ip_limited_image_generation(request: Request):
        ip = _client_ip(request)
        fingerprint = _device_fingerprint(request)
        payload = await request.json()
        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail={"error": "invalid request body"})

        count = max(1, min(2, int(payload.get("n") or 1)))
        payload["n"] = count
        _consume_ip_quota(ip, fingerprint, count)

        headers = {
            "Content-Type": "application/json",
            "Authorization": request.headers.get("authorization", ""),
            "X-Device-Fingerprint": fingerprint,
            "X-Forwarded-For": ip,
        }
        status, data = _proxy_image_generation(payload, headers)
        if status >= 400:
            _refund_ip_quota(ip, fingerprint, count)
            return JSONResponse(status_code=status, content=data)
        usable_count = _usable_image_count(data) if isinstance(data, dict) else 0
        if usable_count < count:
            _refund_ip_quota(ip, fingerprint, count - usable_count)
        if usable_count == 0:
            return JSONResponse(status_code=502, content={"error": "图片生成失败，接口没有返回图片数据"})
        if isinstance(data, dict):
            data["ip_quota"] = {
                "ip": ip,
                "fingerprint": fingerprint,
                "limit": IP_IMAGE_QUOTA_LIMIT,
                "remaining": _remaining_ip_quota(ip, fingerprint),
            }
        return JSONResponse(status_code=status, content=data)

    @app.post("/api/ip-limited/images/edits")
    async def ip_limited_image_edit(
        request: Request,
        image: list[UploadFile] = File(...),
        prompt: str = Form(""),
        model: str = Form("gpt-image-2"),
        size: str = Form(""),
        n: int = Form(1),
        response_format: str = Form("b64_json"),
    ):
        ip = _client_ip(request)
        fingerprint = _device_fingerprint(request)
        count = max(1, min(2, int(n or 1)))
        if not prompt.strip():
            raise HTTPException(status_code=400, detail={"error": "prompt is required"})
        if not image:
            raise HTTPException(status_code=400, detail={"error": "image is required"})

        _consume_ip_quota(ip, fingerprint, count)
        files = [
            ("image", upload.filename or "image.png", upload.content_type or "image/png", await upload.read())
            for upload in image
        ]
        fields = {
            "prompt": prompt,
            "model": model or "gpt-image-2",
            "n": str(count),
            "response_format": response_format or "b64_json",
        }
        if size:
            fields["size"] = size
        headers = {
            "Authorization": request.headers.get("authorization", ""),
            "X-Device-Fingerprint": fingerprint,
            "X-Forwarded-For": ip,
        }
        status, data = _proxy_image_edit(fields, files, headers)
        if status >= 400:
            _refund_ip_quota(ip, fingerprint, count)
            return JSONResponse(status_code=status, content=data)
        usable_count = _usable_image_count(data) if isinstance(data, dict) else 0
        if usable_count < count:
            _refund_ip_quota(ip, fingerprint, count - usable_count)
        if usable_count == 0:
            return JSONResponse(status_code=502, content={"error": "图片编辑失败，接口没有返回图片数据"})
        if isinstance(data, dict):
            data["ip_quota"] = {
                "ip": ip,
                "fingerprint": fingerprint,
                "limit": IP_IMAGE_QUOTA_LIMIT,
                "remaining": _remaining_ip_quota(ip, fingerprint),
            }
        return JSONResponse(status_code=status, content=data)

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_web(full_path: str):
        asset = resolve_web_asset(full_path)
        if asset is not None:
            return FileResponse(asset)
        if full_path.strip("/").startswith("_next/"):
            raise HTTPException(status_code=404, detail="Not Found")
        fallback = resolve_web_asset("")
        if fallback is None:
            raise HTTPException(status_code=404, detail="Not Found")
        return FileResponse(fallback)

    return app
