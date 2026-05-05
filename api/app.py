from __future__ import annotations

import json
import os
import base64
import re
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
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from api import accounts, ai, image_tasks, register, system
from api.support import client_public_ip, device_fingerprint, extract_bearer_token, ip_fingerprint_identity, ip_fingerprint_key, require_identity, resolve_web_asset, start_limited_account_watcher
from services.config import DATA_DIR, config
from services.web_user_service import web_user_service
from PIL import Image, ImageOps, UnidentifiedImageError

IMAGE_PROXY_BASE_URL = os.getenv("IMAGE_PROXY_BASE_URL", "https://generate.muling.store").rstrip("/")
IMAGE_PROXY_TIMEOUT = int(os.getenv("IMAGE_PROXY_TIMEOUT", "240"))
IMAGE_PROXY_RETRIES = int(os.getenv("IMAGE_PROXY_RETRIES", "2"))
IMAGE_EDIT_MAX_SIDE = int(os.getenv("IMAGE_PROXY_EDIT_MAX_SIDE", "2048"))
PROMPT_POLISH_BASE_URL = os.getenv("IMAGE_PROMPT_POLISH_BASE_URL", f"{IMAGE_PROXY_BASE_URL}/v1").rstrip("/")
PROMPT_POLISH_MODEL = os.getenv("IMAGE_PROMPT_POLISH_MODEL", "gpt-5.5")
PROMPT_POLISH_API_KEY = os.getenv("IMAGE_PROMPT_POLISH_API_KEY", "")
PROMPT_POLISH_CONFIG_PATH = DATA_DIR / "prompt_polish_config.json"
IP_QUOTAS_PATH = DATA_DIR / "ip_image_quotas.json"
IP_IMAGE_TASKS_PATH = DATA_DIR / "ip_image_tasks.json"
IMAGE_SHARE_REWARDS_PATH = DATA_DIR / "image_share_rewards.json"
IP_QUOTA_LOCK = Lock()
IP_IMAGE_TASKS_LOCK = Lock()
IMAGE_SHARE_REWARDS_LOCK = Lock()
ACTIVE_IP_TASK_LOCK = Lock()
ACTIVE_IP_TASKS: set[str] = set()
ACTIVE_IP_TASK_OWNERS: dict[str, str] = {}
MAX_OWNER_QUEUED_IMAGE_TASKS = 4


def _guest_image_quota_limit() -> int:
    return config.guest_image_quota_limit


def _user_image_quota_limit() -> int:
    return config.user_image_quota_limit

IMAGE_PROMPT_SAFETY_NOTICE = (
    "当前提示词包含违法违规或敏感内容，无法生成图片。请修改为合法、健康、非敏感的描述后再提交。"
)
IMAGE_PROMPT_SAFETY_SYSTEM_PROMPT = """
你是图片生成请求的安全审核员。请依据中国法律法规和平台安全规范审核用户提示词。
如果提示词涉及以下内容，应禁止生成并向用户提示：
1. 危害国家安全、分裂国家、颠覆政权、恐怖主义、极端主义、暴力犯罪、制造武器或爆炸物。
2. 色情低俗、未成年人不当内容、性剥削、裸露或性暗示。
3. 赌博、毒品、诈骗、黑客攻击、非法交易、规避监管、侵犯隐私或个人信息滥用。
4. 仇恨、歧视、骚扰、人身攻击、血腥暴力、自残自杀引导。
5. 现实政治敏感事件、敏感人物、敏感组织、敏感标识或可能引发公共风险的内容。
任务可以先进入等待队列并执行图片生成；命中时不要把图片返回给用户，只返回中文提示：
“当前提示词包含违法违规或敏感内容，无法生成图片。请修改为合法、健康、非敏感的描述后再提交。”
""".strip()

