from __future__ import annotations

import json
import os

from fastapi import APIRouter, Header, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, ConfigDict

from api.support import extract_bearer_token, ip_fingerprint_identity, require_admin, require_identity, resolve_image_base_url
from services.config import DATA_DIR, config
from services.image_service import delete_images, list_images
from services.log_service import log_service
from services.proxy_service import test_proxy
from services.web_user_service import web_user_service

IP_QUOTAS_PATH = DATA_DIR / "ip_image_quotas.json"
GUEST_IMAGE_QUOTA_LIMIT = int(os.getenv("IMAGE_PROXY_GUEST_QUOTA_LIMIT", "5"))
USER_IMAGE_QUOTA_LIMIT = int(os.getenv("IMAGE_PROXY_USER_QUOTA_LIMIT", os.getenv("IMAGE_PROXY_IP_QUOTA_LIMIT", "20")))


class SettingsUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="allow")


class ProxyTestRequest(BaseModel):
    url: str = ""


class ImageDeleteRequest(BaseModel):
    paths: list[str] = []
    start_date: str = ""
    end_date: str = ""
    all_matching: bool = False


class WebUserQuotaUpdateRequest(BaseModel):
    quota_limit: int


def _load_ip_quotas() -> dict[str, int]:
    try:
        data = json.loads(IP_QUOTAS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    items: dict[str, int] = {}
    for key, value in data.items():
        try:
            items[str(key)] = max(0, int(value or 0))
        except (TypeError, ValueError):
            continue
    return items


def _save_ip_quotas(items: dict[str, int]) -> None:
    IP_QUOTAS_PATH.parent.mkdir(parents=True, exist_ok=True)
    IP_QUOTAS_PATH.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")


def _migrate_guest_quota_to_user(user_id: str, device_fingerprint: str) -> int:
    normalized_user_id = str(user_id or "").strip()
    normalized_device = str(device_fingerprint or "").strip()
    if not normalized_user_id or not normalized_device:
        return 0
    items = _load_ip_quotas()
    user_key = f"user|{normalized_user_id}|{normalized_device}"
    migrated = 0
    for key in list(items):
        if key.startswith("user|") or "|" not in key or key.rsplit("|", 1)[-1] != normalized_device:
            continue
        migrated += max(0, int(items.get(key, 0)))
        items.pop(key, None)
    if migrated:
        items[user_key] = max(0, int(items.get(user_key, 0))) + migrated
        _save_ip_quotas(items)
    return migrated


def _reset_quota_usage_for_web_user(user_id: str) -> int:
    target = web_user_service.quota_usage_target(user_id)
    items = _load_ip_quotas()
    removed = 0
    if target["role"] == "user":
        prefix = f"user|{target['id']}|"
        for key in list(items):
            if key.startswith(prefix):
                items.pop(key, None)
                removed += 1
    elif target["role"] == "guest":
        fingerprint = target.get("device_fingerprint", "")
        if fingerprint:
            for key in list(items):
                if key.startswith("user|") or "|" not in key or key.rsplit("|", 1)[-1] != fingerprint:
                    continue
                items.pop(key, None)
                removed += 1
    if removed:
        _save_ip_quotas(items)
    return removed


def create_router(app_version: str) -> APIRouter:
    router = APIRouter()

    @router.post("/auth/login")
    async def login(request: Request, authorization: str | None = Header(default=None)):
        body = {}
        try:
            parsed = await request.json()
            body = parsed if isinstance(parsed, dict) else {}
        except Exception:
            body = {}
        username = str(body.get("username") or "").strip()
        password = str(body.get("password") or "")
        token = "" if username or password else extract_bearer_token(authorization)
        device_fingerprint = str(body.get("device_fingerprint") or request.headers.get("x-device-fingerprint") or "").strip()
        device_registered = web_user_service.is_device_registered(device_fingerprint)
        issued_token = ""
        if username or password:
            try:
                identity, issued_token = web_user_service.login(username, password, device_fingerprint)
                if identity.get("role") == "user":
                    _migrate_guest_quota_to_user(str(identity.get("id") or ""), device_fingerprint)
                    web_user_service.promote_guest_to_user(str(identity.get("id") or ""), device_fingerprint)
                    device_registered = True
            except PermissionError as exc:
                raise HTTPException(status_code=401, detail={"error": str(exc)}) from exc
            except ValueError as exc:
                raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        else:
            identity = require_identity(authorization) if token else ip_fingerprint_identity(request)
            if not token:
                web_user_service.record_guest(str(identity.get("ip") or ""), str(identity.get("fingerprint") or ""))
                identity = web_user_service.get_guest_identity(str(identity.get("fingerprint") or "")) or identity
        return {
            "ok": True,
            "version": app_version,
            "role": identity.get("role"),
            "subject_id": identity.get("id"),
            "name": identity.get("name"),
            "token": issued_token,
            "ip": identity.get("ip"),
            "fingerprint": identity.get("fingerprint"),
            "device_registered": device_registered,
        }

    @router.get("/version")
    async def get_version():
        return {"version": app_version}

    @router.get("/api/settings")
    async def get_settings(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"config": config.get()}

    @router.post("/api/settings")
    async def save_settings(body: SettingsUpdateRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"config": config.update(body.model_dump(mode="python"))}

    @router.get("/api/images")
    async def get_images(request: Request, start_date: str = "", end_date: str = "", authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return list_images(resolve_image_base_url(request), start_date=start_date.strip(), end_date=end_date.strip())

    @router.post("/api/images/delete")
    async def delete_images_endpoint(body: ImageDeleteRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return delete_images(body.paths, start_date=body.start_date.strip(), end_date=body.end_date.strip(), all_matching=body.all_matching)

    @router.get("/api/logs")
    async def get_logs(type: str = "", start_date: str = "", end_date: str = "", authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"items": log_service.list(type=type.strip(), start_date=start_date.strip(), end_date=end_date.strip())}

    @router.post("/api/proxy/test")
    async def test_proxy_endpoint(body: ProxyTestRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        candidate = (body.url or "").strip() or config.get_proxy_settings()
        if not candidate:
            raise HTTPException(status_code=400, detail={"error": "proxy url is required"})
        return {"result": await run_in_threadpool(test_proxy, candidate)}

    @router.get("/api/storage/info")
    async def get_storage_info(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        storage = config.get_storage_backend()
        return {
            "backend": storage.get_backend_info(),
            "health": storage.health_check(),
        }

    @router.get("/api/web-users")
    async def list_web_users(authorization: str | None = Header(default=None)):
        require_admin(authorization)
        return {"items": web_user_service.list_users(_load_ip_quotas(), USER_IMAGE_QUOTA_LIMIT, GUEST_IMAGE_QUOTA_LIMIT)}

    @router.post("/api/web-users/{user_id}/quota")
    async def update_web_user_quota(user_id: str, body: WebUserQuotaUpdateRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            web_user_service.update_quota_limit(user_id, body.quota_limit, USER_IMAGE_QUOTA_LIMIT)
            _reset_quota_usage_for_web_user(user_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        return {"items": web_user_service.list_users(_load_ip_quotas(), USER_IMAGE_QUOTA_LIMIT, GUEST_IMAGE_QUOTA_LIMIT)}

    return router
