"""Tests for reading, listing, and saving topologies through the API."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from django.urls import reverse
import pytest
import yaml

if TYPE_CHECKING:
    from pathlib import Path

    from django.test import Client
    from pytest_django.fixtures import SettingsWrapper
    from rest_framework.test import APIClient

from net_maestro.core import topology
from net_maestro.core.tests.factories import UserFactory

# Saving needs an authenticated user, which needs the database.
pytestmark = pytest.mark.django_db

URL = "/api/v1/topologies"

PAYLOAD: dict[str, Any] = {
    "name": "two-switch",
    "switches": [
        {
            "name": "A",
            "terminals": 2,
            "terminal_bandwidth_gbps": 100,
            "switch_buffer_gb": 64,
            "connections": [{"target": "B", "bandwidth_gbps": 18.3324}],
        },
        {
            "name": "B",
            "terminals": 1,
            "terminal_bandwidth_gbps": 100,
            "switch_buffer_gb": 64,
            "connections": [],
        },
    ],
}


@pytest.fixture
def topology_dir(tmp_path: Path, settings: SettingsWrapper) -> Path:
    """Point the topology directory at an empty temporary directory."""
    settings.TOPOLOGY_DIR = tmp_path
    return tmp_path


@pytest.fixture
def api_client(api_client: APIClient) -> APIClient:
    api_client.force_authenticate(user=UserFactory.create())
    return api_client


def test_save_writes_topology_yaml(api_client: APIClient, topology_dir: Path) -> None:
    resp = api_client.post(URL, PAYLOAD, format="json")

    assert resp.status_code == 201
    document = yaml.safe_load((topology_dir / "two-switch.yaml").read_text())
    assert document == {
        "topology": {
            "switches": {
                "A": {
                    "terminals": 2,
                    "terminal_bandwidth": "100 Gbps",
                    "switch_buffer": "64 Gb",
                    "connections": {"B": "18.3324 Gbps"},
                },
                "B": {
                    "terminals": 1,
                    "terminal_bandwidth": "100 Gbps",
                    "switch_buffer": "64 Gb",
                },
            }
        }
    }


def test_saved_topology_is_immediately_listed(api_client: APIClient, topology_dir: Path) -> None:
    resp = api_client.post(URL, PAYLOAD, format="json")

    assert resp.data["url"] == "/api/v1/topologies/two-switch"
    assert resp.data["summary"] == "2 switches, 3 terminals, 1 links"
    assert [t.name for t in topology.list_topologies()] == ["two-switch"]

    reloaded = api_client.get(resp.data["url"])
    assert reloaded.status_code == 200
    assert reloaded.data["switches"][0]["terminal_bandwidth_gbps"] == 100
    assert reloaded.data["switches"][0]["switch_buffer_gb"] == 64
    assert reloaded.data["links"][0]["bandwidth_gbps"] == 18.3324
    assert reloaded.data["links"][0]["bandwidth_label"] == "18.3 Gbps"


def test_simulation_inputs_number_terminals_in_switch_order(
    api_client: APIClient, topology_dir: Path
) -> None:
    """Terminal ids run consecutively through the switches, as the model numbers them.

    The expected ids were confirmed against a real run: a 1/3/2 topology made the
    model report terminals 0 on switch 0, 1-3 on switch 1, and 4-5 on switch 2.
    """
    uneven = [
        {**PAYLOAD["switches"][0], "terminals": 1},
        {**PAYLOAD["switches"][1], "terminals": 3},
    ]
    api_client.post(URL, {**PAYLOAD, "switches": uneven}, format="json")

    resp = api_client.get(f"{URL}/two-switch/simulation-inputs")

    assert resp.status_code == 200
    assert resp.data["topology_yaml_file"] == "two-switch.yaml"
    assert resp.data["lps"] == {
        "fluid-flow-wan-switch-lp": 2,
        "fluid-flow-wan-terminal-lp": 4,
    }
    assert [
        (s["name"], s["first_terminal_id"], s["terminal_count"]) for s in resp.data["switches"]
    ] == [
        ("A", 0, 1),
        ("B", 1, 3),
    ]


def test_simulation_inputs_for_an_unknown_topology(
    api_client: APIClient, topology_dir: Path
) -> None:
    assert api_client.get(f"{URL}/nope/simulation-inputs").status_code == 404


def test_checked_in_preset_reads_as_gigabits(
    api_client: APIClient, settings: SettingsWrapper
) -> None:
    """The units in the presets shipped in this repo are stripped off on the way in."""
    settings.TOPOLOGY_DIR = settings.BASE_DIR / "data" / "topologies"
    resp = api_client.get("/api/v1/topologies/fluid-flow-wan-3-switch")

    assert resp.status_code == 200
    assert resp.data["switches"][0]["terminal_bandwidth_gbps"] == 100
    assert resp.data["switches"][0]["switch_buffer_gb"] == 64
    assert resp.data["links"][0]["bandwidth_gbps"] == 30


def test_other_yaml_in_the_directory_is_ignored(api_client: APIClient, topology_dir: Path) -> None:
    """Only YAML files that are topologies are listed."""
    (topology_dir / "fluid-flow-wan-random-traffic.yaml").write_text(
        "topology:\n  format: groups\n  groups:\n    FLUID_FLOW_WAN_GRP:\n      repetitions: 1\n"
    )
    api_client.post(URL, PAYLOAD, format="json")

    assert [t.name for t in topology.list_topologies()] == ["two-switch"]


def test_unparseable_yaml_does_not_break_the_listing(
    api_client: APIClient, topology_dir: Path
) -> None:
    """A broken file in the directory must not take the topology page down."""
    (topology_dir / "broken.yaml").write_text("topology:\n  switches:\n    A: [unclosed\n")
    api_client.post(URL, PAYLOAD, format="json")

    assert [t.name for t in topology.list_topologies()] == ["two-switch"]


@pytest.mark.parametrize("terminals", ["lots", -1])
def test_bad_terminal_counts_do_not_break_the_listing(
    api_client: APIClient, topology_dir: Path, terminals: object
) -> None:
    (topology_dir / "bad-terminals.yaml").write_text(
        f"topology:\n  switches:\n    A:\n      terminals: {terminals}\n"
    )
    api_client.post(URL, PAYLOAD, format="json")

    assert [t.name for t in topology.list_topologies()] == ["two-switch"]


def test_topologies_are_listed_by_switch_count_then_name(
    api_client: APIClient, topology_dir: Path
) -> None:
    """The dropdown shows the smallest topologies first, alphabetically within a size."""
    three_switches = [*PAYLOAD["switches"], {**PAYLOAD["switches"][1], "name": "C"}]
    api_client.post(URL, {**PAYLOAD, "name": "zulu"}, format="json")
    api_client.post(URL, {**PAYLOAD, "name": "alpha"}, format="json")
    api_client.post(URL, {**PAYLOAD, "name": "trio", "switches": three_switches}, format="json")

    assert [t.name for t in topology.list_topologies()] == ["alpha", "zulu", "trio"]


def test_family_narrows_the_list_to_matching_names(
    api_client: APIClient, topology_dir: Path
) -> None:
    """The Available Models page opens the topology page on one model's presets."""
    api_client.post(URL, {**PAYLOAD, "name": "ffw-fabric-5-site"}, format="json")
    api_client.post(URL, {**PAYLOAD, "name": "ffw-fabric-2-site"}, format="json")
    api_client.post(URL, {**PAYLOAD, "name": "ffw-8-switch"}, format="json")

    names = [t.name for t in topology.list_topologies(family="fabric")]

    assert names == ["ffw-fabric-2-site", "ffw-fabric-5-site"]


