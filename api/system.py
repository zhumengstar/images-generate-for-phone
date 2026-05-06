from __future__ import annotations

import json
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
IP_IMAGE_TASKS_PATH = DATA_DIR / "ip_image_tasks.json"
IMAGE_SHARE_REWARDS_PATH = DATA_DIR / "image_share_rewards.json"


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


class WebUserRoleUpdateRequest(BaseModel):
    role: str


class WebUserDefaultQuotaUpdateRequest(BaseModel):
    user_image_quota_limit: int
    guest_image_quota_limit: int


def _default_quota_limits() -> dict[str, int]:
    return {
        "user_image_quota_limit": config.user_image_quota_limit,
        "guest_image_quota_limit": config.guest_image_quota_limit,
    }


def _web_users_payload() -> dict[str, object]:
    limits = _default_quota_limits()
    quota_items = _load_ip_quotas()
    _merge_task_usage_counts(quota_items)
    return {
        "items": web_user_service.list_users(
            quota_items,
            limits["user_image_quota_limit"],
            limits["guest_image_quota_limit"],
        ),
        "default_quota_limits": limits,
    }


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


def _load_ip_tasks() -> dict[str, dict[str, object]]:
    try:
        data = json.loads(IP_IMAGE_TASKS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}
    raw_tasks = data.get("tasks") if isinstance(data, dict) else []
    if not isinstance(raw_tasks, list):
        return {}
    items: dict[str, dict[str, object]] = {}
    for task in raw_tasks:
        if not isinstance(task, dict):
            continue
        task_id = str(task.get("id") or "").strip()
        owner = str(task.get("owner") or "").strip()
        if task_id and owner:
            items[f"{owner}:{task_id}"] = dict(task)
    return items


