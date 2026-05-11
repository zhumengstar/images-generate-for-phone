from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import Lock

from services.config import DATA_DIR

WEB_USERS_PATH = DATA_DIR / "web_users.json"
ADMIN_USERNAME = "admin"
ADMIN_PASSWORD = "muling1201"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_iso(value: object) -> datetime | None:
    text = _clean(value)
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _is_future(value: object) -> bool:
    parsed = _parse_iso(value)
    return parsed is not None and parsed > datetime.now(timezone.utc)


def _parse_package_quota(value: object) -> int:
    text = _clean(value)
    if "-" not in text:
        return 0
    try:
        return max(0, int(text.rsplit("-", 1)[-1]))
    except (TypeError, ValueError):
        return 0


def _clean(value: object) -> str:
    return str(value or "").strip()


def _hash_secret(value: str, salt: str) -> str:
    return hashlib.sha256(f"{salt}:{value}".encode("utf-8")).hexdigest()


def _sessions(item: dict[str, object]) -> dict[str, str]:
    raw = item.get("sessions")
    if not isinstance(raw, dict):
        legacy_token = _clean(item.get("token"))
        return {"legacy": legacy_token} if legacy_token else {}
    return {str(key): _clean(value) for key, value in raw.items() if _clean(key) and _clean(value)}


