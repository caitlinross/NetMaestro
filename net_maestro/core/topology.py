"""Access to the fluid-flow WAN topology YAML files.

Topologies are FFW topology YAML files, the same format the model reads via its
`topology_yaml_file` setting, and they live in `settings.TOPOLOGY_DIR`, by default
the repo's `data/topologies`, which holds the checked-in presets. This module
turns those files into the flat switch/link shape the topology page renders, and
writes new ones back out in that format. The model resolves that setting relative
to the traffic config naming it, so a run needs the file copied beside its config.

TODO: Remove this module once Topology/TopologyNode/TopologyLink models exist
and topologies are database-backed rather than files.
"""

from __future__ import annotations

from dataclasses import dataclass
import logging
from math import isfinite
from pathlib import Path
import re
from typing import Any

from django.conf import settings
import yaml

logger = logging.getLogger(__name__)

# Labels that should stay uppercase.
_LABELS = {"wan": "WAN", "fabric": "FABRIC"}

# A name is also the file stem and the detail URL segment, so hold it to what
# the `slug` URL converter accepts.
_NAME_RE = re.compile(r"^[-a-zA-Z0-9_]+$")

# The LP type names the model registers. A traffic config's group has to use
# these exact strings for the counts to reach the right LPs.
SWITCH_LP_NAME = "fluid-flow-wan-switch-lp"
TERMINAL_LP_NAME = "fluid-flow-wan-terminal-lp"

# The model's MAX_PORTS_PER_SWITCH and MAX_PAUSE_INGRESS_LINKS.
MAX_LINKS_PER_SWITCH = 128


class TopologyError(Exception):
    """Raised when a topology file is missing or is not a valid FFW topology."""


class DuplicateTopologyError(TopologyError):
    """Raised when saving would overwrite an existing topology file."""


class NotATopologyError(TopologyError):
    """Raised for a YAML file that is not an FFW topology document at all.

    Such files are skipped quietly. Only files that look like topologies but
    cannot be read are reported as broken.
    """


def topology_dir() -> Path:
    """Return the directory topologies are read from and written to."""
    return Path(settings.TOPOLOGY_DIR)


@dataclass(frozen=True)
class Switch:
    """One switch and its parameters, in gigabits."""

    name: str
    terminals: int
    terminal_bandwidth_gbps: float
    switch_buffer_gb: float


@dataclass(frozen=True)
class Link:
    """One directed link, in gigabits."""

    source: str
    target: str
    bandwidth_gbps: float


@dataclass(frozen=True)
class Topology:
    """A preset: its name, switches, and links."""

    name: str
    label: str
    switches: list[Switch]
    links: list[Link]

    @property
    def terminal_count(self) -> int:
        return sum(switch.terminals for switch in self.switches)

    def summary(self) -> str:
        """Return a description for the preset dropdown."""
        return (
            f"{len(self.switches)} switches, "
            f"{self.terminal_count} terminals, "
            f"{len(self.links)} links"
        )

    def simulation_inputs(self) -> dict[str, Any]:
        """Return what a traffic config has to take from this topology.

        The model instantiates one LP per switch and one per terminal, so the
        traffic config's group has to declare exactly these counts, and it
        names the topology by file. Terminals are numbered by walking the
        switches in file order, which is the numbering a traffic trace's
        `source_terminal` and `destination_terminal` columns refer to; each
        switch reports where its own run of terminal ids begins.
        """
        switches = []
        first_terminal_id = 0
        for switch in self.switches:
            switches.append(
                {
                    "name": switch.name,
                    "first_terminal_id": first_terminal_id,
                    "terminal_count": switch.terminals,
                    "terminal_bandwidth_gbps": switch.terminal_bandwidth_gbps,
                }
            )
            first_terminal_id += switch.terminals

        return {
            "name": self.name,
            "topology_yaml_file": f"{self.name}.yaml",
            "switch_count": len(self.switches),
            "terminal_count": self.terminal_count,
            "lps": {
                SWITCH_LP_NAME: len(self.switches),
                TERMINAL_LP_NAME: self.terminal_count,
            },
            "switches": switches,
        }

    def as_dict(self) -> dict[str, Any]:
        """Return the JSON that the topology canvas requires."""
        return {
            "name": self.name,
            "label": self.label,
            "summary": self.summary(),
            "switches": [
                {
                    "name": switch.name,
                    "terminals": switch.terminals,
                    "terminal_bandwidth_gbps": switch.terminal_bandwidth_gbps,
                    "switch_buffer_gb": switch.switch_buffer_gb,
                }
                for switch in self.switches
            ],
            "links": [
                {
                    "source": link.source,
                    "target": link.target,
                    "bandwidth_gbps": link.bandwidth_gbps,
                    "bandwidth_label": _short_rate(link.bandwidth_gbps),
                }
                for link in self.links
            ],
        }


