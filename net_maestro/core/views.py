"""Django views for the NetMaestro core application.

Provides page views for configuration and analysis.
"""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING

from django.contrib import messages
from django.core.exceptions import ValidationError
from django.db import transaction
from django.http import Http404, HttpResponse
from django.shortcuts import redirect, render
from django.views.decorators.http import require_POST

if TYPE_CHECKING:
    from django import forms
    from django.http import HttpRequest

from .base_models import BASE_MODEL_BY_NAME, BASE_MODEL_REGISTRY
from .constants import RunStatus, SimulationType
from .forms import ComponentModelForm, FFWSimulationForm, PHOLDSimulationForm
from .models import ComponentModel, FFWSimulationConfig, PHOLDSimulationConfig, Run
from .simulation_models import SIMULATION_MODELS
from .tasks import run_ffw_simulation, run_phold_simulation
from .topology import family_label, list_topologies

logger = logging.getLogger(__name__)


def _avail_component_models_context() -> dict[str, object]:
    """Return available models context for the models list page."""
    return {
        "simulation_models": SIMULATION_MODELS,
    }


def _base_models_sidebar_context() -> list[dict[str, object]]:
    """Return base models for the sidebar, derived from the registry."""
    models = [
        {
            "name": m["name"],
            "type": m["component_type"],
            "engine": m["engine"],
            "icon_class": m["icon_class"],
            "disabled": m.get("disabled", False),
        }
        for m in BASE_MODEL_REGISTRY
    ]
    models.sort(key=lambda m: bool(m["disabled"]))
    return models


def _filtered_runs(request: HttpRequest) -> dict[str, object]:
    """Return runs queryset filtered by ?status= and ?q= params."""
    statuses = request.GET.getlist("status")
    search_query = request.GET.get("q", "").strip()
    runs = (
        Run.objects.filter(status__in=statuses)
        if statuses
        else Run.objects.exclude(status=RunStatus.SAVED)
    )
    if search_query:
        runs = runs.filter(name__icontains=search_query)
    return {
        "runs": runs,
        # SAVED runs have no simulation data to analyze; exclude them from filter options.
        "status_choices": [
            (value, label) for value, label in RunStatus.choices if value != RunStatus.SAVED
        ],
        "selected_statuses": statuses,
        "search_query": search_query,
    }


def run_list(request: HttpRequest) -> HttpResponse:
    """Return just the runs list partial (used by HTMX filter)."""
    context = _filtered_runs(request)
    return render(request, "net_maestro/partials/run_list.html", context)


def _custom_component_not_implemented(action: str) -> HttpResponse:
    """Return a temporary 501 response for planned custom component views."""
    return HttpResponse(f"TODO: Implement custom component {action}.", status=501)


_COMPONENT_TYPE_STYLE: dict[str, dict[str, str]] = {
    "host": {
        "icon_class": "ri-server-line",
        "color_class": "text-primary",
        "badge_class": "badge-primary",
    },
    "router": {
        "icon_class": "ri-router-fill",
        "color_class": "text-secondary",
        "badge_class": "badge-secondary",
    },
    "switch": {
        "icon_class": "ri-organization-chart",
        "color_class": "text-accent",
        "badge_class": "badge-accent",
    },
}


def _component_to_card(component: ComponentModel) -> dict[str, object]:
    """Convert a ComponentModel instance to the dict shape expected by the template."""
    style = _COMPONENT_TYPE_STYLE.get(component.component_type, {})
    params = component.parameters or {}
    detail_fields = [{"label": k, "value": v} for k, v in params.items()]
    detail_fields.append({"label": "Engine", "value": component.engine})
    return {
        "id": component.pk,
        "name": component.name,
        "type": component.get_component_type_display(),
        "base_model": component.base_model,
        "icon_class": style.get("icon_class", "ri-question-line"),
        "color_class": style.get("color_class", ""),
        "badge_class": style.get("badge_class", "badge-outline"),
        "detail_fields": detail_fields,
    }