class WebUserService:
    def __init__(self, path: Path):
        self.path = path
        self._lock = Lock()
        self._items = self._load()
        self._ensure_admin()

    def _load(self) -> list[dict[str, object]]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            return []
        if not isinstance(data, list):
            return []
        return [item for item in data if isinstance(item, dict)]

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self._items, ensure_ascii=False, indent=2), encoding="utf-8")

    @staticmethod
    def _public_item(item: dict[str, object]) -> dict[str, object]:
        return {
            "id": item.get("id"),
            "name": item.get("username"),
            "role": item.get("role") if item.get("role") in {"admin", "user", "guest"} else "user",
            "created_at": item.get("created_at"),
            "last_used_at": item.get("last_used_at"),
            "quota_limit": item.get("quota_limit"),
            "quota_expires_at": item.get("quota_expires_at"),
            "quota_package": item.get("quota_package"),
            "quota_package_base_limit": item.get("quota_package_base_limit"),
        }

    def _device_owner_index(self, device_fingerprint: str) -> int | None:
        normalized_device = _clean(device_fingerprint)
        if not normalized_device:
            return None
        for index, item in enumerate(self._items):
            if self._public_item(item).get("role") != "user":
                continue
            sessions = _sessions(item)
            if normalized_device in sessions or _clean(item.get("device_fingerprint")) == normalized_device:
                return index
        return None

    def record_guest(self, ip: str, device_fingerprint: str) -> dict[str, object] | None:
        normalized_device = _clean(device_fingerprint)
        if not normalized_device or normalized_device == "unknown":
            return None
        normalized_ip = _clean(ip) or "unknown"
        with self._lock:
            if self._device_owner_index(normalized_device) is not None:
                return None
            now = _now_iso()
            guest_id = f"guest-{hashlib.sha256(normalized_device.encode('utf-8')).hexdigest()[:12]}"
            for index, item in enumerate(self._items):
                if self._public_item(item).get("role") != "guest":
                    continue
                if _clean(item.get("device_fingerprint")) != normalized_device:
                    continue
                next_item = dict(item)
                next_item["ip"] = normalized_ip
                next_item["last_used_at"] = now
                self._items[index] = next_item
                self._save()
                return self._public_item(next_item)
            item = {
                "id": guest_id,
                "username": f"访客 {guest_id[-6:]}",
                "role": "guest",
                "ip": normalized_ip,
                "device_fingerprint": normalized_device,
                "created_at": now,
                "last_used_at": now,
            }
            self._items.append(item)
            self._save()
            return self._public_item(item)

    def promote_guest_to_user(self, user_id: str, device_fingerprint: str) -> int:
        normalized_id = _clean(user_id)
        normalized_device = _clean(device_fingerprint)
        if not normalized_id or not normalized_device:
            return 0
        removed = 0
        with self._lock:
            now = _now_iso()
            target_index: int | None = None
            guest_items: list[dict[str, object]] = []
            for index, item in enumerate(self._items):
                public = self._public_item(item)
                if _clean(public.get("id")) == normalized_id:
                    target_index = index
                if public.get("role") == "guest" and _clean(item.get("device_fingerprint")) == normalized_device:
                    guest_items.append(dict(item))

            if target_index is not None and guest_items:
                target_item = dict(self._items[target_index])
                converted_guests = [
                    item for item in target_item.get("converted_guests", []) if isinstance(item, dict)
                ] if isinstance(target_item.get("converted_guests"), list) else []
                existing_guest_ids = {_clean(item.get("id")) for item in converted_guests}
                for guest_item in guest_items:
                    guest_id = _clean(guest_item.get("id"))
                    if guest_id and guest_id not in existing_guest_ids:
                        converted_guests.append(
                            {
                                "id": guest_id,
                                "username": _clean(guest_item.get("username")),
                                "ip": _clean(guest_item.get("ip")),
                                "device_fingerprint": _clean(guest_item.get("device_fingerprint")),
                                "quota_limit": guest_item.get("quota_limit"),
                                "created_at": guest_item.get("created_at"),
                                "last_used_at": guest_item.get("last_used_at"),
                                "converted_at": now,
                            }
                        )
                if target_item.get("quota_limit") in {None, ""}:
                    for guest_item in guest_items:
                        if guest_item.get("quota_limit") not in {None, ""}:
                            target_item["quota_limit"] = guest_item.get("quota_limit")
                            break
                target_item["converted_guests"] = converted_guests[-20:]
                self._items[target_index] = target_item

            next_items: list[dict[str, object]] = []
            for item in self._items:
                if self._public_item(item).get("role") == "guest" and _clean(item.get("device_fingerprint")) == normalized_device:
                    removed += 1
                    continue
                next_items.append(item)
            if removed:
                self._items = next_items
                self._save()
        return removed

    def is_device_registered(self, device_fingerprint: str) -> bool:
        return self._device_owner_index(device_fingerprint) is not None

    def _ensure_admin(self) -> None:
        with self._lock:
            changed = False
            for index, item in enumerate(self._items):
                if _clean(item.get("username")).lower() != ADMIN_USERNAME:
                    continue
                next_item = dict(item)
                if next_item.get("role") != "admin":
                    next_item["role"] = "admin"
                    changed = True
                salt = _clean(next_item.get("salt"))
                password_hash = _clean(next_item.get("password_hash"))
                if not salt or not password_hash or not hmac.compare_digest(password_hash, _hash_secret(ADMIN_PASSWORD, salt)):
                    salt = secrets.token_hex(16)
                    next_item["salt"] = salt
                    next_item["password_hash"] = _hash_secret(ADMIN_PASSWORD, salt)
                    changed = True
                self._items[index] = next_item
                if changed:
                    self._save()
                return

            salt = secrets.token_hex(16)
            self._items.append(
                {
                    "id": "admin",
                    "username": ADMIN_USERNAME,
                    "role": "admin",
                    "salt": salt,
                    "password_hash": _hash_secret(ADMIN_PASSWORD, salt),
                    "sessions": {},
                    "token": "",
                    "created_at": _now_iso(),
                    "last_used_at": None,
                }
            )
            self._save()

    def login(self, username: str, password: str, device_fingerprint: str = "") -> tuple[dict[str, object], str]:
        normalized_username = _clean(username)
        normalized_password = str(password or "")
        normalized_device = _clean(device_fingerprint) or "unknown"
        if not normalized_username or not normalized_password:
            raise ValueError("请输入用户名和密码")
        if len(normalized_username) > 32 or len(normalized_password) > 128:
            raise ValueError("用户名或密码过长")

        with self._lock:
            matched_index: int | None = None
            matched_item: dict[str, object] | None = None
            for index, item in enumerate(self._items):
                if self._public_item(item).get("role") == "guest":
                    continue
                if _clean(item.get("username")).lower() != normalized_username.lower():
                    continue
                matched_index = index
                matched_item = item
                break

            if matched_item is not None and matched_index is not None:
                item = matched_item
                salt = _clean(item.get("salt"))
                password_hash = _clean(item.get("password_hash"))
                if not salt or not password_hash or not hmac.compare_digest(password_hash, _hash_secret(normalized_password, salt)):
                    raise PermissionError("用户名或密码错误")
            else:
                if normalized_username.lower() != ADMIN_USERNAME:
                    owner_index = self._device_owner_index(normalized_device)
                    if owner_index is not None:
                        raise PermissionError("当前设备已绑定其他用户，无法继续登录")
                salt = secrets.token_hex(16)
                matched_index = len(self._items)
                matched_item = {
                    "id": uuid.uuid4().hex[:12],
                    "username": normalized_username,
                    "role": "admin" if normalized_username.lower() == ADMIN_USERNAME else "user",
                    "salt": salt,
                    "password_hash": _hash_secret(normalized_password, salt),
                    "created_at": _now_iso(),
                    "last_used_at": _now_iso(),
                }
                self._items.append(matched_item)

            token = f"wu-{secrets.token_urlsafe(32)}"
            matched_role = self._public_item(self._items[matched_index]).get("role")
            is_admin_login = matched_role == "admin"
            session_key = f"admin|{uuid.uuid4().hex[:16]}" if is_admin_login else normalized_device

            if not is_admin_login:
                owner_index = self._device_owner_index(normalized_device)
                if owner_index is not None and owner_index != matched_index:
                    raise PermissionError("当前设备已绑定其他用户，无法继续登录")

            if not is_admin_login:
                for index, raw_item in enumerate(self._items):
                    next_item = dict(raw_item)
                    item_role = self._public_item(next_item).get("role")
                    sessions = _sessions(next_item) if index == matched_index or isinstance(next_item.get("sessions"), dict) else {}
                    if item_role == "user":
                        sessions.pop(normalized_device, None)
                    next_item["sessions"] = sessions
                    if index != matched_index and item_role == "user" and not sessions:
                        next_item["token"] = ""
                    if index != matched_index and item_role == "user" and _clean(next_item.get("device_fingerprint")) == normalized_device:
                        next_item["device_fingerprint"] = ""
                    self._items[index] = next_item

            next_item = dict(self._items[matched_index])
            sessions = _sessions(next_item)
            sessions[session_key] = token
            next_item["sessions"] = sessions
            next_item["token"] = token
            next_item["device_fingerprint"] = "" if is_admin_login else normalized_device
            next_item["last_used_at"] = _now_iso()
            self._items[matched_index] = next_item
            self._save()
            return self._public_item(next_item), token

    def authenticate(self, raw_token: str) -> dict[str, object] | None:
        token = _clean(raw_token)
        if not token:
            return None
        with self._lock:
            for index, item in enumerate(self._items):
                sessions = _sessions(item)
                if not any(hmac.compare_digest(session_token, token) for session_token in sessions.values()):
                    continue
                next_item = dict(item)
                next_item["last_used_at"] = _now_iso()
                self._items[index] = next_item
                self._save()
                return self._public_item(next_item)
        return None

    def list_users(self, quota_items: dict[str, int] | None = None, user_limit: int = 20, guest_limit: int = 5) -> list[dict[str, object]]:
        quota_items = quota_items or {}
        with self._lock:
            items = [dict(item) for item in self._items]

        users: list[dict[str, object]] = []
        for item in items:
            public = self._public_item(item)
            user_id = _clean(public.get("id"))
            is_admin = public.get("role") == "admin"
            is_guest = public.get("role") == "guest"
            quota_limit = -1 if is_admin else self._quota_limit_for_item(item, guest_limit if is_guest else user_limit)
            quota_expires_at = _clean(item.get("quota_expires_at"))
            quota_package = _clean(item.get("quota_package"))
            has_active_package = bool(quota_package and _is_future(quota_expires_at))
            registered_prefixes = (f"user|{user_id}|", f"admin|{user_id}|")
            if is_admin:
                device_usages = [
                    {
                        "device": key.rsplit("|", 1)[-1] if "|" in key else "unknown",
                        "used": max(0, int(value or 0)),
                        "remaining": -1,
                    }
                    for key, value in quota_items.items()
                    if key == f"admin|{user_id}" or key.startswith(registered_prefixes)
                ]
            elif is_guest:
                guest_fingerprint = _clean(item.get("device_fingerprint"))
                device_usages = [
                    {
                        "device": key.rsplit("|", 1)[-1],
                        "used": max(0, int(value or 0)),
                        "remaining": max(0, quota_limit - max(0, int(value or 0))),
                    }
                    for key, value in quota_items.items()
                    if not key.startswith(("user|", "admin|")) and "|" in key and key.rsplit("|", 1)[-1] == guest_fingerprint
                ]
            else:
                device_usages = [
                    {
                        "device": key.rsplit("|", 1)[-1],
                        "used": max(0, int(value or 0)),
                        "remaining": -1 if quota_limit < 0 else max(0, quota_limit - max(0, int(value or 0))),
                    }
                    for key, value in quota_items.items()
                    if key.startswith(registered_prefixes)
                ]
            used_total = sum(int(usage["used"]) for usage in device_usages)
            sessions = _sessions(item)
            real_session_devices = [key for key in sessions if not key.startswith("admin|") and key != "legacy"]
            users.append(
                {
                    **public,
                    "username": public.get("name"),
                    "active_sessions": 0 if is_guest else len(sessions),
                    "device_count": len({str(usage["device"]) for usage in device_usages}) if is_admin else len(set(real_session_devices) | {str(usage["device"]) for usage in device_usages} | ({_clean(item.get("device_fingerprint"))} if is_guest else set())),
                    "used_total": used_total,
                    "quota_limit": quota_limit,
                    "quota_expires_at": quota_expires_at if has_active_package else "",
                    "quota_package": quota_package if has_active_package else "",
                    "remaining_total": -1 if quota_limit < 0 else max(0, quota_limit - used_total),
                    "device_usages": device_usages,
                    "password_saved": bool(_clean(item.get("password_hash"))),
                }
            )
        role_order = {"admin": 0, "user": 1, "guest": 2}
        users.sort(key=lambda item: (role_order.get(str(item.get("role")), 9), str(item.get("created_at") or "")))
        return users

    @staticmethod
    def _quota_limit_for_item(item: dict[str, object], default_limit: int) -> int:
        if _clean(item.get("quota_package")) and not _is_future(item.get("quota_expires_at")):
            try:
                return max(0, int(item.get("quota_package_base_limit")))
            except (TypeError, ValueError):
                try:
                    return max(0, int(item.get("quota_limit")) - _parse_package_quota(item.get("quota_package")))
                except (TypeError, ValueError):
                    return max(0, int(default_limit))
        value = item.get("quota_limit")
        if value is None or value == "":
            return max(0, int(default_limit))
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            return max(0, int(default_limit))
        return -1 if parsed < 0 else max(0, parsed)

    def get_quota_limit(self, user_id: str, default_limit: int) -> int:
        normalized_id = _clean(user_id)
        if not normalized_id:
            return max(0, int(default_limit))
        with self._lock:
            for item in self._items:
                public = self._public_item(item)
                if _clean(public.get("id")) != normalized_id:
                    continue
                if public.get("role") == "admin":
                    return -1
                return self._quota_limit_for_item(item, default_limit)
        return max(0, int(default_limit))

    def get_guest_quota_limit(self, device_fingerprint: str, default_limit: int) -> int:
        normalized_device = _clean(device_fingerprint)
        if not normalized_device:
            return max(0, int(default_limit))
        with self._lock:
            for item in self._items:
                public = self._public_item(item)
                if public.get("role") != "guest":
                    continue
                if _clean(item.get("device_fingerprint")) == normalized_device:
                    return self._quota_limit_for_item(item, default_limit)
        return max(0, int(default_limit))

    def get_guest_identity(self, device_fingerprint: str) -> dict[str, object] | None:
        normalized_device = _clean(device_fingerprint)
        if not normalized_device:
            return None
        with self._lock:
            for item in self._items:
                public = self._public_item(item)
                if public.get("role") != "guest":
                    continue
                if _clean(item.get("device_fingerprint")) == normalized_device:
                    return public
        return None

    def get_public_user(self, user_id: str) -> dict[str, object] | None:
        normalized_id = _clean(user_id)
        if not normalized_id:
            return None
        with self._lock:
            for item in self._items:
                public = self._public_item(item)
                if _clean(public.get("id")) == normalized_id:
                    return public
        return None

    def update_quota_limit(self, user_id: str, quota_limit: int, default_limit: int) -> dict[str, object]:
        normalized_id = _clean(user_id)
        if not normalized_id:
            raise ValueError("用户不存在")
        normalized_limit = -1 if int(quota_limit) < 0 else max(0, int(quota_limit))
        with self._lock:
            for index, item in enumerate(self._items):
                public = self._public_item(item)
                if _clean(public.get("id")) != normalized_id:
                    continue
                if public.get("role") == "admin":
                    raise ValueError("管理员不需要设置图片额度")
                if public.get("role") not in {"user", "guest"}:
                    raise ValueError("只能设置用户或访客的图片额度")
                next_item = dict(item)
                next_item["quota_limit"] = normalized_limit
                next_item.pop("quota_package", None)
                next_item.pop("quota_expires_at", None)
                next_item.pop("quota_package_base_limit", None)
                self._items[index] = next_item
                self._save()
                return self._public_item(next_item)
        raise ValueError("用户不存在")

    def update_quota_package(self, user_id: str, package_quota: int, days: int, default_limit: int) -> dict[str, object]:
        normalized_id = _clean(user_id)
        if not normalized_id:
            raise ValueError("用户不存在")
        normalized_package_quota = max(1, int(package_quota))
        normalized_days = max(1, int(days))
        with self._lock:
            for index, item in enumerate(self._items):
                public = self._public_item(item)
                if _clean(public.get("id")) != normalized_id:
                    continue
                if public.get("role") == "admin":
                    raise ValueError("管理员不需要设置套餐")
                if public.get("role") not in {"user", "guest"}:
                    raise ValueError("只能设置用户或访客的图片套餐")
                current_limit = self._quota_limit_for_item(item, default_limit)
                if _clean(item.get("quota_package")) and _is_future(item.get("quota_expires_at")):
                    try:
                        base_limit = max(0, int(item.get("quota_package_base_limit")))
                    except (TypeError, ValueError):
                        base_limit = max(0, current_limit - _parse_package_quota(item.get("quota_package")))
                else:
                    base_limit = max(0, current_limit)
                next_item = dict(item)
                next_item["quota_limit"] = base_limit + normalized_package_quota
                next_item["quota_package"] = f"{normalized_days}d-{normalized_package_quota}"
                next_item["quota_package_base_limit"] = base_limit
                next_item["quota_expires_at"] = (datetime.now(timezone.utc) + timedelta(days=normalized_days)).isoformat()
                self._items[index] = next_item
                self._save()
                return self._public_item(next_item)
        raise ValueError("用户不存在")
    def update_role(self, user_id: str, role: str) -> dict[str, object]:
        normalized_id = _clean(user_id)
        normalized_role = _clean(role).lower()
        if not normalized_id:
            raise ValueError("用户不存在")
        if normalized_role not in {"admin", "user"}:
            raise ValueError("只能设置为管理员或普通用户")
        with self._lock:
            admin_count = sum(1 for item in self._items if self._public_item(item).get("role") == "admin")
            for index, item in enumerate(self._items):
                public = self._public_item(item)
                if _clean(public.get("id")) != normalized_id:
                    continue
                current_role = str(public.get("role") or "")
                if current_role == "guest":
                    raise ValueError("访客不能设置为管理员")
                if normalized_id == "admin" and normalized_role != "admin":
                    raise ValueError("内置管理员账号不能降权")
                if current_role == "admin" and normalized_role != "admin" and admin_count <= 1:
                    raise ValueError("至少需要保留一个管理员")
                if current_role == normalized_role:
                    return public
                next_item = dict(item)
                next_item["role"] = normalized_role
                self._items[index] = next_item
                self._save()
                return self._public_item(next_item)
        raise ValueError("用户不存在")

    def increment_quota_limit(self, user_id: str, amount: int, default_limit: int) -> dict[str, object]:
        normalized_id = _clean(user_id)
        if not normalized_id:
            raise ValueError("用户不存在")
        increment = max(0, int(amount))
        with self._lock:
            for index, item in enumerate(self._items):
                public = self._public_item(item)
                if _clean(public.get("id")) != normalized_id:
                    continue
                if public.get("role") == "admin":
                    return public
                if public.get("role") not in {"user", "guest"}:
                    raise ValueError("只能奖励用户或访客的图片额度")
                current_limit = self._quota_limit_for_item(item, default_limit)
                next_limit = -1 if current_limit < 0 else current_limit + increment
                next_item = dict(item)
                next_item["quota_limit"] = next_limit
                next_item.pop("quota_package", None)
                next_item.pop("quota_expires_at", None)
                self._items[index] = next_item
                self._save()
                return self._public_item(next_item)
        raise ValueError("用户不存在")

    def delete_user(self, user_id: str) -> dict[str, str]:
        normalized_id = _clean(user_id)
        if not normalized_id:
            raise ValueError("用户不存在")
        with self._lock:
            for index, item in enumerate(self._items):
                public = self._public_item(item)
                if _clean(public.get("id")) != normalized_id:
                    continue
                role = str(public.get("role") or "")
                if role == "admin":
                    raise ValueError("管理员账号不能删除")
                if role not in {"user", "guest"}:
                    raise ValueError("只能删除用户或访客")
                target = {
                    "role": role,
                    "id": normalized_id,
                    "device_fingerprint": _clean(item.get("device_fingerprint")),
                }
                self._items.pop(index)
                self._save()
                return target
        raise ValueError("用户不存在")

    def quota_usage_target(self, user_id: str) -> dict[str, str]:
        normalized_id = _clean(user_id)
        if not normalized_id:
            raise ValueError("用户不存在")
        with self._lock:
            for item in self._items:
                public = self._public_item(item)
                if _clean(public.get("id")) != normalized_id:
                    continue
                role = str(public.get("role") or "")
                if role == "user":
                    return {"role": role, "id": normalized_id, "device_fingerprint": _clean(item.get("device_fingerprint"))}
                if role == "guest":
                    return {"role": role, "id": normalized_id, "device_fingerprint": _clean(item.get("device_fingerprint"))}
                raise ValueError("该用户不支持重置图片额度")
        raise ValueError("用户不存在")


web_user_service = WebUserService(WEB_USERS_PATH)
