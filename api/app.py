from __future__ import annotations

import json
import os
import base64
import socket
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from contextlib import asynccontextmanager
from datetime import datetime
from io import BytesIO
from threading import Event, Lock, Thread
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from api import accounts, ai, image_tasks, register, system
from api.support import client_public_ip, device_fingerprint, ip_fingerprint_identity, ip_fingerprint_key, resolve_web_asset, start_limited_account_watcher
from services.config import DATA_DIR, config
from PIL import Image, ImageOps, UnidentifiedImageError

IP_IMAGE_QUOTA_LIMIT = int(os.getenv("IMAGE_PROXY_IP_QUOTA_LIMIT", "20"))
IMAGE_PROXY_BASE_URL = os.getenv("IMAGE_PROXY_BASE_URL", "http://165.154.254.130:3000").rstrip("/")
IMAGE_PROXY_TIMEOUT = int(os.getenv("IMAGE_PROXY_TIMEOUT", "240"))
IMAGE_PROXY_RETRIES = int(os.getenv("IMAGE_PROXY_RETRIES", "2"))
IMAGE_EDIT_MAX_SIDE = int(os.getenv("IMAGE_PROXY_EDIT_MAX_SIDE", "2048"))
IP_QUOTAS_PATH = DATA_DIR / "ip_image_quotas.json"
IP_IMAGE_TASKS_PATH = DATA_DIR / "ip_image_tasks.json"
IP_QUOTA_LOCK = Lock()
IP_IMAGE_TASKS_LOCK = Lock()
ACTIVE_IP_TASK_LOCK = Lock()
ACTIVE_IP_TASKS: set[str] = set()
ACTIVE_IP_TASK_OWNERS: dict[str, str] = {}


def _now_iso() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _client_ip(request: Request) -> str:
    return client_public_ip(request)


def _device_fingerprint(request: Request) -> str:
    return device_fingerprint(request)


def _quota_key(ip: str, fingerprint: str) -> str:
    return ip_fingerprint_key(ip, fingerprint)


def _proxy_authorization(request: Request) -> str:
    proxy_key = str(config.auth_key or "").strip()
    if proxy_key:
        return f"Bearer {proxy_key}"
    return request.headers.get("authorization", "")


def _ip_quota_payload(request: Request, ip: str, fingerprint: str) -> dict[str, object]:
    identity = ip_fingerprint_identity(request)
    return {
        "user_id": identity["id"],
        "ip": ip,
        "fingerprint": fingerprint,
        "limit": IP_IMAGE_QUOTA_LIMIT,
        "remaining": _remaining_ip_quota(ip, fingerprint),
    }


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


def _recall_image_item(item: Any, headers: dict[str, str]) -> Any:
    if not isinstance(item, dict):
        return item
    if item.get("b64_json"):
        return {**item, "url": ""}
    if not item.get("url"):
        return item

    request_headers = {
        key: value
        for key, value in headers.items()
        if key.lower() in {"authorization", "x-device-fingerprint", "x-forwarded-for"}
    }
    image_url = urllib.parse.urljoin(f"{IMAGE_PROXY_BASE_URL}/", str(item["url"]))
    request = urllib.request.Request(image_url, headers=request_headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=IMAGE_PROXY_TIMEOUT) as response:
            raw = response.read()
    except Exception:
        return item
    return {
        **item,
        "b64_json": base64.b64encode(raw).decode("ascii"),
        "url": "",
    }


def _recall_image_data(data: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
    items = data.get("data")
    if not isinstance(items, list):
        return data
    return {
        **data,
        "data": [_recall_image_item(item, headers) for item in items],
    }


def _stable_image_count(data: dict[str, Any]) -> int:
    items = data.get("data")
    if not isinstance(items, list):
        return 0
    return sum(1 for item in items if isinstance(item, dict) and item.get("b64_json"))


async def _read_json_object(request: Request) -> dict[str, Any]:
    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail={"error": "invalid json request body"}) from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail={"error": "invalid request body"})
    return payload