def custom_component_list(request: HttpRequest) -> HttpResponse:
    """Render the custom component list from the database."""
    db_components = [_component_to_card(c) for c in ComponentModel.objects.order_by("-created_at")]
    context: dict[str, object] = {
        "base_models": _base_models_sidebar_context(),
        "custom_components": db_components,
    }
    partial_template = "net_maestro/partials/configuration.html"
    if request.headers.get("HX-Request"):
        return render(request, partial_template, context)
    context.update({"active_page": "customComponents", "partial_template": partial_template})
    return render(request, "net_maestro/index.html", context)


def _component_form_context(form: ComponentModelForm) -> dict[str, object]:
    """Build the template context shared by create and edit views."""
    params = form.initial.get("parameters") or form.instance.parameters or {}
    if isinstance(params, str):
        try:
            params = json.loads(params)
        except (json.JSONDecodeError, TypeError):
            params = {}
    return {
        "form": form,
        "base_model_registry": BASE_MODEL_REGISTRY,
        "base_model_registry_by_name": BASE_MODEL_BY_NAME,
        "initial_params": params,
    }


def custom_component_create(request: HttpRequest) -> HttpResponse:
    """Create a new custom component backed by ComponentModel."""
    if request.method == "POST":
        form = ComponentModelForm(request.POST)
        if form.is_valid():
            form.save()
            return redirect("configuration-partial")
    else:
        initial: dict[str, object] = {}
        base = request.GET.get("base_model", "")
        if base in BASE_MODEL_BY_NAME and not BASE_MODEL_BY_NAME[base].get("disabled"):
            initial["base_model"] = base
        form = ComponentModelForm(initial=initial)

    context = _component_form_context(form)
    partial_template = "net_maestro/partials/custom_component_form.html"
    if request.headers.get("HX-Request"):
        return render(request, partial_template, context)
    context.update({"active_page": "customComponents", "partial_template": partial_template})
    return render(request, "net_maestro/index.html", context)


def custom_component_detail(_request: HttpRequest, component_id: int) -> HttpResponse:
    """Show one custom component.

    TODO: Fetch the custom component by ID, scoped to the current user/project.
    TODO: Reuse the same context shape as the list view for detail/card partial rendering.
    TODO: Include related base model metadata and formatted default values.
    """
    return _custom_component_not_implemented(f"detail for component {component_id}")


def custom_component_edit(request: HttpRequest, component_id: int) -> HttpResponse:
    """Edit an existing custom component."""
    try:
        component = ComponentModel.objects.get(pk=component_id)
    except ComponentModel.DoesNotExist as err:
        raise Http404 from err

    if request.method == "POST":
        form = ComponentModelForm(request.POST, instance=component)
        if form.is_valid():
            form.save()
            return redirect("configuration-partial")
    else:
        form = ComponentModelForm(instance=component)

    context = _component_form_context(form)
    context["is_edit"] = True
    partial_template = "net_maestro/partials/custom_component_form.html"
    if request.headers.get("HX-Request"):
        return render(request, partial_template, context)
    context.update({"active_page": "customComponents", "partial_template": partial_template})
    return render(request, "net_maestro/index.html", context)


def custom_component_duplicate(_request: HttpRequest, component_id: int) -> HttpResponse:
    """Duplicate an existing custom component.

    TODO: Fetch the source component by ID, scoped to the current user/project.
    TODO: Clone editable fields while assigning a distinct user-facing name.
    TODO: Decide whether duplicate opens the edit form immediately or creates a copy directly.
    TODO: Refresh the custom component list after duplication.
    """
    return _custom_component_not_implemented(f"duplicate for component {component_id}")


def custom_component_delete(_request: HttpRequest, component_id: int) -> HttpResponse:
    """Delete an existing custom component.

    TODO: Fetch the custom component by ID, scoped to the current user/project.
    TODO: Confirm whether the component is used by any topology before deleting.
    TODO: Require confirmation and use POST/DELETE semantics rather than deleting from GET.
    TODO: Refresh the custom component list or return an empty-state partial after deletion.
    """
    return _custom_component_not_implemented(f"delete for component {component_id}")


def _phold_form_initial_from_config(config: PHOLDSimulationConfig) -> dict[str, object]:
    return {"run_identifier": config.run.name}