def _short_rate(gbps: float) -> str:
    """Round a rate for display: `18.3324` becomes `18.3 Gbps`.

    The generator emits rates to four decimals, which is more precision than a
    canvas edge label can carry.
    """
    return f"{round(gbps, 1):g} Gbps"


def _gigabits(raw: Any, field: str, unit: str) -> float:
    """Read a gigabit value, with or without its unit: `64 Gb` or `64`.

    Only gigabits are supported for now, so any other unit is an error rather
    than a silently misread number. The match is case sensitive.
    """
    text = str(raw).strip()
    number, _, suffix = text.partition(" ")
    if suffix and suffix.strip() != unit:
        raise TopologyError(f"{field}: expected a value in {unit}, got {text}")
    try:
        value = float(number)
    except ValueError as exc:
        raise TopologyError(f"{field}: {text} is not a number") from exc
    if not isfinite(value) or value < 0:
        raise TopologyError(f"{field}: {text} must be zero or more")
    return value


def _label_from_name(name: str) -> str:
    """Turn `fluid-flow-wan-8-switch` into `Fluid Flow WAN 8 Switch`."""
    return " ".join(_LABELS.get(word, word.capitalize()) for word in name.split("-"))


def _terminal_count(raw: Any, where: str) -> int:
    try:
        terminals = int(raw)
    except (TypeError, ValueError) as exc:
        raise TopologyError(f"{where}: terminals must be a whole number") from exc
    if terminals < 0:
        raise TopologyError(f"{where}: terminals cannot be negative")
    return terminals


def _parse(topo_name: str, path: Path) -> Topology:
    """Parse one topology YAML file into a Topology."""
    try:
        document = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise TopologyError(f"Could not read topology file {path.name}: {exc}") from exc

    if not isinstance(document, dict):
        raise NotATopologyError(f"{path.name} is not a YAML mapping")
    switch_entries = (document.get("topology") or {}).get("switches")
    if not isinstance(switch_entries, dict):
        raise NotATopologyError(f"{path.name} has no topology.switches mapping")

    switches: list[Switch] = []
    links: list[Link] = []
    for name, entry in switch_entries.items():
        if not isinstance(entry, dict):
            raise TopologyError(f"{path.name}: switch {name} is not a mapping")
        switches.append(
            Switch(
                name=str(name),
                terminals=_terminal_count(entry.get("terminals", 0), f"{path.name}: {name}"),
                terminal_bandwidth_gbps=_gigabits(
                    entry.get("terminal_bandwidth", 0),
                    f"{path.name}: {name} terminal_bandwidth",
                    "Gbps",
                ),
                switch_buffer_gb=_gigabits(
                    entry.get("switch_buffer", 0), f"{path.name}: {name} switch_buffer", "Gb"
                ),
            )
        )
        # "connections" is directed: these are this switch's outbound links only.
        for target, bandwidth in (entry.get("connections") or {}).items():
            links.append(
                Link(
                    source=str(name),
                    target=str(target),
                    bandwidth_gbps=_gigabits(bandwidth, f"{path.name}: {name} -> {target}", "Gbps"),
                )
            )

    known = {switch.name for switch in switches}
    unknown = sorted({link.target for link in links} - known)
    if unknown:
        raise TopologyError(f"{path.name}: links point at undefined switches: {', '.join(unknown)}")

    return Topology(
        name=topo_name, label=_label_from_name(topo_name), switches=switches, links=links
    )


def family_label(family: str) -> str:
    """Return a family word the way a topology label would spell it."""
    return _LABELS.get(family, family.capitalize())


