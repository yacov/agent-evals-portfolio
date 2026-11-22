"""Shared helpers for the voice-agent evaluation scripts."""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUBRIC_DIR = ROOT / "rubrics"
SCENARIO_DIR = ROOT / "scenarios"
SCHEMA_DIR = ROOT / "schemas"
FIXTURE_DIR = ROOT / "fixtures"