def _error_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return _error_text(value.get("message")) or _error_text(value.get("error")) or _error_text(value.get("detail"))
    return ""


def _decode_proxy_body(raw_body: bytes) -> dict[str, Any]:
    response_body = raw_body.decode("utf-8", errors="replace")
    try:
        data = json.loads(response_body or "{}")
    except Exception:
        data = {"error": response_body}
    return data if isinstance(data, dict) else {"error": response_body}


def _proxy_error_message(exc: BaseException) -> str:
    reason = getattr(exc, "reason", None)
    if reason:
        return str(reason)
    return str(exc) or exc.__class__.__name__


def _should_retry_proxy_error(status: int) -> bool:
    return status in {408, 409, 425, 429} or status >= 500


def _normalize_edit_image(file_name: str, content_type: str, content: bytes) -> tuple[str, str, bytes]:
    if not content:
        raise HTTPException(status_code=400, detail={"error": "image is empty"})

    try:
        with Image.open(BytesIO(content)) as source_image:
            image = ImageOps.exif_transpose(source_image)
            image.load()
    except (UnidentifiedImageError, OSError) as exc:
        raise HTTPException(status_code=400, detail={"error": f"image can not be loaded: {exc}"}) from exc

    width, height = image.size
    max_side = max(width, height)
    if IMAGE_EDIT_MAX_SIDE > 0 and max_side > IMAGE_EDIT_MAX_SIDE:
        scale = IMAGE_EDIT_MAX_SIDE / max_side
        next_size = (max(1, int(width * scale)), max(1, int(height * scale)))
        image = image.resize(next_size, Image.Resampling.LANCZOS)

    if image.mode not in {"RGB", "RGBA"}:
        image = image.convert("RGBA" if "A" in image.getbands() else "RGB")

    output = BytesIO()
    image.save(output, format="PNG", optimize=True)
    normalized_name = f"{os.path.splitext(file_name or 'image')[0] or 'image'}.png"
    return normalized_name, "image/png", output.getvalue()


async def _read_edit_uploads(image: list[UploadFile]) -> list[tuple[str, str, str, bytes]]:
    files: list[tuple[str, str, str, bytes]] = []
    for upload in image:
        file_name = upload.filename or "image.png"
        content_type = upload.content_type or "image/png"
        normalized_name, normalized_type, normalized_content = _normalize_edit_image(
            file_name,
            content_type,
            await upload.read(),
        )
        files.append(("image", normalized_name, normalized_type, normalized_content))
    return files


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


def _encode_task_files(files: list[tuple[str, str, str, bytes]]) -> list[dict[str, str]]:
    return [
        {
            "field_name": field_name,
            "file_name": file_name,
            "content_type": content_type,
            "content_b64": base64.b64encode(content).decode("ascii"),
        }
        for field_name, file_name, content_type, content in files
    ]


def _decode_task_files(items: Any) -> list[tuple[str, str, str, bytes]]:
    if not isinstance(items, list):
        return []
    files: list[tuple[str, str, str, bytes]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        try:
            content = base64.b64decode(str(item.get("content_b64") or ""), validate=True)
        except Exception:
            continue
        files.append(
            (
                str(item.get("field_name") or "image"),
                str(item.get("file_name") or "image.png"),
                str(item.get("content_type") or "image/png"),
                content,
            )
        )
    return files


def _load_ip_tasks() -> dict[str, dict[str, Any]]:
    try:
        data = json.loads(IP_IMAGE_TASKS_PATH.read_text(encoding="utf-8"))
    except Exception:
        data = _load_partial_ip_tasks()
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
            "ip": str(task.get("ip") or "").strip(),
            "fingerprint": str(task.get("fingerprint") or "").strip(),
            "status": status,
            "mode": "edit" if task.get("mode") == "edit" else "generate",
            "model": str(task.get("model") or "gpt-image-2").strip(),
            "size": str(task.get("size") or "").strip(),
            "created_at": str(task.get("created_at") or _now_iso()),
            "updated_at": str(task.get("updated_at") or _now_iso()),
            "data": task.get("data") if isinstance(task.get("data"), list) else None,
            "error": str(task.get("error") or "").strip(),
            "work": task.get("work") if isinstance(task.get("work"), dict) else None,
        }
    return items


