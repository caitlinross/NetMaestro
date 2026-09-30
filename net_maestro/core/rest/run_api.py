"""REST API endpoints for serving parsed data by Run ID.

Queries database records (EventRecord, ModelRecord, SimulationPeRecord, FFWRecords)
that were ingested via the data_ingest management command.
"""

from __future__ import annotations

import logging
from math import isfinite
from typing import TYPE_CHECKING, Any

from django.db.models import F
from django.shortcuts import get_object_or_404
from rest_framework.response import Response
from rest_framework.views import APIView

if TYPE_CHECKING:
    from django.db.models import Model
    from rest_framework.request import Request

from net_maestro.core.models import (
    EventRecord,
    FFWPortRecord,
    FFWSwitchRecord,
    FFWTerminalRecord,
    ModelRecord,
    Run,
    SimulationPeRecord,
)
from net_maestro.core.topology import TopologyError, get_topology

logger = logging.getLogger(__name__)


def _fields_for_model(
    model: type[Model],
    *,
    exclude: tuple[str, ...] = ("id",),
) -> list[str]:
    """Return field names for a model, excluding specified fields and FKs."""
    return [
        f.name
        for f in model._meta.get_fields()
        if hasattr(f, "column")
        and f.name not in exclude
        and not f.many_to_many
        and not f.related_model
    ]


def _queryset_to_response(
    queryset: Any,
    columns: list[str],
) -> dict[str, Any]:
    """Convert a queryset to the standard {columns, data} response format.

    JSON has no infinity or NaN, so those become null. ROSS reports GVT as infinity once
    a simulation has finished, so the last GVT sample of every FFW run has one.
    """
    records = [
        {
            key: None if isinstance(value, float) and not isfinite(value) else value
            for key, value in record.items()
        }
        for record in queryset.values(*columns)
    ]
    return {
        "columns": columns,
        "data": records,
    }


class RunRossDataView(APIView):
    """Return simulation PE records for a given run."""

    def get(self, _request: Request, run_id: int) -> Response:
        run = get_object_or_404(Run, pk=run_id)
        columns = _fields_for_model(
            SimulationPeRecord,
            exclude=("id", "simulation_file"),
        )
        queryset = SimulationPeRecord.objects.filter(
            simulation_file__run=run,
        ).order_by("virtual_time")
        return Response(_queryset_to_response(queryset, columns))


class RunEventDataView(APIView):
    """Return event records for a given run."""

    def get(self, _request: Request, run_id: int) -> Response:
        run = get_object_or_404(Run, pk=run_id)
        columns = _fields_for_model(
            EventRecord,
            exclude=("id", "event_file"),
        )
        queryset = EventRecord.objects.filter(
            event_file__run=run,
        )
        return Response(_queryset_to_response(queryset, columns))


class RunModelDataView(APIView):
    """Return model records for a given run."""

    def get(self, _request: Request, run_id: int) -> Response:
        run = get_object_or_404(Run, pk=run_id)
        columns = _fields_for_model(
            ModelRecord,
            exclude=("id", "model_file"),
        )
        queryset = ModelRecord.objects.filter(
            model_file__run=run,
        ).order_by("virtual_time")
        return Response(_queryset_to_response(queryset, columns))


def _filter_stats_type(queryset: Any, request: Request, prefix: str = "") -> Any:
    """Restrict FFW rows to the sampling modes in ?stats_type= (comma-separated gvt, rt, vt)."""
    stats_types = [s for s in request.query_params.get("stats_type", "").split(",") if s]
    if stats_types:
        queryset = queryset.filter(**{f"{prefix}stats_type__in": stats_types})
    return queryset


class RunFFWSwitchDataView(APIView):
    """Return FFW switch records for a given run."""

    def get(self, request: Request, run_id: int) -> Response:
        run = get_object_or_404(Run, pk=run_id)
        columns = _fields_for_model(FFWSwitchRecord, exclude=("id", "result_file"))
        queryset = _filter_stats_type(
            FFWSwitchRecord.objects.filter(result_file__run=run), request
        ).order_by("ts", "switch_id")
        return Response(_queryset_to_response(queryset, columns))


class RunFFWTerminalDataView(APIView):
    """Return FFW terminal records for a given run."""

    def get(self, request: Request, run_id: int) -> Response:
        run = get_object_or_404(Run, pk=run_id)
        columns = _fields_for_model(FFWTerminalRecord, exclude=("id", "result_file"))
        queryset = _filter_stats_type(
            FFWTerminalRecord.objects.filter(result_file__run=run), request
        ).order_by("ts", "terminal_id")
        return Response(_queryset_to_response(queryset, columns))


class RunFFWPortDataView(APIView):
    """Return FFW port records for a given run, flattened with their switch sample's fields."""

    def get(self, request: Request, run_id: int) -> Response:
        run = get_object_or_404(Run, pk=run_id)
        sample_fields = ["switch_id", "stats_type", "ts", "real_time"]
        columns = sample_fields + _fields_for_model(FFWPortRecord, exclude=("id", "switch_record"))
        queryset = (
            _filter_stats_type(
                FFWPortRecord.objects.filter(switch_record__result_file__run=run),
                request,
                prefix="switch_record__",
            )
            .annotate(**{f: F(f"switch_record__{f}") for f in sample_fields})
            .order_by("ts", "switch_id", "port_index")
        )
        return Response(_queryset_to_response(queryset, columns))


class RunDatasetsView(APIView):
    """Report which datasets hold rows for a run, so the UI can pick a source per plot.

    A single run can carry both FFW model stats and ROSS engine stats, so the
    analysis page resolves each plot's dataset from this rather than from
    Run.simulation_type.
    """

    def get(self, _request: Request, run_id: int) -> Response:
        run = get_object_or_404(Run, pk=run_id)
        counts = {
            "event": EventRecord.objects.filter(event_file__run=run).count(),
            "model": ModelRecord.objects.filter(model_file__run=run).count(),
            "ross": SimulationPeRecord.objects.filter(simulation_file__run=run).count(),
            "ffw-switches": FFWSwitchRecord.objects.filter(result_file__run=run).count(),
            "ffw-terminals": FFWTerminalRecord.objects.filter(result_file__run=run).count(),
            "ffw-ports": FFWPortRecord.objects.filter(switch_record__result_file__run=run).count(),
        }
        return Response(
            {
                "simulation_type": run.simulation_type,
                "datasets": counts,
                "available": sorted(name for name, count in counts.items() if count),
                "switch_names": _switch_names(run),
            }
        )


def _switch_names(run: Run) -> list[str]:
    """Return the run's switch names, indexed by the switch id the model reports.

    The model numbers switch LPs by walking the topology file in order, so a
    switch's position in this list is its `switch_id`. Empty when the run has no
    FFW config or its topology file is gone, in which case plots keep using the
    numeric ids.

    TODO: Read this from the run's own copy of the topology once runs keep one;
    today's lookup is by name, so editing a preset renames a past run's switches.
    """
    config = run.ffw_configs.order_by("-id").first()
    if config is None:
        return []
    try:
        topology = get_topology(config.topology_name)
    except TopologyError:
        logger.warning(
            "Run %s names topology %r, which is no longer readable; "
            "the heatmap will fall back to switch ids.",
            run.pk,
            config.topology_name,
        )
        return []
    return [switch.name for switch in topology.switches]
