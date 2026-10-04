from __future__ import annotations

from conftest import MockMCPClient, run_check

from checks.sch_04_net_naming import SchNetNaming


def test_passes_on_functional_names():
    connectivity = {
        "nets": {"I2C_SCL": [], "UART_TX": [], "+3V3": [], "GND": []},
        "components": {},
    }
    assert run_check(SchNetNaming, MockMCPClient(connectivity=connectivity)) == []


def test_flags_auto_generated_names():
    connectivity = {
        "nets": {"NET42": [], "SIG1": [], "N$5": [], "I2C_SCL": []},
        "components": {},
    }
    findings = run_check(SchNetNaming, MockMCPClient(connectivity=connectivity))
    assert len(findings) == 1
    ids = findings[0]["offending_ids"]
    assert "NET42" in ids and "SIG1" in ids and "N$5" in ids
    assert "I2C_SCL" not in ids
    assert findings[0]["severity"] == "info"
