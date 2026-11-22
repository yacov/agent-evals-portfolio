"""Test setup: no network, no credentials, synthetic fixtures only."""

from __future__ import annotations

import socket

import pytest

from evalkit import FIXTURE_DIR
from evalkit.dataset import load_jsonl

SECRET_ENV = [
    "OPENAI_API_KEY", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_HOST",
    "CEKURA_API_KEY", "CEKURA_AGENT_ID", "CEKURA_PROJECT_ID",
]


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    """Fail loudly if any test tries to open a network connection or read a real key."""
    for name in SECRET_ENV:
        monkeypatch.delenv(name, raising=False)

    def refuse(*args, **kwargs):
        raise RuntimeError("network access is not allowed in tests")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)


@pytest.fixture(scope="session")
def offline_items():
    return load_jsonl(FIXTURE_DIR / "offline_dataset.jsonl")


@pytest.fixture
def items_by_id(offline_items):
    return {item["id"]: item for item in offline_items}
