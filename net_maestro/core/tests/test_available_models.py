"""Tests for the available models page (simulation models list)."""

from __future__ import annotations

from typing import TYPE_CHECKING

from django.urls import reverse
import pytest

from net_maestro.core.simulation_models import SIMULATION_MODELS

if TYPE_CHECKING:
    from django.test import Client


class TestSimulationModelsData:
    """Test the SIMULATION_MODELS registry structure."""

    def test_five_simulation_models(self) -> None:
        assert len(SIMULATION_MODELS) == 5

    def test_fabric_is_first(self) -> None:
        assert SIMULATION_MODELS[0]["name"] == "NSF FABRIC Testbed"

    def test_order(self) -> None:
        names = [m["name"] for m in SIMULATION_MODELS]
        assert names == [
            "NSF FABRIC Testbed",
            "Fluid Flow WAN",
            "PHOLD",
            "Ping Pong",
            "ESnet",
        ]

    def test_enabled_models_have_url(self) -> None:
        for m in SIMULATION_MODELS:
            if not m["disabled"]:
                assert m["url_name"], f"{m['name']} is enabled but has no url_name"
                assert m["active_page"], f"{m['name']} is enabled but has no active_page"

    def test_disabled_models(self) -> None:
        disabled = [m["name"] for m in SIMULATION_MODELS if m["disabled"]]
        assert set(disabled) == {"Ping Pong", "ESnet"}

    def test_ffw_has_component_models(self) -> None:
        ffw = next(m for m in SIMULATION_MODELS if m["name"] == "Fluid Flow WAN")
        components = ffw["component_models"]
        assert isinstance(components, list)
        component_names = [c["name"] for c in components]
        assert "fluid-flow-wan-switch-lp" in component_names

    def test_phold_has_no_component_models(self) -> None:
        phold = next(m for m in SIMULATION_MODELS if m["name"] == "PHOLD")
        assert phold["component_models"] == []


@pytest.mark.django_db
class TestModelsListView:
    """Test the /models/ page renders correctly."""

    def test_get_renders_page(self, client: Client) -> None:
        response = client.get(reverse("models-list-partial"))

        assert response.status_code == 200
        assert "simulation_models" in response.context

    def test_htmx_returns_partial(self, client: Client) -> None:
        response = client.get(
            reverse("models-list-partial"),
            HTTP_HX_REQUEST="true",
        )

        assert response.status_code == 200
        templates = [t.name for t in response.templates]
        assert "net_maestro/partials/models_list.html" in templates

    def test_get_started_links_for_enabled_models(self, client: Client) -> None:
        response = client.get(reverse("models-list-partial"))
        content = response.content.decode()

        assert "Get Started" in content
        assert reverse("configuration-partial") in content
        assert reverse("simulation-config") in content
        assert f"{reverse('topology-partial')}?family=fabric" in content

    def test_coming_soon_for_disabled_models(self, client: Client) -> None:
        response = client.get(reverse("models-list-partial"))
        content = response.content.decode()

        assert "Coming Soon" in content

    def test_first_card_auto_expanded(self, client: Client) -> None:
        response = client.get(reverse("models-list-partial"))
        content = response.content.decode()

        assert 'aria-label="Toggle NSF FABRIC Testbed details" checked' in content
        assert 'aria-label="Toggle Fluid Flow WAN details" checked' not in content

    def test_component_models_rendered_inside_ffw(self, client: Client) -> None:
        response = client.get(reverse("models-list-partial"))
        content = response.content.decode()

        assert "fluid-flow-wan-switch-lp" in content