def _load_partial_ip_tasks() -> dict[str, Any]:
    try:
        content = IP_IMAGE_TASKS_PATH.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return {"tasks": []}
    start = content.find("[")
    if start < 0:
        return {"tasks": []}
    decoder = json.JSONDecoder()
    index = start + 1
    tasks: list[Any] = []
    while index < len(content):
        while index < len(content) and content[index] in " \r\n\t,":
            index += 1
        if index >= len(content) or content[index] == "]":
            break
        try:
            task, index = decoder.raw_decode(content, index)
        except Exception:
            break
        if isinstance(task, dict):
            tasks.append(task)
    return {"tasks": tasks}


def _save_ip_tasks(items: dict[str, dict[str, Any]]) -> None:
    IP_IMAGE_TASKS_PATH.parent.mkdir(parents=True, exist_ok=True)
    sorted_items = sorted(items.values(), key=lambda item: str(item.get("updated_at") or ""), reverse=True)
    content = json.dumps({"tasks": sorted_items[:1000]}, ensure_ascii=False, indent=2) + "\n"
    tmp_path = IP_IMAGE_TASKS_PATH.with_name(f"{IP_IMAGE_TASKS_PATH.name}.{uuid.uuid4().hex}.tmp")
    try:
        tmp_path.write_text(content, encoding="utf-8")
        os.replace(tmp_path, IP_IMAGE_TASKS_PATH)
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except Exception:
            pass


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