def _get_latest_phold_config_or_404(run_id: int) -> PHOLDSimulationConfig:
    """Return the most recently created PHOLDSimulationConfig for a Run.

    TODO: Revisit this "most recent wins" choice once ensembles need to disambiguate
    between multiple configs.
    """
    config = (
        PHOLDSimulationConfig.objects.select_related("run")
        .filter(run_id=run_id)
        .order_by("-id")
        .first()
    )
    if config is None:
        raise Http404(f"No PHOLDSimulationConfig found for run {run_id}")
    return config


def _run_phold(run: Run, config: PHOLDSimulationConfig) -> None:
    run_phold_simulation.delay(
        run_id=run.id,
        synch=config.synch,
        avl_size=config.avl_size,
        nlp=config.nlp,
        remote=config.remote,
        mean=config.mean,
        mult=config.mult,
        lookahead=config.lookahead,
        start_events=config.start_events,
        memory=config.memory,
        stagger=config.stagger,
    )


def _create_run_and_config[Config: PHOLDSimulationConfig | FFWSimulationConfig](
    form: forms.ModelForm[Config], run_status: RunStatus
) -> tuple[Run, Config]:
    """Create a Run and its simulation config atomically from validated form data."""
    with transaction.atomic():
        run = Run.objects.create(
            name=form.cleaned_data["run_identifier"],
            description=form.cleaned_data.get("description", ""),
            status=run_status,
            simulation_type=(
                SimulationType.FFW
                if isinstance(form.instance, FFWSimulationConfig)
                else SimulationType.PHOLD
            ),
        )
        config = form.save(commit=False)
        config.run = run
        config.save()
    return run, config


def simulation_config(request: HttpRequest) -> HttpResponse:
    """Render the simulation configuration form and handle submission.

    GET: Display the form with PHOLD parameters.
    POST: Create a Run and its configuration. Only triggers a task when "Save and Run"
        was used; "Save" persists the configuration without running it.
    """
    if request.method == "POST":
        form = PHOLDSimulationForm(request.POST)
        if form.is_valid():
            should_run = request.POST.get("action") == "save_and_run"

            run_status = RunStatus.PENDING if should_run else RunStatus.SAVED
            run, config = _create_run_and_config(form, run_status)

            if should_run:
                _run_phold(run, config)
                # Redirect to the analysis page so the user can watch the run
                return redirect("analysis-partial")

            # Redirect to the saved simulations list
            return redirect("simulation-config")
    else:
        form = PHOLDSimulationForm()

    context: dict[str, object] = {
        "form": form,
        "form_action": request.path,
        "page_heading": "New Simulation",
        "breadcrumb_label": "New Simulation",
    }
    partial_template = "net_maestro/partials/new_simulation.html"
    if request.headers.get("HX-Request"):
        return render(request, partial_template, context)
    context.update({"active_page": "simulation", "partial_template": partial_template})
    return render(request, "net_maestro/index.html", context)


def edit_simulation_config(request: HttpRequest, run_id: int) -> HttpResponse:
    config = _get_latest_phold_config_or_404(run_id)

    if request.method == "POST":
        form = PHOLDSimulationForm(request.POST)
        if form.is_valid():
            should_run = request.POST.get("action") == "save_and_run"
            run_status = RunStatus.PENDING if should_run else RunStatus.SAVED
            # TODO: "Editing" a saved config intentionally clones it into a new Run/config
            # rather than mutating the original. This is a deliberate safeguard against one
            # person's edits overwriting another person's saved work.
            # Revisit once per-user ownership exists and in-place edits are safe to allow.
            #
            # TODO: The cloned run/config currently has no explicit linkage to the source run.
            # Consider associating them so users can trace edit history or re-clone without
            # guesswork.
            run, new_config = _create_run_and_config(form, run_status)

            if should_run:
                _run_phold(run, new_config)
                return redirect("analysis-partial")

            return redirect("simulation-config")
    else:
        form = PHOLDSimulationForm(instance=config, initial=_phold_form_initial_from_config(config))

    context: dict[str, object] = {
        "form": form,
        "form_action": request.path,
        "page_heading": "Clone Simulation",
        "breadcrumb_label": "Clone Simulation",
    }
    partial_template = "net_maestro/partials/new_simulation.html"
    if request.headers.get("HX-Request"):
        return render(request, partial_template, context)
    context.update({"active_page": "simulation", "partial_template": partial_template})
    return render(request, "net_maestro/index.html", context)


