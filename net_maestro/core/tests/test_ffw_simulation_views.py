"""Tests for the FFW simulation config view."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

from django.urls import reverse
import pytest

if TYPE_CHECKING:
    from pathlib import Path

    from django.test import Client
    from pytest_django.fixtures import SettingsWrapper

pytestmark = pytest.mark.django_db

TOPOLOGY_YAML = """
topology:
  switches:
    A:
      terminals: 2
      terminal_bandwidth: "100 Gbps"
      switch_buffer: "64 Gb"
      connections:
        B: "100 Gbps"
    B:
      terminals: 2
      terminal_bandwidth: "100 Gbps"
      switch_buffer: "64 Gb"
      connections:
        A: "100 Gbps"
"""


@pytest.fixture
def preset(tmp_path: Path, settings: SettingsWrapper) -> str:
    """Write one topology preset and point the topology directory at it."""
    settings.TOPOLOGY_DIR = tmp_path
    name = "ffw-fabric-2-site"
    (tmp_path / f"{name}.yaml").write_text(TOPOLOGY_YAML, encoding="utf-8")
    return name


def _selected_option(content: str) -> str | None:
    """Return the value selected in the topology dropdown, if any.

    Scoped to that one dropdown: the form's other selects render a selected
    option of their own from the model's defaults.
    """
    picker = content.split('name="topology_name"', 1)[1].split("</select>", 1)[0]
    match = re.search(r'<option value="([^"]*)" selected', picker)
    return match.group(1) if match else None


def test_topology_parameter_preselects_the_topology(client: Client, preset: str) -> None:
    """The topology page hands its selected preset to the run screen."""
    response = client.get(reverse("new-ffw-simulation-config"), {"topology": preset})

    assert response.status_code == 200
    assert response.context["form"].initial["topology_name"] == preset
    assert _selected_option(response.content.decode()) == preset


def test_no_topology_parameter_selects_nothing(client: Client, preset: str) -> None:
    response = client.get(reverse("new-ffw-simulation-config"))

    assert response.status_code == 200
    assert _selected_option(response.content.decode()) is None


def test_unknown_topology_is_left_unselected(client: Client, preset: str) -> None:
    """A stale name still renders the form; the dropdown just starts empty."""
    response = client.get(reverse("new-ffw-simulation-config"), {"topology": "does-not-exist"})

    assert response.status_code == 200
    assert _selected_option(response.content.decode()) is None