def test_family_matches_whole_words_only(api_client: APIClient, topology_dir: Path) -> None:
    """`fabric` must not also pull in a name that merely starts with it."""
    api_client.post(URL, {**PAYLOAD, "name": "fabricated-topology"}, format="json")

    assert topology.list_topologies(family="fabric") == ()


def test_no_family_lists_everything(api_client: APIClient, topology_dir: Path) -> None:
    api_client.post(URL, {**PAYLOAD, "name": "ffw-fabric-5-site"}, format="json")
    api_client.post(URL, {**PAYLOAD, "name": "ffw-8-switch"}, format="json")

    assert len(topology.list_topologies()) == 2


def test_family_label_keeps_fabric_uppercase() -> None:
    assert topology.family_label("fabric") == "FABRIC"
    assert topology.family_label("wan") == "WAN"
    assert topology.family_label("dragonfly") == "Dragonfly"


def test_topology_page_honours_the_family_parameter(
    api_client: APIClient, client: Client, topology_dir: Path
) -> None:
    """Arriving from the NSF FABRIC Testbed card shows the FABRIC presets alone."""
    api_client.post(URL, {**PAYLOAD, "name": "ffw-fabric-5-site"}, format="json")
    api_client.post(URL, {**PAYLOAD, "name": "ffw-8-switch"}, format="json")

    resp = client.get(reverse("topology-partial"), {"family": "fabric"})
    content = resp.content.decode()

    assert resp.status_code == 200
    assert [t.name for t in resp.context["topologies"]] == ["ffw-fabric-5-site"]
    assert "Showing FABRIC topologies only." in content
    assert "ffw-8-switch" not in content