IMAGE_PROMPT_SAFETY_PATTERNS: tuple[tuple[str, str], ...] = (
    ("违法犯罪", r"(炸弹|爆炸物|枪支|弹药|毒品|贩毒|诈骗|洗钱|赌博|黑客|木马|盗号|身份证号|银行卡号)"),
    ("暴力恐怖", r"(恐怖主义|极端主义|血腥|虐杀|屠杀|自杀|自残|人肉|绑架|勒索)"),
    ("色情低俗", r"(色情|裸露|裸体|性行为|性暗示|成人视频|未成年.*性|儿童.*裸|萝莉.*裸)"),
    ("敏感政治", r"(分裂国家|颠覆国家|煽动颠覆|危害国家安全|敏感政治|政治敏感|反动|暴乱|暴恐)"),
    ("仇恨歧视", r"(种族歧视|地域歧视|仇恨言论|纳粹|辱骂.*群体)"),
)


def _image_prompt_safety_violation(prompt: str) -> str:
    normalized = re.sub(r"\s+", "", prompt or "").lower()
    if not normalized:
        return ""
    for label, pattern in IMAGE_PROMPT_SAFETY_PATTERNS:
        if re.search(pattern, normalized, re.IGNORECASE):
            return label
    return ""


def _assert_image_prompt_safe(prompt: str) -> None:
    if _image_prompt_safety_violation(prompt):
        raise HTTPException(
            status_code=400,
            detail={
                "error": IMAGE_PROMPT_SAFETY_NOTICE,
                "safety_prompt": IMAGE_PROMPT_SAFETY_SYSTEM_PROMPT,
            },
        )


def _now_iso() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _client_ip(request: Request) -> str:
    return client_public_ip(request)


def _device_fingerprint(request: Request) -> str:
    return device_fingerprint(request)


def _quota_key(ip: str, fingerprint: str) -> str:
    return ip_fingerprint_key(ip, fingerprint)


def _quota_subject(request: Request, ip: str, fingerprint: str) -> dict[str, object]:
    authorization = request.headers.get("authorization")
    token = extract_bearer_token(authorization)
    if token:
        try:
            identity = require_identity(authorization)
        except HTTPException:
            identity = None
        if identity is not None:
            subject_id = str(identity.get("id") or "").strip() or "user"
            role = str(identity.get("role") or "user")
            if role == "admin":
                return {
                    "key": f"admin|{subject_id}",
                    "user_id": subject_id,
                    "name": identity.get("name") or subject_id,
                    "type": "admin",
                    "limit": -1,
                    "ip": ip,
                    "fingerprint": fingerprint,
                }
            return {
                "key": f"user|{subject_id}|{fingerprint}",
                "user_id": subject_id,
                "name": identity.get("name") or subject_id,
                "type": "user",
                "limit": web_user_service.get_quota_limit(subject_id, _user_image_quota_limit()),
                "ip": ip,
                "fingerprint": fingerprint,
            }

    web_user_service.record_guest(ip, fingerprint)
    guest_identity = web_user_service.get_guest_identity(fingerprint)
    identity = guest_identity or ip_fingerprint_identity(request)
    return {
        "key": _quota_key(ip, fingerprint),
        "user_id": identity["id"],
        "name": identity.get("name") or identity["id"],
        "type": "guest",
        "limit": web_user_service.get_guest_quota_limit(fingerprint, _guest_image_quota_limit()),
        "ip": ip,
        "fingerprint": fingerprint,
    }


def _proxy_authorization(request: Request) -> str:
    proxy_key = str(config.auth_key or "").strip()
    if proxy_key:
        return f"Bearer {proxy_key}"
    return request.headers.get("authorization", "")


