from __future__ import annotations

import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Any

MAX_SAMPLES_PER_WORKBOOK = 120


@dataclass(slots=True)
class WorkbookTelemetry:
    workbook_id: int
    samples: deque[dict[str, Any]] = field(
        default_factory=lambda: deque(maxlen=MAX_SAMPLES_PER_WORKBOOK)
    )

    def add(self, sample: dict[str, Any]) -> dict[str, Any]:
        normalized = dict(sample)
        normalized["recorded_at"] = time.time()
        self.samples.append(normalized)
        return normalized

    def summary(self) -> dict[str, Any]:
        if not self.samples:
            return {"workbook_id": self.workbook_id, "sample_count": 0}

        latest = dict(self.samples[-1])
        numeric_keys: set[str] = set()
        for sample in self.samples:
            for key, value in sample.items():
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    numeric_keys.add(key)

        averages: dict[str, float] = {}
        maximums: dict[str, float] = {}
        for key in numeric_keys:
            values = [
                float(sample[key])
                for sample in self.samples
                if isinstance(sample.get(key), (int, float))
                and not isinstance(sample.get(key), bool)
            ]
            if values:
                averages[key] = sum(values) / len(values)
                maximums[key] = max(values)

        return {
            "workbook_id": self.workbook_id,
            "sample_count": len(self.samples),
            "latest": latest,
            "average": averages,
            "maximum": maximums,
        }


class TelemetryRegistry:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._workbooks: dict[int, WorkbookTelemetry] = defaultdict(
            lambda: WorkbookTelemetry(workbook_id=0)
        )

    def record(self, workbook_id: int, sample: dict[str, Any]) -> dict[str, Any]:
        numeric_id = int(workbook_id)
        with self._lock:
            telemetry = self._workbooks.get(numeric_id)
            if telemetry is None:
                telemetry = WorkbookTelemetry(workbook_id=numeric_id)
                self._workbooks[numeric_id] = telemetry
            return telemetry.add(sample)

    def summary(self, workbook_id: int) -> dict[str, Any]:
        numeric_id = int(workbook_id)
        with self._lock:
            telemetry = self._workbooks.get(numeric_id)
            return telemetry.summary() if telemetry else {
                "workbook_id": numeric_id,
                "sample_count": 0,
            }

    def summaries(self, workbook_ids: list[int]) -> dict[int, dict[str, Any]]:
        with self._lock:
            result: dict[int, dict[str, Any]] = {}
            for workbook_id in workbook_ids:
                numeric_id = int(workbook_id)
                telemetry = self._workbooks.get(numeric_id)
                result[numeric_id] = telemetry.summary() if telemetry else {
                    "workbook_id": numeric_id,
                    "sample_count": 0,
                }
            return result


registry = TelemetryRegistry()
