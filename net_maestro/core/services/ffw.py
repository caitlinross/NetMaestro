from __future__ import annotations

import csv
import logging
import subprocess
from typing import TYPE_CHECKING, Any

import yaml

from net_maestro.core.constants import FFWTrafficMode
from net_maestro.core.topology import SWITCH_LP_NAME

if TYPE_CHECKING:
    from pathlib import Path

    from net_maestro.core.topology import Topology

logger = logging.getLogger(__name__)


FFW_STATS_FILES = ("ross-stats-model.bin", "ross-stats-analysis-lps.bin")

# GVT-sampled simulation engine stats (PE/KP/LP), written when --engine-stats is on.
FFW_ENGINE_STATS_FILE = "ross-stats-gvt.bin"


# The settings naming the stock binary and template traffic config for each traffic mode.
FFW_TRAFFIC_DEFAULTS: dict[str, dict[str, str]] = {
    FFWTrafficMode.RANDOM: {"binary": "FFW_BINARY_PATH", "config": "FFW_CONFIG_PATH"},
    FFWTrafficMode.TRACE: {"binary": "FFW_TRACE_BINARY_PATH", "config": "FFW_TRACE_CONFIG_PATH"},
}


class FFWInputError(Exception):
    """Raised when the traffic config or trace cannot be used with the topology."""


def _with_unit(value: float, unit: str) -> str:
    """Write a gigabit value the way the FFW YAML wants it: `18.3324 Gbps`."""
    return f"{f'{value:.4f}'.rstrip('0').rstrip('.') or '0'} {unit}"


def _topology_document(topology: Topology) -> dict[str, Any]:
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


def _ffw_group(config: dict[str, Any]) -> dict[str, Any]:
    """Return the LP group that holds the FFW switch and terminal LPs."""
    groups = (config.get("topology") or {}).get("groups") or {}
    for group in groups.values():
        if SWITCH_LP_NAME in (group.get("lps") or {}):
            if group.get("repetitions", 1) != 1:
                raise FFWInputError("The FFW LP group must have repetitions: 1")
            return group
    raise FFWInputError(f"No LP group in the traffic config lists {SWITCH_LP_NAME}")


def _check_trace(path: Path, terminal_count: int) -> None:
    """Refuse a trace CSV that names terminals the topology does not have."""
    with path.open(newline="", encoding="utf-8") as stream:
        for line, row in enumerate(csv.DictReader(stream), start=2):
            for column in ("source_terminal", "destination_terminal"):
                terminal = int(row[column])
                if not 0 <= terminal < terminal_count:
                    raise FFWInputError(
                        f"{path.name} line {line}: {column} {terminal} is outside this "
                        f"topology's terminals 0-{terminal_count - 1}"
                    )


def point_traffic_config_at_topology(*, topology: Topology, config_path: Path) -> None:
    """Rewrite a traffic config in place to run on `topology`.

    Replaces the config's LP counts and `topology_yaml_file`, and writes the
    topology YAML beside it, since the model resolves that file, the trace, and
    the log paths relative to the traffic config.
    """
    inputs = topology.simulation_inputs()
    config = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    section = config["sections"]["fluid_flow_wan"]
    config_dir = config_path.parent

    if trace := section.get("traffic_trace_file"):
        _check_trace(config_dir / trace, inputs["terminal_count"])
    _ffw_group(config)["lps"].update(inputs["lps"])
    section["topology_yaml_file"] = inputs["topology_yaml_file"]

    for key, value in section.items():
        if key.endswith("_log_path"):
            (config_dir / value).parent.mkdir(parents=True, exist_ok=True)

    (config_dir / inputs["topology_yaml_file"]).write_text(
        yaml.safe_dump(_topology_document(topology), sort_keys=False), encoding="utf-8"
    )
    config_path.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")


def execute_ffw_model(  # noqa: PLR0913
    *,
    np: int,
    sync: int,
    model_stats: int,
    num_gvt: int,
    rt_interval: int,
    vt_interval: int,
    vt_samp_end: int,
    engine_stats: int,
    pe_data: int,
    kp_data: int,
    lp_data: int,
    config_path: str,
    working_dir: str,
    binary_path: str,
    stats_dir: Path,
) -> Path:
    """Run the model, writing its ROSS stats into `stats_dir`, and return that directory.

    `stats_dir` must not exist yet: ROSS creates it, but if it already exists ROSS
    quietly writes to `<stats_dir>-<pid>-<time>` instead, and the results would be
    read from the wrong place.
    """
    if stats_dir.exists():
        raise FileExistsError(f"FFW stats directory {stats_dir} already exists")
    stats_dir.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "mpirun",
        "-np",
        str(np),
        binary_path,
        f"--sync={sync}",
        f"--model-stats={model_stats}",
        f"--num-gvt={num_gvt}",
        f"--rt-interval={rt_interval}",
        f"--vt-interval={vt_interval}",
        f"--vt-samp-end={vt_samp_end}",
        f"--engine-stats={engine_stats}",
        f"--pe-data={pe_data}",
        f"--kp-data={kp_data}",
        f"--lp-data={lp_data}",
        f"--stats-path={stats_dir}",
        "--",
        config_path,
    ]
    try:
        result = subprocess.run(cmd, cwd=working_dir, check=True, capture_output=True, text=True)  # noqa: S603
    except subprocess.CalledProcessError as e:
        # The model's own error message is at the end of its output. No traceback here:
        # run_ffw_simulation logs it once.
        logger.error(  # noqa: TRY400
            "FFW simulation exited with code %s.\n--- last lines of stdout ---\n%s\n"
            "--- last lines of stderr ---\n%s",
            e.returncode,
            _tail(e.stdout),
            _tail(e.stderr),
        )
        raise
    logger.info("FFW simulation finished; full output is logged at DEBUG level")
    logger.debug("FFW simulation output:\n%s", result.stdout)
    missing = [name for name in FFW_STATS_FILES if not (stats_dir / name).is_file()]
    if missing:
        raise FileNotFoundError(f"FFW finished but wrote no {', '.join(missing)} in {stats_dir}")
    return stats_dir


def _tail(text: str | None, lines: int = 20) -> str:
    return "\n".join((text or "").splitlines()[-lines:])