def _ip_quota_payload(request: Request, ip: str, fingerprint: str) -> dict[str, object]:
    subject = _quota_subject(request, ip, fingerprint)
    return {
        "user_id": subject["user_id"],
        "name": subject["name"],
        "type": subject["type"],
        "ip": ip,
        "fingerprint": fingerprint,
        "limit": subject["limit"],
        "remaining": _remaining_ip_quota(str(subject["key"]), int(subject["limit"])),
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


def _consume_ip_quota(quota_key: str, limit: int, count: int) -> int:
    if limit < 0:
        return -1
    with IP_QUOTA_LOCK:
        items = _load_ip_quotas()
        used = max(0, int(items.get(quota_key, 0)))
        remaining = max(0, limit - used)
        if count > remaining:
            raise HTTPException(
                status_code=429,
                detail={"error": f"当前账号剩余额度不足，还剩 {remaining} 张"},
            )
        items[quota_key] = used + count
        _save_ip_quotas(items)
        return max(0, limit - items[quota_key])


def _refund_ip_quota(quota_key: str, count: int, quota_limit: int | None = None) -> None:
    if quota_limit is not None and quota_limit < 0:
        return
    if quota_key.startswith("admin|"):
        return
    if quota_limit is None and quota_key.startswith("user|"):
        user_id = quota_key.split("|", 2)[1] if "|" in quota_key else ""
        if web_user_service.get_quota_limit(user_id, _user_image_quota_limit()) < 0:
            return
    with IP_QUOTA_LOCK:
        items = _load_ip_quotas()
        items[quota_key] = max(0, int(items.get(quota_key, 0)) - count)
        _save_ip_quotas(items)


def _remaining_ip_quota(quota_key: str, limit: int) -> int:
    if limit < 0:
        return -1
    with IP_QUOTA_LOCK:
        used = _load_ip_quotas().get(quota_key, 0)
        return max(0, limit - used)


def _load_share_rewards() -> dict[str, dict[str, Any]]:
    try:
        data = json.loads(IMAGE_SHARE_REWARDS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    return {str(key): value for key, value in data.items() if isinstance(value, dict)}


def _save_share_rewards(items: dict[str, dict[str, Any]]) -> None:
    IMAGE_SHARE_REWARDS_PATH.parent.mkdir(parents=True, exist_ok=True)
    IMAGE_SHARE_REWARDS_PATH.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")


def _create_image_share_reward(subject: dict[str, object]) -> dict[str, object]:
    subject_type = str(subject.get("type") or "")
    if subject_type not in {"user", "guest"}:
        raise HTTPException(status_code=400, detail={"error": "当前账号无需分享奖励"})
    now = _now_iso()
    with IMAGE_SHARE_REWARDS_LOCK:
        items = _load_share_rewards()
        code = uuid.uuid4().hex[:16]
        while code in items:
            code = uuid.uuid4().hex[:16]
        items[code] = {
            "code": code,
            "owner_type": subject_type,
            "owner_user_id": str(subject.get("user_id") or ""),
            "owner_name": str(subject.get("name") or ""),
            "owner_fingerprint": str(subject.get("fingerprint") or ""),
            "created_at": now,
            "redeemed_by": [],
        }
        _save_share_rewards(items)
    return {"code": code, "created_at": now}


def _award_share_owner_quota(item: dict[str, Any]) -> None:
    owner_type = str(item.get("owner_type") or "")
    owner_user_id = str(item.get("owner_user_id") or "")
    default_limit = _guest_image_quota_limit() if owner_type == "guest" else _user_image_quota_limit()
    web_user_service.increment_quota_limit(owner_user_id, 1, default_limit)


def _redeem_image_share_reward(code: str, redeemer: dict[str, object]) -> dict[str, object]:
    normalized_code = re.sub(r"[^a-zA-Z0-9]", "", code or "")[:64]
    if not normalized_code:
        raise HTTPException(status_code=400, detail={"error": "分享链接无效"})
    redeemer_fingerprint = str(redeemer.get("fingerprint") or "").strip()
    if not redeemer_fingerprint:
        raise HTTPException(status_code=400, detail={"error": "无法识别当前设备"})
    with IMAGE_SHARE_REWARDS_LOCK:
        items = _load_share_rewards()
        item = items.get(normalized_code)
        if item is None:
            raise HTTPException(status_code=404, detail={"error": "分享链接不存在或已失效"})
        owner_fingerprint = str(item.get("owner_fingerprint") or "").strip()
        if owner_fingerprint and owner_fingerprint == redeemer_fingerprint:
            return {"awarded": False, "message": "请使用其他设备打开分享链接领取奖励"}
        redeemed_by = [str(value) for value in item.get("redeemed_by", []) if value]
        if redeemer_fingerprint in redeemed_by:
            return {"awarded": False, "message": "该设备已领取过这个分享奖励"}
        _award_share_owner_quota(item)
        item["redeemed_by"] = [*redeemed_by, redeemer_fingerprint]
        item["last_redeemed_at"] = _now_iso()
        items[normalized_code] = item
        _save_share_rewards(items)
    return {"awarded": True, "message": "已为分享用户增加 1 次图片额度"}


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


def _web_asset_headers(asset_path: Any) -> dict[str, str]:
    path_text = str(asset_path).replace("\\", "/")
    if path_text.endswith(".html"):
        return {"Cache-Control": "public, max-age=0, must-revalidate"}
    if "/_next/static/" in path_text:
        return {"Cache-Control": "public, max-age=31536000, immutable"}
    if path_text.endswith((".js", ".css", ".woff", ".woff2", ".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico")):
        return {"Cache-Control": "public, max-age=86400"}
    return {"Cache-Control": "public, max-age=3600"}


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


def _chat_text_from_response(data: dict[str, Any]) -> str:
    choices = data.get("choices")
    if isinstance(choices, list) and choices:
        first = choices[0]
        if isinstance(first, dict):
            message = first.get("message")
            if isinstance(message, dict):
                content = message.get("content")
                if isinstance(content, str):
                    return content.strip()
                if isinstance(content, list):
                    parts = []
                    for item in content:
                        if isinstance(item, dict):
                            text = item.get("text") or item.get("content")
                            if isinstance(text, str):
                                parts.append(text)
                    return "\n".join(parts).strip()
            text = first.get("text")
            if isinstance(text, str):
                return text.strip()
    output_text = data.get("output_text")
    if isinstance(output_text, str):
        return output_text.strip()
    return ""


def _proxy_error_message(exc: BaseException) -> str:
    reason = getattr(exc, "reason", None)
    if reason:
        return str(reason)
    return str(exc) or exc.__class__.__name__


def _prompt_polish_settings() -> tuple[str, str, str]:
    base_url = PROMPT_POLISH_BASE_URL
    model = PROMPT_POLISH_MODEL
    api_key = PROMPT_POLISH_API_KEY
    try:
        if PROMPT_POLISH_CONFIG_PATH.exists():
            data = json.loads(PROMPT_POLISH_CONFIG_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                base_url = str(data.get("base_url") or base_url).strip().rstrip("/")
                model = str(data.get("model") or model).strip()
                api_key = str(data.get("api_key") or api_key).strip()
    except Exception:
        pass
    return base_url or f"{IMAGE_PROXY_BASE_URL}/v1", model or "gpt-5.5", api_key


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


def _owner_queued_task_count(items: dict[str, dict[str, Any]], owner: str, exclude_task_key: str = "") -> int:
    return sum(
        1
        for key, task in items.items()
        if key != exclude_task_key
        and task.get("owner") == owner
        and task.get("status") == "queued"
        and isinstance(task.get("work"), dict)
    )


def _ensure_owner_queue_capacity(items: dict[str, dict[str, Any]], owner: str, add_count: int = 1) -> None:
    if _owner_queued_task_count(items, owner) + add_count > MAX_OWNER_QUEUED_IMAGE_TASKS:
        raise HTTPException(
            status_code=429,
            detail={"error": f"褰撳墠鏈€澶氬彧鑳芥帓闃?{MAX_OWNER_QUEUED_IMAGE_TASKS} 寮犲浘鐗囷紝璇风瓑寰呭墠闈㈢殑浠诲姟澶勭悊"},
        )


def _run_tracked_ip_image_task(task_key: str, task: dict[str, Any]) -> None:
    owner = str(task.get("owner") or "").strip()
    work = task.get("work") if isinstance(task.get("work"), dict) else {}
    try:
        _run_ip_image_task(
            task_key,
            ip=str(task.get("ip") or "").strip(),
            fingerprint=str(task.get("fingerprint") or "").strip(),
            quota_key=str(task.get("quota_key") or task.get("owner") or "").strip(),
            quota_limit=int(task.get("quota_limit") or _user_image_quota_limit()),
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
    quota_key: str,
    quota_limit: int,
    count: int,
    mode: str,
    payload: dict[str, Any] | None = None,
    fields: dict[str, str] | None = None,
    files: list[tuple[str, str, str, bytes]] | None = None,
    headers: dict[str, str],
) -> None:
    refunded_count = 0

    def refund_once(refund_count: int) -> None:
        nonlocal refunded_count
        refund_count = max(0, min(int(refund_count), count - refunded_count))
        if refund_count <= 0:
            return
        _refund_ip_quota(quota_key, refund_count, quota_limit)
        refunded_count += refund_count

    _update_ip_task(task_key, status="running", error="")
    try:
        task_prompt = str((fields or {}).get("prompt") or (payload or {}).get("prompt") or "")
        proxy_done = Event()
        proxy_result: dict[str, Any] = {}

        def run_proxy_request() -> None:
            try:
                if mode == "edit":
                    proxy_status, proxy_data = _proxy_image_edit(fields or {}, files or [], headers)
                else:
                    proxy_status, proxy_data = _proxy_image_generation(payload or {}, headers)
                proxy_result["status"] = proxy_status
                proxy_result["data"] = proxy_data
            except Exception as proxy_exc:
                proxy_result["error"] = proxy_exc
            finally:
                proxy_done.set()

        Thread(target=run_proxy_request, daemon=True, name=f"ip-image-proxy-{task_key[-16:]}").start()
        if _image_prompt_safety_violation(task_prompt):
            refund_once(count)
            raise RuntimeError(IMAGE_PROMPT_SAFETY_NOTICE)

        proxy_done.wait()
        if isinstance(proxy_result.get("error"), Exception):
            raise proxy_result["error"]
        status = int(proxy_result.get("status") or 500)
        data = proxy_result.get("data") if isinstance(proxy_result.get("data"), dict) else {}
        if status >= 400:
            refund_once(count)
            message = _error_text(data) if isinstance(data, dict) else ""
            raise RuntimeError(message or f"鍥剧墖鐢熸垚澶辫触 ({status})")
        usable_count = _usable_image_count(data) if isinstance(data, dict) else 0
        if usable_count < count:
            refund_once(count - usable_count)
        if usable_count == 0:
            raise RuntimeError("鎺ュ彛娌℃湁杩斿洖鍥剧墖鏁版嵁")
        if isinstance(data, dict):
            data = _recall_image_data(data, headers)
        stable_count = _stable_image_count(data) if isinstance(data, dict) else 0
        if stable_count == 0:
            refund_once(usable_count)
            raise RuntimeError("image completed but image recall failed")
        if stable_count < usable_count:
            refund_once(usable_count - stable_count)
        _update_ip_task(task_key, status="success", data=data.get("data", []), error="", work=None)
    except Exception as exc:
        refund_once(count)
        _update_ip_task(task_key, status="error", data=[], error=str(exc) or "鍥剧墖鐢熸垚澶辫触", work=None)


def _proxy_image_generation(payload: dict[str, Any], headers: dict[str, str]) -> tuple[int, dict[str, Any]]:
    body = json.dumps(payload).encode("utf-8")
    request_headers = {
        **headers,
        "Accept": "application/json",
        "User-Agent": "curl/8.0.1",
    }
    for attempt in range(max(1, IMAGE_PROXY_RETRIES + 1)):
        request = urllib.request.Request(
            f"{IMAGE_PROXY_BASE_URL}/v1/images/generations",
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
            return 502, {"error": f"image proxy request failed: {_proxy_error_message(exc)}"}


def _proxy_prompt_polish(prompt: str, mode: str, headers: dict[str, str]) -> tuple[int, dict[str, Any]]:
    base_url, model, api_key = _prompt_polish_settings()
    instruction = """
浣犳槸涓撲笟鐨?AI 鍥剧墖鎻愮ず璇嶈璁″笀锛岃礋璐ｆ妸鐢ㄦ埛鐨勭畝鐭兂娉曟敼鍐欐垚閫傚悎楂樿川閲忓浘鐗囩敓鎴愭垨鍥剧墖缂栬緫鐨勪腑鏂囨彁绀鸿瘝銆?
杈撳嚭瑕佹眰锛?1. 鍙緭鍑烘渶缁堟彁绀鸿瘝锛屼笉瑕佹爣棰樸€佽В閲娿€佺紪鍙枫€丮arkdown銆佸紩鍙枫€?2. 淇濈暀鐢ㄦ埛鍘熸剰锛屼笉娣诲姞浼氭敼鍙樹富浣撹韩浠姐€佷骇鍝併€佷汉鐗╂暟閲忋€佸搧鐗屻€佹枃瀛楀唴瀹规垨鏍稿績鍔ㄤ綔鐨勮瀹氥€?3. 鎻愮ず璇嶈鍏蜂綋銆佸彲鎵ц锛岄€傚悎鐩存帴鎻愪氦缁欏浘鐗囩敓鎴愭ā鍨嬨€?4. 浼樺厛琛ュ叏锛氫富浣撱€佸満鏅€佹瀯鍥俱€佹櫙鍒€侀暅澶磋瑷€銆佸厜绾裤€佽壊褰┿€佹潗璐ㄣ€佽川鎰熴€侀鏍笺€佹皼鍥淬€佸叧閿粏鑺傘€佺敾闈㈡竻鏅板害銆?5. 閬垮厤绌烘硾璇嶅爢鍙狅紝閬垮厤鈥滄渶楂樿川閲忋€佹澃浣溿€?K鈥濈瓑鏃犳剰涔夊爢鏂欙紱鍙互浣跨敤鑷劧鐨勬憚褰便€佹彃鐢汇€佽璁¤瑷€銆?6. 濡傛灉鐢ㄦ埛鏄庣‘瑕佹眰鏂囧瓧銆丩ogo銆乁I銆佸晢鍝併€佷汉鐗╃壒寰侊紝瑕佸己璋冨噯纭繚鐣欒繖浜涘厓绱犮€?7. 鍗充娇鐢ㄦ埛杈撳叆寰堢煭锛屼篃蹇呴』鐩存帴鍩轰簬鐜版湁淇℃伅鍚堢悊琛ュ叏骞惰緭鍑哄彲鐢ㄦ彁绀鸿瘝锛涚姝㈠弽闂紝绂佹瑕佹眰鐢ㄦ埛缁х画鎻愪緵淇℃伅銆?
鎺ㄨ崘妯℃澘锛?涓讳綋/瀵硅薄 + 鍏抽敭鐗瑰緛 + 鍦烘櫙鐜 + 鏋勫浘鍜屾櫙鍒?+ 鍏夌嚎鍜岃壊褰?+ 鏉愯川/璐ㄦ劅 + 椋庢牸鏂瑰悜 + 闇€瑕侀伩鍏嶇殑鍋忓樊銆?""".strip()
    if mode == "edit":
        instruction += """

褰撳墠鏄熀浜庡弬鑰冨浘鐨勫浘鐗囩紪杈戜换鍔°€傝棰濆閬靛畧锛?1. 鏄庣‘瑕佹眰淇濈暀鍙傝€冨浘鐨勪富浣撹韩浠姐€佸Э鎬併€佹瀯鍥俱€侀€忚銆佹瘮渚嬨€侀噸瑕佺墿浣撲綅缃拰鏁翠綋椋庢牸銆?2. 娓呮鎻忚堪瑕佷慨鏀广€佹浛鎹€佸寮烘垨鏂板鐨勯儴鍒嗐€?3. 涓嶈瑕佹眰妯″瀷閲嶇敾鏁村紶鍥撅紝闄ら潪鐢ㄦ埛鍘熸枃鏄庣‘瑕佹眰銆?4. 杈撳嚭搴旀洿鍍忊€滅紪杈戞寚浠?+ 瑙嗚缁嗚妭鈥濓紝璁╂ā鍨嬬煡閬撳摢浜涗繚鎸佷笉鍙樸€佸摢浜涢渶瑕佹敼鍙樸€?""".rstrip()
    else:
        instruction += """

褰撳墠鏄枃鐢熷浘浠诲姟銆傝鎶婄敤鎴锋兂娉曟墿灞曚负瀹屾暣鐢婚潰鎻忚堪锛岄噸鐐规彁鍗囦富浣撳彲瑙佹€с€佹瀯鍥剧ǔ瀹氭€с€佸缇庨鏍煎拰鏈€缁堝嚭鍥惧彲鎺ф€с€?""".rstrip()
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": instruction},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.45,
        "stream": False,
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request_headers = {
        **headers,
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "curl/8.0.1",
    }
    if api_key:
        request_headers["Authorization"] = f"Bearer {api_key}"
    request = urllib.request.Request(
        f"{base_url}/chat/completions",
        data=body,
        headers=request_headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=IMAGE_PROXY_TIMEOUT) as response:
            data = _decode_proxy_body(response.read())
            text = _chat_text_from_response(data)
            if text:
                data["text"] = text
            return response.status, data
    except urllib.error.HTTPError as exc:
        return exc.code, _decode_proxy_body(exc.read())
    except (urllib.error.URLError, TimeoutError, socket.timeout, OSError) as exc:
        return 502, {"error": f"prompt polish request failed: {_proxy_error_message(exc)}"}


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
    request_headers = {
        **headers,
        "Accept": "application/json",
        "Content-Type": content_type,
        "User-Agent": "curl/8.0.1",
    }
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
    app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=6)
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
        subject = _quota_subject(request, ip, fingerprint)
        _refund_ip_quota(str(subject["key"]), count)
        return _ip_quota_payload(request, ip, fingerprint)

    @app.post("/api/ip-limited/share-link")
    async def create_image_share_link(request: Request):
        ip = _client_ip(request)
        fingerprint = _device_fingerprint(request)
        subject = _quota_subject(request, ip, fingerprint)
        reward = _create_image_share_reward(subject)
        return {
            **reward,
            "share_path": f"/image?share={reward['code']}",
        }

    @app.post("/api/ip-limited/share-link/redeem")
    async def redeem_image_share_link(request: Request):
        payload = await _read_json_object(request)
        code = str(payload.get("code") or "").strip()
        ip = _client_ip(request)
        fingerprint = _device_fingerprint(request)
        redeemer = _quota_subject(request, ip, fingerprint)
        result = _redeem_image_share_reward(code, redeemer)
        return {
            **result,
            "ip_quota": _ip_quota_payload(request, ip, fingerprint),
        }

    @app.post("/api/ip-limited/prompt-polish")
    async def polish_prompt(request: Request):
        ip = _client_ip(request)
        fingerprint = _device_fingerprint(request)
        payload = await _read_json_object(request)
        prompt = str(payload.get("prompt") or "").strip()
        mode = "edit" if payload.get("mode") == "edit" else "generate"
        if not prompt:
            raise HTTPException(status_code=400, detail={"error": "prompt is required"})
        if len(prompt) > 2000:
            raise HTTPException(status_code=400, detail={"error": "prompt is too long"})

        headers = {
            "Authorization": _proxy_authorization(request),
            "X-Device-Fingerprint": fingerprint,
        }
        status, data = _proxy_prompt_polish(prompt, mode, headers)
        if status >= 400:
            return JSONResponse(status_code=status, content=data)
        polished = _chat_text_from_response(data) if isinstance(data, dict) else ""
        if not polished:
            return JSONResponse(status_code=502, content={"error": "AI 娌℃湁杩斿洖娑﹁壊缁撴灉"})
        return {"text": polished, "model": _prompt_polish_settings()[1]}

    @app.get("/api/ip-limited/image-tasks")
    async def list_ip_image_tasks(request: Request, ids: str = ""):
        ip = _client_ip(request)
        fingerprint = _device_fingerprint(request)
        subject = _quota_subject(request, ip, fingerprint)
        owner = str(subject["key"])
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
        subject = _quota_subject(request, ip, fingerprint)
        owner = str(subject["key"])
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
                            "quota_key": str(subject["key"]),
                            "quota_limit": int(subject["limit"]),
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
            _ensure_owner_queue_capacity(items, owner)
            _consume_ip_quota(str(subject["key"]), int(subject["limit"]), 1)
            now = _now_iso()
            task = {
                "id": task_id,
                "owner": owner,
                "quota_key": str(subject["key"]),
                "quota_limit": int(subject["limit"]),
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
        subject = _quota_subject(request, ip, fingerprint)
        owner = str(subject["key"])
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
                            "quota_key": str(subject["key"]),
                            "quota_limit": int(subject["limit"]),
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
            _ensure_owner_queue_capacity(items, owner)
            _consume_ip_quota(str(subject["key"]), int(subject["limit"]), 1)
            now = _now_iso()
            task = {
                "id": task_id,
                "owner": owner,
                "quota_key": str(subject["key"]),
                "quota_limit": int(subject["limit"]),
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
        subject = _quota_subject(request, ip, fingerprint)

        count = max(1, min(2, int(payload.get("n") or 1)))
        payload["n"] = count
        _consume_ip_quota(str(subject["key"]), int(subject["limit"]), count)
        prompt = str(payload.get("prompt") or "")
        if _image_prompt_safety_violation(prompt):
            _refund_ip_quota(str(subject["key"]), count, int(subject["limit"]))
            return JSONResponse(status_code=400, content={"error": IMAGE_PROMPT_SAFETY_NOTICE})

        headers = {
            "Content-Type": "application/json",
            "Authorization": _proxy_authorization(request),
            "X-Device-Fingerprint": fingerprint,
        }
        status, data = _proxy_image_generation(payload, headers)
        if status >= 400:
            _refund_ip_quota(str(subject["key"]), count, int(subject["limit"]))
            return JSONResponse(status_code=status, content=data)
        usable_count = _usable_image_count(data) if isinstance(data, dict) else 0
        if usable_count < count:
            _refund_ip_quota(str(subject["key"]), count - usable_count, int(subject["limit"]))
        if usable_count == 0:
            return JSONResponse(status_code=502, content={"error": "图片生成失败，接口没有返回图片数据"})
        if isinstance(data, dict):
            data = _recall_image_data(data, headers)
            stable_count = _stable_image_count(data)
            if stable_count == 0:
                _refund_ip_quota(str(subject["key"]), usable_count, int(subject["limit"]))
                return JSONResponse(status_code=502, content={"error": "image completed but image recall failed"})
            if stable_count < usable_count:
                _refund_ip_quota(str(subject["key"]), usable_count - stable_count, int(subject["limit"]))
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
        subject = _quota_subject(request, ip, fingerprint)
        count = max(1, min(2, int(n or 1)))
        if not prompt.strip():
            raise HTTPException(status_code=400, detail={"error": "prompt is required"})
        if not image:
            raise HTTPException(status_code=400, detail={"error": "image is required"})

        files = await _read_edit_uploads(image)
        _consume_ip_quota(str(subject["key"]), int(subject["limit"]), count)
        if _image_prompt_safety_violation(prompt):
            _refund_ip_quota(str(subject["key"]), count, int(subject["limit"]))
            return JSONResponse(status_code=400, content={"error": IMAGE_PROMPT_SAFETY_NOTICE})
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
        }
        status, data = _proxy_image_edit(fields, files, headers)
        if status >= 400:
            _refund_ip_quota(str(subject["key"]), count, int(subject["limit"]))
            return JSONResponse(status_code=status, content=data)
        usable_count = _usable_image_count(data) if isinstance(data, dict) else 0
        if usable_count < count:
            _refund_ip_quota(str(subject["key"]), count - usable_count, int(subject["limit"]))
        if usable_count == 0:
            return JSONResponse(status_code=502, content={"error": "图片编辑失败，接口没有返回图片数据"})
        if isinstance(data, dict):
            data = _recall_image_data(data, headers)
            stable_count = _stable_image_count(data)
            if stable_count == 0:
                _refund_ip_quota(str(subject["key"]), usable_count, int(subject["limit"]))
                return JSONResponse(status_code=502, content={"error": "image completed but image recall failed"})
            if stable_count < usable_count:
                _refund_ip_quota(str(subject["key"]), usable_count - stable_count, int(subject["limit"]))
            data["ip_quota"] = _ip_quota_payload(request, ip, fingerprint)
        return JSONResponse(status_code=status, content=data)

    @app.api_route("/{full_path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    async def serve_web(full_path: str):
        asset = resolve_web_asset(full_path)
        if asset is not None:
            return FileResponse(asset, headers=_web_asset_headers(asset))
        if full_path.strip("/").startswith("_next/"):
            raise HTTPException(status_code=404, detail="Not Found")
        fallback = resolve_web_asset("")
        if fallback is None:
            raise HTTPException(status_code=404, detail="Not Found")
        return FileResponse(fallback, headers=_web_asset_headers(fallback))

    return app