def test_topology_page_offers_a_run_link_carrying_the_picker(
    api_client: APIClient, client: Client, topology_dir: Path
) -> None:
    """The run link sends the picker's current value, so it follows the selection."""
    api_client.post(URL, {**PAYLOAD, "name": "ffw-fabric-5-site"}, format="json")

    content = client.get(reverse("topology-partial")).content.decode()

    assert 'hx-get="{}"'.format(reverse("new-ffw-simulation-config")) in content
    assert 'hx-include="#topology-picker"' in content
    assert 'id="topology-picker"' in content


def test_topology_page_without_a_family_shows_everything(
    api_client: APIClient, client: Client, topology_dir: Path
) -> None:
    api_client.post(URL, {**PAYLOAD, "name": "ffw-fabric-5-site"}, format="json")
    api_client.post(URL, {**PAYLOAD, "name": "ffw-8-switch"}, format="json")

    resp = client.get(reverse("topology-partial"))

    assert len(resp.context["topologies"]) == 2
    assert "Showing" not in resp.content.decode()


def test_anonymous_requests_cannot_save(api_client: APIClient, topology_dir: Path) -> None:
    """Saving writes a file into the directory CODES reads, so it needs a user."""
    api_client.force_authenticate(user=None)

    resp = api_client.post(URL, PAYLOAD, format="json")

    assert resp.status_code == 401
    assert list(topology_dir.iterdir()) == []


def test_duplicate_name_is_rejected(api_client: APIClient, topology_dir: Path) -> None:
    api_client.post(URL, PAYLOAD, format="json")
    before = (topology_dir / "two-switch.yaml").read_text()

    resp = api_client.post(URL, {**PAYLOAD, "switches": [_switch()]}, format="json")

    assert resp.status_code == 409
    assert (topology_dir / "two-switch.yaml").read_text() == before


def _switch(**overrides: Any) -> dict[str, Any]:
    """Return the payload's first switch with fields replaced."""
    return {**PAYLOAD["switches"][0], "connections": [], **overrides}


@pytest.mark.parametrize(
    ("invalid", "message"),
    [
        ({"switches": [_switch(terminal_bandwidth_gbps="100 Mbps")]}, "expected a value in Gbps"),
        ({"switches": [_switch(switch_buffer_gb="8 GB")]}, "expected a value in Gb"),
        ({"switches": [_switch(terminal_bandwidth_gbps="quick")]}, "is not a number"),
        ({"switches": [_switch(switch_buffer_gb=-1)]}, "must be zero or more"),
        (
            {"switches": [_switch(connections=[{"target": "A", "bandwidth_gbps": "10 Tbps"}])]},
            "expected a value in Gbps",
        ),
    ],
)
def test_non_gigabit_values_are_rejected(
    api_client: APIClient,
    topology_dir: Path,
    invalid: dict[str, Any],
    message: str,
) -> None:
    resp = api_client.post(URL, {**PAYLOAD, **invalid}, format="json")

    assert resp.status_code == 400
    assert message in str(resp.data[0])
    assert list(topology_dir.iterdir()) == []