def _save_ip_tasks(items: dict[str, dict[str, object]]) -> None:
    IP_IMAGE_TASKS_PATH.parent.mkdir(parents=True, exist_ok=True)
    sorted_items = sorted(items.values(), key=lambda item: str(item.get("updated_at") or ""), reverse=True)
    IP_IMAGE_TASKS_PATH.write_text(json.dumps({"tasks": sorted_items[:120]}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _load_share_rewards() -> dict[str, dict[str, object]]:
    try:
        data = json.loads(IMAGE_SHARE_REWARDS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    return {str(key): dict(value) for key, value in data.items() if isinstance(value, dict)}


def _save_share_rewards(items: dict[str, dict[str, object]]) -> None:
    IMAGE_SHARE_REWARDS_PATH.parent.mkdir(parents=True, exist_ok=True)
    IMAGE_SHARE_REWARDS_PATH.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")


def _merge_task_usage_counts(quota_items: dict[str, int]) -> None:
    task_items = _load_ip_tasks()
    task_usage: dict[str, int] = {}
    for task in task_items.values():
        if str(task.get("status") or "") != "success":
            continue
        quota_key = str(task.get("quota_key") or task.get("owner") or "").strip()
        if not quota_key:
            continue
        data = task.get("data")
        count = len(data) if isinstance(data, list) and data else 1
        task_usage[quota_key] = task_usage.get(quota_key, 0) + max(1, count)
    for key, used in task_usage.items():
        quota_items[key] = max(max(0, int(quota_items.get(key, 0))), max(0, int(used)))


def _migrate_guest_quota_to_user(user_id: str, device_fingerprint: str) -> int:
    normalized_user_id = str(user_id or "").strip()
    normalized_device = str(device_fingerprint or "").strip()
    if not normalized_user_id or not normalized_device:
        return 0
    items = _load_ip_quotas()
    user_key = f"user|{normalized_user_id}|{normalized_device}"
    migrated = 0
    for key in list(items):
        if (
            key.startswith("user|")
            or key.startswith("admin|")
            or "|" not in key
            or key.rsplit("|", 1)[-1] != normalized_device
        ):
            continue
        migrated += max(0, int(items.get(key, 0)))
        items.pop(key, None)
    if migrated:
        items[user_key] = max(0, int(items.get(user_key, 0))) + migrated
        _save_ip_quotas(items)
    return migrated


def _is_guest_owner_key(value: str, fingerprint: str) -> bool:
    return "|" in value and not value.startswith(("user|", "admin|")) and value.rsplit("|", 1)[-1] == fingerprint


def _migrate_guest_image_tasks_to_user(user_id: str, device_fingerprint: str) -> int:
    normalized_user_id = str(user_id or "").strip()
    normalized_device = str(device_fingerprint or "").strip()
    if not normalized_user_id or not normalized_device:
        return 0
    target_owner = f"user|{normalized_user_id}|{normalized_device}"
    items = _load_ip_tasks()
    migrated = 0
    for key, task in list(items.items()):
        owner = str(task.get("owner") or "").strip()
        task_id = str(task.get("id") or "").strip()
        if not task_id or not _is_guest_owner_key(owner, normalized_device):
            continue
        target_key = f"{target_owner}:{task_id}"
        next_task = dict(task)
        next_task["owner"] = target_owner
        next_task["quota_key"] = target_owner
        if target_key not in items or str(next_task.get("updated_at") or "") >= str(items[target_key].get("updated_at") or ""):
            items[target_key] = next_task
        items.pop(key, None)
        migrated += 1
    if migrated:
        _save_ip_tasks(items)
    return migrated


def _migrate_guest_share_rewards_to_user(user_id: str, device_fingerprint: str, name: str = "") -> int:
    normalized_user_id = str(user_id or "").strip()
    normalized_device = str(device_fingerprint or "").strip()
    if not normalized_user_id or not normalized_device:
        return 0
    items = _load_share_rewards()
    migrated = 0
    for code, item in list(items.items()):
        if str(item.get("owner_type") or "") != "guest":
            continue
        if str(item.get("owner_fingerprint") or "").strip() != normalized_device:
            continue
        next_item = dict(item)
        next_item["owner_type"] = "user"
        next_item["owner_user_id"] = normalized_user_id
        if name:
            next_item["owner_name"] = name
        items[code] = next_item
        migrated += 1
    if migrated:
        _save_share_rewards(items)
    return migrated


def _promote_guest_data_to_user(user_id: str, device_fingerprint: str, name: str = "") -> dict[str, int]:
    return {
        "quota": _migrate_guest_quota_to_user(user_id, device_fingerprint),
        "tasks": _migrate_guest_image_tasks_to_user(user_id, device_fingerprint),
        "share_rewards": _migrate_guest_share_rewards_to_user(user_id, device_fingerprint, name),
        "guests": web_user_service.promote_guest_to_user(user_id, device_fingerprint),
    }


def _reset_quota_usage_for_target(target: dict[str, str]) -> int:
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
                if (
                    key.startswith("user|")
                    or key.startswith("admin|")
                    or "|" not in key
                    or key.rsplit("|", 1)[-1] != fingerprint
                ):
                    continue
                items.pop(key, None)
                removed += 1
    if removed:
        _save_ip_quotas(items)
    return removed


def _reset_quota_usage_for_web_user(user_id: str) -> int:
    return _reset_quota_usage_for_target(web_user_service.quota_usage_target(user_id))


def _migrate_registered_quota_role(user_id: str, role: str) -> int:
    normalized_id = str(user_id or "").strip()
    normalized_role = str(role or "").strip().lower()
    if not normalized_id or normalized_role not in {"admin", "user"}:
        return 0
    source_prefix = f"{'user' if normalized_role == 'admin' else 'admin'}|{normalized_id}|"
    target_prefix = f"{normalized_role}|{normalized_id}|"
    items = _load_ip_quotas()
    migrated = 0
    for key in list(items):
        if not key.startswith(source_prefix):
            continue
        target_key = f"{target_prefix}{key[len(source_prefix):]}"
        items[target_key] = max(0, int(items.get(target_key, 0))) + max(0, int(items.get(key, 0)))
        items.pop(key, None)
        migrated += 1
    if migrated:
        _save_ip_quotas(items)
    return migrated


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
                    _promote_guest_data_to_user(
                        str(identity.get("id") or ""),
                        device_fingerprint,
                        str(identity.get("name") or ""),
                    )
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
        return _web_users_payload()

    @router.post("/api/web-users/{user_id}/quota")
    async def update_web_user_quota(user_id: str, body: WebUserQuotaUpdateRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            web_user_service.update_quota_limit(user_id, body.quota_limit, config.user_image_quota_limit)
            _reset_quota_usage_for_web_user(user_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        return _web_users_payload()

    @router.post("/api/web-users/{user_id}/role")
    async def update_web_user_role(user_id: str, body: WebUserRoleUpdateRequest, authorization: str | None = Header(default=None)):
        identity = require_admin(authorization)
        normalized_role = str(body.role or "").strip().lower()
        if str(identity.get("id") or "").strip() == user_id.strip() and normalized_role != "admin":
            raise HTTPException(status_code=400, detail={"error": "不能降低当前登录管理员的权限"})
        try:
            item = web_user_service.update_role(user_id, normalized_role)
            _migrate_registered_quota_role(str(item.get("id") or user_id), normalized_role)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        return _web_users_payload()

    @router.delete("/api/web-users/{user_id}")
    async def delete_web_user(user_id: str, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        try:
            target = web_user_service.delete_user(user_id)
            _reset_quota_usage_for_target(target)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
        return _web_users_payload()

    @router.post("/api/web-users/default-quotas")
    async def update_web_user_default_quotas(body: WebUserDefaultQuotaUpdateRequest, authorization: str | None = Header(default=None)):
        require_admin(authorization)
        config.update(
            {
                "user_image_quota_limit": max(0, int(body.user_image_quota_limit)),
                "guest_image_quota_limit": max(0, int(body.guest_image_quota_limit)),
            }
        )
        return _web_users_payload()

    return router
