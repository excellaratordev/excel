from __future__ import annotations

import hashlib
import threading
import time
from collections import OrderedDict
from typing import Any, Callable

_AUTH_TTL = 40.0
_ROLE_TTL = 5.0
_MAX_ENTRIES = 2000
_LOCK = threading.Lock()
_AUTH_CACHE: OrderedDict[str, tuple[float, dict[str, Any]]] = OrderedDict()
_ROLE_CACHE: OrderedDict[tuple[int, str], tuple[float, dict[str, Any], str | None]] = OrderedDict()


def _trim(cache: OrderedDict) -> None:
    while len(cache) > _MAX_ENTRIES:
        cache.popitem(last=False)


def install(backend_module) -> None:
    original_verify: Callable = backend_module.verify_user_token
    original_role: Callable = backend_module.get_project_role

    def cached_verify(token: str):
        now = time.monotonic()
        key = hashlib.sha256(token.encode("utf-8")).hexdigest()
        with _LOCK:
            cached = _AUTH_CACHE.get(key)
            if cached and cached[0] > now:
                _AUTH_CACHE.move_to_end(key)
                return dict(cached[1]), None
            _AUTH_CACHE.pop(key, None)

        user, error = original_verify(token)
        if error is None and isinstance(user, dict):
            with _LOCK:
                _AUTH_CACHE[key] = (now + _AUTH_TTL, dict(user))
                _AUTH_CACHE.move_to_end(key)
                _trim(_AUTH_CACHE)
        return user, error

    def cached_project_role(project_id: int, email: str | None = None):
        normalized_email = backend_module.normalize_email(email or backend_module.current_email())
        key = (int(project_id), normalized_email)
        now = time.monotonic()
        with _LOCK:
            cached = _ROLE_CACHE.get(key)
            if cached and cached[0] > now:
                _ROLE_CACHE.move_to_end(key)
                return dict(cached[1]), cached[2], None
            _ROLE_CACHE.pop(key, None)

        project, role, response = original_role(project_id, normalized_email)
        if response is None and isinstance(project, dict):
            with _LOCK:
                _ROLE_CACHE[key] = (now + _ROLE_TTL, dict(project), role)
                _ROLE_CACHE.move_to_end(key)
                _trim(_ROLE_CACHE)
        return project, role, response

    backend_module.verify_user_token = cached_verify
    backend_module.get_project_role = cached_project_role