@require_POST
def run_saved_simulation(request: HttpRequest, run_id: int) -> HttpResponse:
    config = _get_latest_phold_config_or_404(run_id)
    run = config.run

    try:
        config.full_clean()
    except ValidationError as exc:
        logger.warning(
            "Saved config for run %s failed re-validation and could not be run: %s",
            run_id,
            exc.message_dict,
        )
        # TODO: Consider surfacing errors via a toast notification or an HTMX response instead of
        # a redirect so it's clear to the user what happened and why.
        messages.error(request, f'Unable to run "{run.name}": saved configuration is invalid.')
        return redirect("simulation-config")
    run.status = RunStatus.PENDING
    run.save(update_fields=["status"])
    _run_phold(run, config)
    return redirect("analysis-partial")


def _get_latest_ffw_config_or_404(run_id: int) -> FFWSimulationConfig:
    config = (
        FFWSimulationConfig.objects.select_related("run")
        .filter(run_id=run_id)
        .order_by("-id")
        .first()
    )
    if config is None:
        raise Http404(f"No FFWSimulationConfig found for run {run_id}")
    return config


def _run_ffw(run: Run, config: FFWSimulationConfig) -> None:
    run_ffw_simulation.delay(
        run_id=run.id,
        topology_name=config.topology_name,
        traffic=config.traffic,
        np=config.np,
        sync=config.sync,
    )


def _ffw_simulation_form_page(
    request: HttpRequest, *, source: FFWSimulationConfig | None, page_heading: str
) -> HttpResponse:
    """Handle the FFW form for both new and cloned configs.

    A clone is saved as a new Run and config, as PHOLD's edit does.
    """
    if request.method == "POST":
        form = FFWSimulationForm(request.POST)
        if form.is_valid():
            should_run = request.POST.get("action") == "save_and_run"
            run_status = RunStatus.PENDING if should_run else RunStatus.SAVED
            run, config = _create_run_and_config(form, run_status)
            if should_run:
                _run_ffw(run, config)
                return redirect("analysis-partial")
            return redirect("simulation-config")
    elif source is not None:
        form = FFWSimulationForm(
            instance=source,
            initial={"run_identifier": source.run.name, "description": source.run.description},
        )
    else:
        form = FFWSimulationForm()

    context: dict[str, object] = {
        "form": form,
        "form_action": request.path,
        "page_heading": page_heading,
    }
    partial_template = "net_maestro/partials/new_ffw_simulation.html"
    if request.headers.get("HX-Request"):
        return render(request, partial_template, context)
    context.update({"active_page": "simulation", "partial_template": partial_template})
    return render(request, "net_maestro/index.html", context)


def ffw_simulation_config(request: HttpRequest) -> HttpResponse:
    return _ffw_simulation_form_page(request, source=None, page_heading="New FFW Simulation")


def edit_ffw_simulation_config(request: HttpRequest, run_id: int) -> HttpResponse:
    source = _get_latest_ffw_config_or_404(run_id)
    return _ffw_simulation_form_page(request, source=source, page_heading="Clone FFW Simulation")


@require_POST
def run_saved_ffw_simulation(request: HttpRequest, run_id: int) -> HttpResponse:
    config = _get_latest_ffw_config_or_404(run_id)
    run = config.run

    try:
        config.full_clean()
    except ValidationError as exc:
        logger.warning(
            "Saved FFW config for run %s failed re-validation and could not be run: %s",
            run_id,
            exc.message_dict,
        )
        messages.error(request, f'Unable to run "{run.name}": saved configuration is invalid.')
        return redirect("simulation-config")
    run.status = RunStatus.PENDING
    run.save(update_fields=["status"])
    _run_ffw(run, config)
    return redirect("analysis-partial")


