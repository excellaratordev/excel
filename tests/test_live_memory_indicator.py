from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_memory_indicator_precedes_runtime_label():
    template = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
    memory_position = template.index('id="memory-usage"')
    runtime_position = template.index("SuperExcel Runtime 0.2")

    assert memory_position < runtime_position
    assert "RAM: medindo…" in template


def test_memory_indicator_updates_every_second():
    script = (ROOT / "static" / "js" / "performance-telemetry.js").read_text(encoding="utf-8")

    assert "const MEMORY_DISPLAY_INTERVAL_MS = 1000" in script
    assert "performance.memory" in script
    assert "measureUserAgentSpecificMemory" in script
    assert "RAM: n/d" in script