def _normalize_task_headers(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    return {str(key): str(item) for key, item in value.items() if item is not None}


def _normalize_task_fields(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    return {str(key): str(item) for key, item in value.items() if item is not None}


def _queued_task_sort_key(item: tuple[str, dict[str, Any]]) -> str:
    return str(item[1].get("created_at") or item[1].get("updated_at") or "")


def _next_owner_ip_task(owner: str, exclude_task_key: str = "") -> tuple[str, dict[str, Any]] | None:
    with IP_IMAGE_TASKS_LOCK:
        items = _load_ip_tasks()
        queued = [
            (key, task)
            for key, task in items.items()
            if key != exclude_task_key
            and task.get("owner") == owner
            and task.get("status") in {"queued", "running"}
            and isinstance(task.get("work"), dict)
        ]
    if not queued:
        return None
    queued.sort(key=_queued_task_sort_key)
    return queued[0]


def _run_tracked_ip_image_task(task_key: str, task: dict[str, Any]) -> None:
    owner = str(task.get("owner") or "").strip()
    work = task.get("work") if isinstance(task.get("work"), dict) else {}
    try:
        _run_ip_image_task(
            task_key,
            ip=str(task.get("ip") or "").strip(),
            fingerprint=str(task.get("fingerprint") or "").strip(),
            count=max(1, int(work.get("count") or 1)),
            mode=str(task.get("mode") or "generate"),
            payload=work.get("payload") if isinstance(work.get("payload"), dict) else None,
            fields=_normalize_task_fields(work.get("fields")),
            files=_decode_task_files(work.get("files")),
            headers=_normalize_task_headers(work.get("headers")),
        )
    finally:
        with ACTIVE_IP_TASK_LOCK:
            ACTIVE_IP_TASKS.discard(task_key)
            if owner and ACTIVE_IP_TASK_OWNERS.get(owner) == task_key:
                ACTIVE_IP_TASK_OWNERS.pop(owner, None)
        next_task = _next_owner_ip_task(owner, exclude_task_key=task_key) if owner else None
        if next_task is not None:
            _ensure_ip_task_worker(*next_task)


def _ensure_ip_task_worker(task_key: str, task: dict[str, Any]) -> bool:
    if task.get("status") not in {"queued", "running"}:
        return False
    if not isinstance(task.get("work"), dict):
        return False
    owner = str(task.get("owner") or "").strip()
    if not owner:
        return False
    with ACTIVE_IP_TASK_LOCK:
        if task_key in ACTIVE_IP_TASKS:
            return False
        active_owner_task = ACTIVE_IP_TASK_OWNERS.get(owner)
        if active_owner_task and active_owner_task != task_key:
            return False
        ACTIVE_IP_TASKS.add(task_key)
        ACTIVE_IP_TASK_OWNERS[owner] = task_key
    Thread(
        target=_run_tracked_ip_image_task,
        args=(task_key, dict(task)),
        daemon=True,
        name=f"ip-image-task-{str(task.get('id') or '')[:16]}",
    ).start()
    return True


def _resume_ip_image_tasks() -> None:
    with IP_IMAGE_TASKS_LOCK:
        items = _load_ip_tasks()
        resumable = [
            (task_key, task)
            for task_key, task in items.items()
            if task.get("status") in {"queued", "running"} and isinstance(task.get("work"), dict)
        ]
    resumable.sort(key=lambda item: (str(item[1].get("owner") or ""), _queued_task_sort_key(item)))
    for task_key, task in resumable:
        _ensure_ip_task_worker(task_key, task)


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
        if isinstance(data, dict):
            data = _recall_image_data(data, headers)
        stable_count = _stable_image_count(data) if isinstance(data, dict) else 0
        if stable_count == 0:
            _refund_ip_quota(ip, fingerprint, usable_count)
            raise RuntimeError("image completed but image recall failed")
        if stable_count < usable_count:
            _refund_ip_quota(ip, fingerprint, usable_count - stable_count)
        _update_ip_task(task_key, status="success", data=data.get("data", []), error="", work=None)
    except Exception as exc:
        _update_ip_task(task_key, status="error", data=[], error=str(exc) or "图片生成失败", work=None)


def _proxy_image_generation(payload: dict[str, Any], headers: dict[str, str]) -> tuple[int, dict[str, Any]]:
    body = json.dumps(payload).encode("utf-8")
    for attempt in range(max(1, IMAGE_PROXY_RETRIES + 1)):
        request = urllib.request.Request(
            f"{IMAGE_PROXY_BASE_URL}/v1/images/generations",
            data=body,
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=IMAGE_PROXY_TIMEOUT) as response:
                return response.status, _decode_proxy_body(response.read())
        except urllib.error.HTTPError as exc:
            data = _decode_proxy_body(exc.read())
            if attempt < IMAGE_PROXY_RETRIES and _should_retry_proxy_error(exc.code):
                time.sleep(1 + attempt)
                continue
            return exc.code, data
        except (urllib.error.URLError, TimeoutError, socket.timeout, OSError) as exc:
            if attempt < IMAGE_PROXY_RETRIES:
                time.sleep(1 + attempt)
                continue
            return 502, {"error": f"image proxy request failed: {_proxy_error_message(exc)}"}


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
    for attempt in range(max(1, IMAGE_PROXY_RETRIES + 1)):
        request = urllib.request.Request(
            f"{IMAGE_PROXY_BASE_URL}/v1/images/edits",
            data=body,
            headers=request_headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=IMAGE_PROXY_TIMEOUT) as response:
                return response.status, _decode_proxy_body(response.read())
        except urllib.error.HTTPError as exc:
            data = _decode_proxy_body(exc.read())
            if attempt < IMAGE_PROXY_RETRIES and _should_retry_proxy_error(exc.code):
                time.sleep(1 + attempt)
                continue
            return exc.code, data
        except (urllib.error.URLError, TimeoutError, socket.timeout, OSError) as exc:
            if attempt < IMAGE_PROXY_RETRIES:
                time.sleep(1 + attempt)
                continue
            return 502, {"error": f"image edit proxy request failed: {_proxy_error_message(exc)}"}


def create_app() -> FastAPI:
    app_version = config.app_version

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        stop_event = Event()
        thread = start_limited_account_watcher(stop_event)
        config.cleanup_old_images()
        _resume_ip_image_tasks()
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
        return _ip_quota_payload(request, ip, fingerprint)

    @app.post("/api/ip-limited/quota/refund")
    async def refund_ip_quota(request: Request):
        ip = _client_ip(request)
        fingerprint = _device_fingerprint(request)
        payload = await _read_json_object(request)
        count = max(1, min(2, int(payload.get("count") or 1)))
        _refund_ip_quota(ip, fingerprint, count)
        return _ip_quota_payload(request, ip, fingerprint)

    @app.get("/api/ip-limited/image-tasks")
    async def list_ip_image_tasks(request: Request, ids: str = ""):
        ip = _client_ip(request)
        fingerprint = _device_fingerprint(request)
        owner = _quota_key(ip, fingerprint)
        requested_ids = [item.strip() for item in ids.split(",") if item.strip()]
        tasks_to_ensure: list[tuple[str, dict[str, Any]]] = []
        with IP_IMAGE_TASKS_LOCK:
            items = _load_ip_tasks()
            tasks = []
            missing_ids = []
            for task_id in requested_ids:
                task_key = f"{owner}:{task_id}"
                task = items.get(task_key)
                if task is None:
                    missing_ids.append(task_id)
                else:
                    tasks_to_ensure.append((task_key, task))
                    tasks.append(_public_ip_task(task))
            if not requested_ids:
                owner_tasks = [(key, task) for key, task in items.items() if task.get("owner") == owner]
                tasks_to_ensure.extend(owner_tasks)
                tasks = [_public_ip_task(task) for _, task in owner_tasks]
                tasks.sort(key=lambda task: str(task.get("updated_at") or ""), reverse=True)
        for task_key, task in tasks_to_ensure:
            _ensure_ip_task_worker(task_key, task)
        return {"items": tasks, "missing_ids": missing_ids}

    @app.post("/api/ip-limited/image-tasks/generations")
    async def create_ip_image_generation_task(request: Request):
        ip = _client_ip(request)
        fingerprint = _device_fingerprint(request)
        owner = _quota_key(ip, fingerprint)
        payload = await _read_json_object(request)
        task_id = str(payload.get("client_task_id") or "").strip()
        prompt = str(payload.get("prompt") or "").strip()
        if not task_id:
            raise HTTPException(status_code=400, detail={"error": "client_task_id is required"})
        if not prompt:
            raise HTTPException(status_code=400, detail={"error": "prompt is required"})

        task_key = f"{owner}:{task_id}"
        task_model = str(payload.get("model") or "gpt-image-2")
        task_size = str(payload.get("size") or "")
        generation_payload = {
            "prompt": prompt,
            "model": task_model,
            "n": 1,
            "response_format": "b64_json",
        }
        if task_size:
            generation_payload["size"] = task_size
        headers = {
            "Content-Type": "application/json",
            "Authorization": _proxy_authorization(request),
            "X-Device-Fingerprint": fingerprint,
            "X-Forwarded-For": ip,
        }
        with IP_IMAGE_TASKS_LOCK:
            items = _load_ip_tasks()
            existing = items.get(task_key)
            if existing is not None:
                if existing.get("status") in {"queued", "running"} and not isinstance(existing.get("work"), dict):
                    existing.update(
                        {
                            "ip": ip,
                            "fingerprint": fingerprint,
                            "model": task_model,
                            "size": task_size,
                            "work": {
                                "count": 1,
                                "payload": generation_payload,
                                "headers": headers,
                            },
                        }
                    )
                    items[task_key] = existing
                    _save_ip_tasks(items)
                _ensure_ip_task_worker(task_key, existing)
                return _public_ip_task(existing)
            _consume_ip_quota(ip, fingerprint, 1)
            now = _now_iso()
            task = {
                "id": task_id,
                "owner": owner,
                "ip": ip,
                "fingerprint": fingerprint,
                "status": "queued",
                "mode": "generate",
                "model": task_model,
                "size": task_size,
                "created_at": now,
                "updated_at": now,
                "data": None,
                "error": "",
                "work": {
                    "count": 1,
                    "payload": generation_payload,
                    "headers": headers,
                },
            }
            items[task_key] = task
            _save_ip_tasks(items)

        _ensure_ip_task_worker(task_key, task)
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
                if existing.get("status") not in {"queued", "running"} or isinstance(existing.get("work"), dict):
                    _ensure_ip_task_worker(task_key, existing)
                    return _public_ip_task(existing)

        files = await _read_edit_uploads(image)
        task_model = model or "gpt-image-2"
        task_size = size or ""
        fields = {
            "prompt": prompt,
            "model": task_model,
            "n": "1",
            "response_format": "b64_json",
        }
        if task_size:
            fields["size"] = task_size
        headers = {
            "Authorization": _proxy_authorization(request),
            "X-Device-Fingerprint": fingerprint,
            "X-Forwarded-For": ip,
        }

        with IP_IMAGE_TASKS_LOCK:
            items = _load_ip_tasks()
            existing = items.get(task_key)
            if existing is not None:
                if existing.get("status") in {"queued", "running"} and not isinstance(existing.get("work"), dict):
                    existing.update(
                        {
                            "ip": ip,
                            "fingerprint": fingerprint,
                            "model": task_model,
                            "size": task_size,
                            "work": {
                                "count": 1,
                                "fields": fields,
                                "files": _encode_task_files(files),
                                "headers": headers,
                            },
                        }
                    )
                    items[task_key] = existing
                    _save_ip_tasks(items)
                _ensure_ip_task_worker(task_key, existing)
                return _public_ip_task(existing)
            _consume_ip_quota(ip, fingerprint, 1)
            now = _now_iso()
            task = {
                "id": task_id,
                "owner": owner,
                "ip": ip,
                "fingerprint": fingerprint,
                "status": "queued",
                "mode": "edit",
                "model": task_model,
                "size": task_size,
                "created_at": now,
                "updated_at": now,
                "data": None,
                "error": "",
                "work": {
                    "count": 1,
                    "fields": fields,
                    "files": _encode_task_files(files),
                    "headers": headers,
                },
            }
            items[task_key] = task
            _save_ip_tasks(items)

        _ensure_ip_task_worker(task_key, task)
        return _public_ip_task(task)

    @app.post("/api/ip-limited/images/generations")
    async def ip_limited_image_generation(request: Request):
        ip = _client_ip(request)
        fingerprint = _device_fingerprint(request)
        payload = await _read_json_object(request)

        count = max(1, min(2, int(payload.get("n") or 1)))
        payload["n"] = count
        _consume_ip_quota(ip, fingerprint, count)

        headers = {
            "Content-Type": "application/json",
            "Authorization": _proxy_authorization(request),
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
            data = _recall_image_data(data, headers)
            stable_count = _stable_image_count(data)
            if stable_count == 0:
                _refund_ip_quota(ip, fingerprint, usable_count)
                return JSONResponse(status_code=502, content={"error": "image completed but image recall failed"})
            if stable_count < usable_count:
                _refund_ip_quota(ip, fingerprint, usable_count - stable_count)
            data["ip_quota"] = _ip_quota_payload(request, ip, fingerprint)
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

        files = await _read_edit_uploads(image)
        _consume_ip_quota(ip, fingerprint, count)
        fields = {
            "prompt": prompt,
            "model": model or "gpt-image-2",
            "n": str(count),
            "response_format": response_format or "b64_json",
        }
        if size:
            fields["size"] = size
        headers = {
            "Authorization": _proxy_authorization(request),
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
            data = _recall_image_data(data, headers)
            stable_count = _stable_image_count(data)
            if stable_count == 0:
                _refund_ip_quota(ip, fingerprint, usable_count)
                return JSONResponse(status_code=502, content={"error": "image completed but image recall failed"})
            if stable_count < usable_count:
                _refund_ip_quota(ip, fingerprint, usable_count - stable_count)
            data["ip_quota"] = _ip_quota_payload(request, ip, fingerprint)
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