def list_topologies(family: str | None = None) -> tuple[Topology, ...]:
    """Return every available topology, ordered by switch count then name.

    `family` narrows the result to the topologies carrying that word in their
    name, the way `fluid-flow-wan-fabric-5-site` carries `fabric`. The match is
    against whole dash-separated words, so `fabric` does not also pull in a
    name like `fabricated`. Matching on the name is what there is to go on
    until topologies are database-backed and can hold a field of their own.

    Reads the directory every time rather than caching: other processes (the
    ingest command, other containers) add files without this one knowing.

    YAML files that are not topologies are passed over quietly. Files that are
    topologies but cannot be read are logged and skipped.
    """
    wanted = family.strip().lower() if family else None
    topologies = []
    for path in sorted(topology_dir().glob("*.yaml")):
        if wanted is not None and wanted not in path.stem.lower().split("-"):
            continue
        try:
            topologies.append(_parse(path.stem, path))
        except NotATopologyError as exc:
            logger.debug("Not a topology file: %s", exc)
        except TopologyError:
            logger.exception("Skipping unreadable topology file %s", path.name)
    return tuple(sorted(topologies, key=lambda t: (len(t.switches), t.name)))


def _switch_from_payload(entry: Any) -> tuple[Switch, list[Link]]:
    """Build one switch and its outbound links from a posted switch entry."""
    if not isinstance(entry, dict):
        raise TopologyError("Each switch must be an object")
    name = str(entry.get("name", "")).strip()
    if not name:
        raise TopologyError("Every switch needs a name")

    terminals = _terminal_count(entry.get("terminals", 0), f"Switch {name}")

    links: list[Link] = []
    for connection in entry.get("connections") or []:
        if not isinstance(connection, dict):
            raise TopologyError(f"Switch {name}: each connection must be an object")
        target = str(connection.get("target", "")).strip()
        if not target:
            raise TopologyError(f"Switch {name}: every connection needs a target")
        # The YAML keys connections by target, so a second one would silently replace the first.
        if any(link.target == target for link in links):
            raise TopologyError(f"Switch {name}: more than one connection to {target}")
        links.append(
            Link(
                source=name,
                target=target,
                bandwidth_gbps=_gigabits(
                    connection.get("bandwidth_gbps", 0), f"{name} -> {target} bandwidth", "Gbps"
                ),
            )
        )

    switch = Switch(
        name=name,
        terminals=terminals,
        terminal_bandwidth_gbps=_gigabits(
            entry.get("terminal_bandwidth_gbps", 0), f"Switch {name}: terminal bandwidth", "Gbps"
        ),
        switch_buffer_gb=_gigabits(
            entry.get("switch_buffer_gb", 0), f"Switch {name}: switch buffer", "Gb"
        ),
    )
    return switch, links


def from_payload(payload: Any) -> Topology:
    """Build a Topology from a posted payload, the inverse of `as_dict`.

    Only checks what the YAML file needs to be written at all: a usable name,
    unique switch names, one connection per target, and links that land on a
    known switch. `save_topology` then applies the model's own rules.
    """
    if not isinstance(payload, dict):
        raise TopologyError("Expected a topology object")
    name = str(payload.get("name", "")).strip()
    if not _NAME_RE.match(name):
        raise TopologyError("Name may only contain letters, numbers, dashes, and underscores")

    entries = payload.get("switches")
    if not isinstance(entries, list) or not entries:
        raise TopologyError("A topology needs at least one switch")

    switches: list[Switch] = []
    links: list[Link] = []
    for entry in entries:
        switch, outbound = _switch_from_payload(entry)
        switches.append(switch)
        links.extend(outbound)

    known = {switch.name for switch in switches}
    if len(known) != len(switches):
        raise TopologyError("Switch names must be unique")
    unknown = sorted({link.target for link in links} - known)
    if unknown:
        raise TopologyError(f"Connections point at undefined switches: {', '.join(unknown)}")

    return Topology(name=name, label=_label_from_name(name), switches=switches, links=links)


