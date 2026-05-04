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


def create_router(app_version: str) -> APIRouter:
    router = APIRouter()

    @router.post("/auth/login")
    async def login(request: Request, authorization: str | None = Header(default=None)):
        token = extract_bearer_token(authorization)
        body = {}
        try:
            parsed = await request.json()
            body = parsed if isinstance(parsed, dict) else {}
        except Exception:
            body = {}
        username = str(body.get("username") or "").strip()
        password = str(body.get("password") or "")
        device_fingerprint = str(body.get("device_fingerprint") or request.headers.get("x-device-fingerprint") or "").strip()
        issued_token = ""
        if username or password:
            try:
                identity, issued_token = web_user_service.login(username, password, device_fingerprint)
            except PermissionError as exc:
                raise HTTPException(status_code=401, detail={"error": str(exc)}) from exc
            except ValueError as exc:
                raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        else:
            identity = require_identity(authorization) if token else ip_fingerprint_identity(request)
        return {
            "ok": True,
            "version": app_version,
            "role": identity.get("role"),
            "subject_id": identity.get("id"),
            "name": identity.get("name"),
            "token": issued_token,
            "ip": identity.get("ip"),
            "fingerprint": identity.get("fingerprint"),
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
        return {"items": web_user_service.list_users(_load_ip_quotas(), USER_IMAGE_QUOTA_LIMIT)}

    return router