def saved_simulations(request: HttpRequest) -> HttpResponse:
    """Render the list of saved simulation configurations.

    GET: Display all saved PHOLD and FFW configurations, most recently created first.
    """
    # TODO: This list is unbounded and will likely grow over time. Consider pagination once
    # the number of saved configs makes this a real usability concern.
    configs: list[PHOLDSimulationConfig | FFWSimulationConfig] = [
        *PHOLDSimulationConfig.objects.select_related("run"),
        *FFWSimulationConfig.objects.select_related("run"),
    ]
    configs.sort(key=lambda config: config.run.created, reverse=True)
    context: dict[str, object] = {"configs": configs}
    partial_template = "net_maestro/partials/saved_simulations.html"
    if request.headers.get("HX-Request"):
        return render(request, partial_template, context)
    context.update({"active_page": "simulation", "partial_template": partial_template})
    return render(request, "net_maestro/index.html", context)


def models_list(request: HttpRequest) -> HttpResponse:
    """Render the custom component list.

    TODO: Replace models_context() with database queries.
    TODO: Build absolute action URLs for create, edit, duplicate, and delete once those
    routes are implemented.
    """
    context = _avail_component_models_context()
    partial_template = "net_maestro/partials/models_list.html"
    if request.headers.get("HX-Request"):
        return render(request, partial_template, context)
    context.update({"active_page": "modelsList", "partial_template": partial_template})
    return render(request, "net_maestro/index.html", context)


def _new_model_form_context() -> dict[str, object]:
    """Return read-only demo context for the new custom component form.

    TODO: Replace this static host example with a real Django form bound to model-backed
    base component choices and custom component defaults.
    TODO: Keep field metadata in the view so the template can render form sections without
    knowing which fields belong to hosts, routers, or switches.
    """
    return {
        "form_sections": [
            {
                "title": "Model",
                "fields": [
                    {"label": "Name", "value": "New Model"},
                    {"label": "Component Type", "value": "Router"},
                    {"label": "Engine", "value": "PDES (CODES)"},
                    {"label": "Description", "value": "Simple point-to-point router."},
                    {
                        "label": "Parameters",
                        "value": "routing, latency, bandwidth, chunk_size, vc_size",
                    },
                ],
            },
        ],
    }


def model_create(request: HttpRequest) -> HttpResponse:
    """Render the demonstration form for creating a new model component.

    TODO: Render and process a real form for creating a new model.
    TODO: Validate component fields by type, especially host-only traffic fields.
    TODO: Return either a full-page redirect or an HTMX partial update after successful create.
    """
    context = _new_model_form_context()
    partial_template = "net_maestro/partials/model_form.html"
    if request.headers.get("HX-Request"):
        return render(request, partial_template, context)
    context.update({"active_page": "modelsList", "partial_template": partial_template})
    return render(request, "net_maestro/index.html", context)


def topology_page(request: HttpRequest) -> HttpResponse:
    """Render the topology page with the presets available to preview.

    A `family` query parameter narrows the page to one family of topologies,
    which is how the Available Models page opens it on a single model's presets.

    TODO: Replace the read-only preset dropdown with database-backed topologies once
    Topology models exist.
    """
    family = request.GET.get("family", "").strip().lower()
    context: dict[str, object] = {
        "topologies": list_topologies(family or None),
        "family": family,
        "family_label": family_label(family) if family else "",
    }
    partial_template = "net_maestro/partials/topology.html"
    if request.headers.get("HX-Request"):
        return render(request, partial_template, context)
    context.update({"active_page": "topology", "partial_template": partial_template})
    return render(request, "net_maestro/index.html", context)


def page_view(
    request: HttpRequest,
    partial: str,
    active_page: str,
) -> HttpResponse:
    """Render a page using its partial template.

    For HTMX requests, returns only the partial fragment.
    For direct navigation, renders the partial inside the base layout.
    """
    partial_template = f"net_maestro/partials/{partial}.html"
    context: dict[str, object] = {}
    if partial == "analysis":
        context.update(_filtered_runs(request))
    if partial == "configuration":
        db_components = [
            _component_to_card(c) for c in ComponentModel.objects.order_by("-created_at")
        ]
        context.update(
            {
                "base_models": _base_models_sidebar_context(),
                "custom_components": db_components,
            }
        )
    if request.headers.get("HX-Request"):
        return render(request, partial_template, context)
    context.update({"active_page": active_page, "partial_template": partial_template})
    return render(request, "net_maestro/index.html", context)