def _with_unit(value: float, unit: str) -> str:
    """Write a gigabit value the way the FFW YAML wants it: `18.3324 Gbps`.

    Four decimals is what the CODES topology generator emits, so values read
    from a generated preset survive a round trip.
    """
    return f"{f'{value:.4f}'.rstrip('0').rstrip('.') or '0'} {unit}"


def _to_document(topology: Topology) -> dict[str, Any]:
    """Render a Topology back into the FFW topology YAML structure."""
    outbound: dict[str, dict[str, str]] = {switch.name: {} for switch in topology.switches}
    for link in topology.links:
        outbound[link.source][link.target] = _with_unit(link.bandwidth_gbps, "Gbps")
    return {
        "topology": {
            "switches": {
                switch.name: {
                    "terminals": switch.terminals,
                    "terminal_bandwidth": _with_unit(switch.terminal_bandwidth_gbps, "Gbps"),
                    "switch_buffer": _with_unit(switch.switch_buffer_gb, "Gb"),
                    **({"connections": outbound[switch.name]} if outbound[switch.name] else {}),
                }
                for switch in topology.switches
            }
        }
    }


def check_model_rules(topology: Topology) -> None:
    """Raise TopologyError for a topology the FFW model refuses to load.

    Mirrors the model's own load-time errors and nothing stricter, so anything
    the model would run can be saved.
    """
    if topology.terminal_count < 2:
        raise TopologyError("A topology needs at least two terminals in total")
    pairs = {(link.source, link.target) for link in topology.links}
    for switch in topology.switches:
        # The model reads each YAML line as `key: value`, splitting at the first colon.
        if ":" in switch.name:
            raise TopologyError(f"Switch {switch.name}: names cannot contain a colon")
        outgoing = sum(1 for source, _ in pairs if source == switch.name)
        incoming = sum(
            1 for source, target in pairs if target == switch.name and source != switch.name
        )
        if switch.terminals + outgoing > MAX_LINKS_PER_SWITCH:
            raise TopologyError(
                f"Switch {switch.name}: terminals plus outgoing connections is more than "
                f"{MAX_LINKS_PER_SWITCH}"
            )
        if switch.terminals + incoming > MAX_LINKS_PER_SWITCH:
            raise TopologyError(
                f"Switch {switch.name}: terminals plus incoming connections is more than "
                f"{MAX_LINKS_PER_SWITCH}"
            )
        if switch.terminals + incoming == 0:
            raise TopologyError(
                f"Switch {switch.name} needs at least one terminal or incoming connection"
            )


def save_topology(topology: Topology) -> Topology:
    """Write a new topology file and return it as reparsed from disk.

    The file lands in the topology directory under `<name>.yaml`, which is the
    name a traffic config's `topology_yaml_file` refers to.

    Never overwrites: an existing file with the same name is a
    DuplicateTopologyError. Reparsing keeps the caller's copy identical to what
    every later read will see.

    That rule holds more than it looks like it does. A traffic trace addresses
    terminals by number, and the model numbers them by walking the switches in
    file order, so inserting or reordering a switch renumbers every terminal
    after it. Traces stay honest today only because an edit is a new file under
    a new name, leaving the file a trace was generated against untouched. An
    update-in-place path would break that quietly: the shifted ids stay inside
    the valid range, so the model runs the trace against the wrong terminals
    without complaint. Whoever adds one has to regenerate or invalidate the
    traces bound to that topology as part of the save.
    """
    check_model_rules(topology)
    path = topology_dir() / f"{topology.name}.yaml"
    body = yaml.safe_dump(_to_document(topology), sort_keys=False, default_flow_style=False)
    try:
        with path.open("x", encoding="utf-8") as stream:
            stream.write(body)
    except FileExistsError as exc:
        raise DuplicateTopologyError(f"A topology named {topology.name} already exists") from exc
    except OSError as exc:
        raise TopologyError(f"Could not write topology {topology.name}: {exc}") from exc

    return get_topology(topology.name)


def get_topology(name: str) -> Topology:
    """Return one topology by name.

    Looks the name up among the known topologies rather than building a path
    from it, so a caller cannot reach files outside the topology directory.
    """
    for topology in list_topologies():
        if topology.name == name:
            return topology
    raise TopologyError(f"Unknown topology: {name}")
