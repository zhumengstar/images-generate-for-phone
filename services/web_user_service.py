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


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clean(value: object) -> str:
    return str(value or "").strip()


def _hash_secret(value: str, salt: str) -> str:
    return hashlib.sha256(f"{salt}:{value}".encode("utf-8")).hexdigest()


class WebUserService:
    def __init__(self, path: Path):
        self.path = path
        self._lock = Lock()
        self._items = self._load()

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
            "role": "user",
            "created_at": item.get("created_at"),
            "last_used_at": item.get("last_used_at"),
        }

    def login(self, username: str, password: str) -> tuple[dict[str, object], str]:
        normalized_username = _clean(username)
        normalized_password = str(password or "")
        if not normalized_username or not normalized_password:
            raise ValueError("username and password are required")
        if len(normalized_username) > 32 or len(normalized_password) > 128:
            raise ValueError("username or password is too long")

        with self._lock:
            for index, item in enumerate(self._items):
                if _clean(item.get("username")).lower() != normalized_username.lower():
                    continue
                salt = _clean(item.get("salt"))
                password_hash = _clean(item.get("password_hash"))
                if not salt or not password_hash or not hmac.compare_digest(password_hash, _hash_secret(normalized_password, salt)):
                    raise PermissionError("username or password is invalid")
                next_item = dict(item)
                token = _clean(next_item.get("token")) or f"wu-{secrets.token_urlsafe(32)}"
                next_item["token"] = token
                next_item["last_used_at"] = _now_iso()
                self._items[index] = next_item
                self._save()
                return self._public_item(next_item), token

            salt = secrets.token_hex(16)
            token = f"wu-{secrets.token_urlsafe(32)}"
            item = {
                "id": uuid.uuid4().hex[:12],
                "username": normalized_username,
                "role": "user",
                "salt": salt,
                "password_hash": _hash_secret(normalized_password, salt),
                "token": token,
                "created_at": _now_iso(),
                "last_used_at": _now_iso(),
            }
            self._items.append(item)
            self._save()
            return self._public_item(item), token

    def authenticate(self, raw_token: str) -> dict[str, object] | None:
        token = _clean(raw_token)
        if not token:
            return None
        with self._lock:
            for index, item in enumerate(self._items):
                stored_token = _clean(item.get("token"))
                if not stored_token or not hmac.compare_digest(stored_token, token):
                    continue
                next_item = dict(item)
                next_item["last_used_at"] = _now_iso()
                self._items[index] = next_item
                self._save()
                return self._public_item(next_item)
        return None


web_user_service = WebUserService(WEB_USERS_PATH)
