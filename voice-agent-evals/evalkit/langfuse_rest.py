"""Minimal Langfuse public REST API client (standard library only).

Credentials come only from the environment: LANGFUSE_PUBLIC_KEY,
LANGFUSE_SECRET_KEY and LANGFUSE_HOST (default: Langfuse cloud).
"""

from __future__ import annotations

import base64
import json
import os
import ssl
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

DEFAULT_HOST = "https://cloud.langfuse.com"


class LangfuseRestClient:
    def __init__(self, public_key: str, secret_key: str, host: str = DEFAULT_HOST, timeout: int = 30) -> None:
        self.host = host.rstrip("/")
        self._base = f"{self.host}/api/public"
        token = base64.b64encode(f"{public_key}:{secret_key}".encode()).decode()
        self._headers = {"Authorization": f"Basic {token}", "Content-Type": "application/json"}
        self._ssl = ssl.create_default_context()
        self._timeout = timeout

    @classmethod
    def from_env(cls) -> LangfuseRestClient:
        public_key = os.environ.get("LANGFUSE_PUBLIC_KEY", "")
        secret_key = os.environ.get("LANGFUSE_SECRET_KEY", "")
        if not public_key or not secret_key:
            raise RuntimeError("Set LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY")
        return cls(public_key, secret_key, os.environ.get("LANGFUSE_HOST", DEFAULT_HOST))

    # ------------------------------------------------------------------ transport

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        request = urllib.request.Request(f"{self._base}{path}", data=data, headers=self._headers, method=method)
        with urllib.request.urlopen(request, context=self._ssl, timeout=self._timeout) as response:
            return json.loads(response.read() or b"null")

    def get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        if params:
            pairs = [(k, item) for k, v in params.items() if v is not None
                     for item in (v if isinstance(v, list) else [v])]
            path = f"{path}?{urllib.parse.urlencode(pairs)}"
        return self._request("GET", path)

    def post(self, path: str, body: dict[str, Any], *, conflict_ok: bool = False) -> Any:
        try:
            return self._request("POST", path, body)
        except urllib.error.HTTPError as exc:
            if exc.code == 409 and conflict_ok:
                return {"conflict": True}
            detail = exc.read().decode(errors="replace")
            raise RuntimeError(f"POST {path} failed with HTTP {exc.code}: {detail}") from exc

    # ------------------------------------------------------------------ endpoints

    def fetch_traces(self, *, tags: list[str] | None = None, session_id: str | None = None,
                     limit: int = 50, page: int = 1) -> list[dict[str, Any]]:
        params = {"tags": tags, "sessionId": session_id, "limit": limit, "page": page}
        return (self.get("/traces", params) or {}).get("data", [])

    def fetch_trace(self, trace_id: str) -> dict[str, Any]:
        """One trace including its observations."""
        return self.get(f"/traces/{urllib.parse.quote(trace_id)}")

    def create_dataset(self, name: str, description: str, metadata: dict[str, Any] | None = None) -> Any:
        body: dict[str, Any] = {"name": name, "description": description}
        if metadata:
            body["metadata"] = metadata
        return self.post("/v2/datasets", body, conflict_ok=True)

    def create_dataset_item(self, dataset_name: str, *, input: Any, expected_output: Any,
                            metadata: dict[str, Any] | None = None, source_trace_id: str | None = None) -> Any:
        body: dict[str, Any] = {"datasetName": dataset_name, "input": input, "expectedOutput": expected_output}
        if metadata:
            body["metadata"] = metadata
        if source_trace_id:
            body["sourceTraceId"] = source_trace_id
        return self.post("/dataset-items", body)
