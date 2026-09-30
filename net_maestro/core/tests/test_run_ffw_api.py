"""Tests for the FFW run data endpoints."""

from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from net_maestro.core.constants import FFWStatsType, SimulationType
from net_maestro.core.models import FFWResultFile, FFWSimulationConfig, FFWTerminalRecord, Run
from net_maestro.core.tests.factories import UserFactory

if TYPE_CHECKING:
    from pathlib import Path

    from pytest_django.fixtures import SettingsWrapper
    from rest_framework.test import APIClient

TOPOLOGY_YAML = """
topology:
  switches:
    LOSA:
      terminals: 2
      terminal_bandwidth: "100 Gbps"
      switch_buffer: "2 Gb"
      connections:
        SALT: "1200 Gbps"
    SALT:
      terminals: 2
      terminal_bandwidth: "100 Gbps"
      switch_buffer: "2 Gb"
      connections:
        LOSA: "1200 Gbps"
"""


@pytest.mark.django_db
def test_infinite_gvt_is_returned_as_null(api_client: APIClient) -> None:
    """ROSS reports GVT as infinity once a run finishes; JSON has no infinity."""
    api_client.force_authenticate(user=UserFactory.create())
    run = Run.objects.create(name="ffw", simulation_type=SimulationType.FFW)
    result_file = FFWResultFile.objects.create(run=run, file="results/ross-stats-model.bin")
    FFWTerminalRecord.objects.create(
        result_file=result_file,
        stats_type=FFWStatsType.GVT,
        ts=17_000_000_000,
        gvt=float("inf"),
        peid=0,
        kpid=0,
        lpid=8,
        terminal_id=0,
    )

    resp = api_client.get(f"/api/v1/runs/{run.id}/ffw-terminals")

    assert resp.status_code == 200
    assert resp.json()["data"][0]["gvt"] is None


@pytest.mark.django_db
def test_datasets_reports_switch_names_in_switch_id_order(
    api_client: APIClient, tmp_path: Path, settings: SettingsWrapper
) -> None:
    """The heatmap labels its axes with these, so the order has to be the file's."""
    settings.TOPOLOGY_DIR = tmp_path
    (tmp_path / "two-site.yaml").write_text(TOPOLOGY_YAML, encoding="utf-8")
    api_client.force_authenticate(user=UserFactory.create())
    run = Run.objects.create(name="ffw", simulation_type=SimulationType.FFW)
    FFWSimulationConfig.objects.create(run=run, topology_name="two-site")

    resp = api_client.get(f"/api/v1/runs/{run.id}/datasets")

    assert resp.status_code == 200
    assert resp.json()["switch_names"] == ["LOSA", "SALT"]


@pytest.mark.django_db
def test_datasets_reports_no_switch_names_without_a_topology(
    api_client: APIClient, tmp_path: Path, settings: SettingsWrapper
) -> None:
    """A run whose topology file is gone still plots, on switch ids."""
    settings.TOPOLOGY_DIR = tmp_path
    api_client.force_authenticate(user=UserFactory.create())
    run = Run.objects.create(name="ffw", simulation_type=SimulationType.FFW)
    FFWSimulationConfig.objects.create(run=run, topology_name="deleted-since-the-run")

    resp = api_client.get(f"/api/v1/runs/{run.id}/datasets")

    assert resp.status_code == 200
    assert resp.json()["switch_names"] == []


@pytest.mark.django_db
def test_datasets_reports_no_switch_names_for_a_non_ffw_run(api_client: APIClient) -> None:
    api_client.force_authenticate(user=UserFactory.create())
    run = Run.objects.create(name="phold", simulation_type=SimulationType.PHOLD)

    resp = api_client.get(f"/api/v1/runs/{run.id}/datasets")

    assert resp.status_code == 200
    assert resp.json()["switch_names"] == []