@pytest.mark.parametrize(
    ("invalid", "message"),
    [
        ({"name": "../outside"}, "Name may only contain"),
        ({"switches": []}, "at least one switch"),
        ({"switches": [_switch(name="   ")]}, "Every switch needs a name"),
        ({"switches": [_switch(connections=[{"bandwidth_gbps": 10}])]}, "needs a target"),
        ({"switches": [PAYLOAD["switches"][0]]}, "undefined switches: B"),
        (
            {"switches": [PAYLOAD["switches"][0], PAYLOAD["switches"][0]]},
            "Switch names must be unique",
        ),
    ],
)
def test_invalid_topology_is_rejected(
    api_client: APIClient,
    topology_dir: Path,
    invalid: dict[str, Any],
    message: str,
) -> None:
    resp = api_client.post(URL, {**PAYLOAD, **invalid}, format="json")

    assert resp.status_code == 400
    assert message in str(resp.data[0])
    assert list(topology_dir.iterdir()) == []


SWITCH_B = PAYLOAD["switches"][1]


@pytest.mark.parametrize(
    ("invalid", "message"),
    [
        ({"switches": [_switch(terminals=1)]}, "at least two terminals"),
        ({"switches": [_switch(name="A:1")]}, "cannot contain a colon"),
        (
            {
                "switches": [
                    _switch(
                        connections=[
                            {"target": "B", "bandwidth_gbps": 1},
                            {"target": "B", "bandwidth_gbps": 2},
                        ]
                    ),
                    SWITCH_B,
                ]
            },
            "more than one connection to B",
        ),
        (
            {
                "switches": [
                    _switch(terminals=128, connections=[{"target": "B", "bandwidth_gbps": 1}]),
                    SWITCH_B,
                ]
            },
            "outgoing connections is more than 128",
        ),
        (
            {"switches": [PAYLOAD["switches"][0], {**SWITCH_B, "terminals": 128}]},
            "incoming connections is more than 128",
        ),
        (
            {"switches": [_switch(), {**SWITCH_B, "terminals": 0}]},
            "needs at least one terminal or incoming connection",
        ),
    ],
)
def test_topologies_the_model_rejects_are_not_saved(
    api_client: APIClient,
    topology_dir: Path,
    invalid: dict[str, Any],
    message: str,
) -> None:
    resp = api_client.post(URL, {**PAYLOAD, **invalid}, format="json")

    assert resp.status_code == 400
    assert message in str(resp.data[0])
    assert list(topology_dir.iterdir()) == []


@pytest.mark.parametrize(
    "tolerated",
    [
        pytest.param({"switches": [_switch()]}, id="single switch"),
        pytest.param(
            {"switches": [_switch(terminal_bandwidth_gbps=0, switch_buffer_gb=0)]},
            id="zero rates",
        ),
        pytest.param(
            {"switches": [_switch(connections=[{"target": "A", "bandwidth_gbps": 1}])]},
            id="self loop",
        ),
        pytest.param(
            {"switches": [PAYLOAD["switches"][0], {**SWITCH_B, "terminals": 0}]},
            id="transit switch fed by a connection",
        ),
    ],
)
def test_topologies_the_model_accepts_are_saved(
    api_client: APIClient, topology_dir: Path, tolerated: dict[str, Any]
) -> None:
    """Only the model's own rules are enforced; these all load and run."""
    resp = api_client.post(URL, {**PAYLOAD, **tolerated}, format="json")

    assert resp.status_code == 201
