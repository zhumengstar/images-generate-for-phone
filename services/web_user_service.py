from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import uuid
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock

from services.config import DATA_DIR

WEB_USERS_PATH = DATA_DIR / "web_users.json"
ADMIN_USERNAME = "admin"
ADMIN_PASSWORD = "muling1201"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


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
            "role": item.get("role") if item.get("role") in {"admin", "user"} else "user",
            "created_at": item.get("created_at"),
            "last_used_at": item.get("last_used_at"),
        }

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
            raise ValueError("username and password are required")
        if len(normalized_username) > 32 or len(normalized_password) > 128:
            raise ValueError("username or password is too long")

        with self._lock:
            matched_index: int | None = None
            matched_item: dict[str, object] | None = None
            for index, item in enumerate(self._items):
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
                    raise PermissionError("username or password is invalid")
            else:
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
                for index, raw_item in enumerate(self._items):
                    next_item = dict(raw_item)
                    item_role = self._public_item(next_item).get("role")
                    sessions = _sessions(next_item) if index == matched_index or isinstance(next_item.get("sessions"), dict) else {}
                    if item_role != "admin":
                        sessions.pop(normalized_device, None)
                    next_item["sessions"] = sessions
                    if index != matched_index and item_role != "admin" and not sessions:
                        next_item["token"] = ""
                    if index != matched_index and item_role != "admin" and _clean(next_item.get("device_fingerprint")) == normalized_device:
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

    def list_users(self, quota_items: dict[str, int] | None = None, user_limit: int = 20) -> list[dict[str, object]]:
        quota_items = quota_items or {}
        with self._lock:
            items = [dict(item) for item in self._items]

        users: list[dict[str, object]] = []
        for item in items:
            public = self._public_item(item)
            user_id = _clean(public.get("id"))
            device_usages = [
                {
                    "device": key.rsplit("|", 1)[-1],
                    "used": max(0, int(value or 0)),
                    "remaining": max(0, user_limit - max(0, int(value or 0))),
                }
                for key, value in quota_items.items()
                if key.startswith(f"user|{user_id}|")
            ]
            used_total = sum(int(usage["used"]) for usage in device_usages)
            sessions = _sessions(item)
            is_admin = public.get("role") == "admin"
            real_session_devices = [key for key in sessions if not key.startswith("admin|") and key != "legacy"]
            users.append(
                {
                    **public,
                    "username": public.get("name"),
                    "active_sessions": len(sessions),
                    "device_count": len(set(real_session_devices) | {str(usage["device"]) for usage in device_usages}),
                    "used_total": used_total,
                    "quota_limit": -1 if is_admin else user_limit,
                    "remaining_total": -1 if is_admin else max(0, user_limit - used_total),
                    "device_usages": device_usages,
                    "password_saved": bool(_clean(item.get("password_hash"))),
                }
            )
        users.sort(key=lambda item: (item.get("role") != "admin", str(item.get("created_at") or "")))
        return users


web_user_service = WebUserService(WEB_USERS_PATH)
