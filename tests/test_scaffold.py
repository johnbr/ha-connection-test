"""Repository-shape tests.

These run without Home Assistant installed, so they cover the metadata HACS and
hassfest validate rather than integration behaviour. The version-drift check is
the load-bearing one: release-please bumps ``manifest.json``,
``.release-please-manifest.json`` and the card's banner together, and a hand
edit to any one of them silently breaks the card's ``?v=`` cache-buster.
"""

from __future__ import annotations

import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DOMAIN = "connection_test"
COMPONENT_DIR = REPO_ROOT / "custom_components" / DOMAIN
CARD = COMPONENT_DIR / "frontend" / "connection-test-card.js"

REQUIRED_MANIFEST_KEYS = (
    "domain",
    "name",
    "codeowners",
    "documentation",
    "issue_tracker",
    "version",
)


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_single_integration_in_repo() -> None:
    """HACS allows exactly one integration per repository."""
    integrations = sorted(p.name for p in (REPO_ROOT / "custom_components").iterdir() if p.is_dir())
    assert integrations == [DOMAIN]


def test_manifest_has_required_keys() -> None:
    manifest = _load(COMPONENT_DIR / "manifest.json")
    missing = [key for key in REQUIRED_MANIFEST_KEYS if not manifest.get(key)]
    assert not missing, f"manifest.json missing: {missing}"


def test_manifest_domain_matches_directory() -> None:
    assert _load(COMPONENT_DIR / "manifest.json")["domain"] == COMPONENT_DIR.name


def test_manifest_version_matches_release_please() -> None:
    manifest_version = _load(COMPONENT_DIR / "manifest.json")["version"]
    tracked_version = _load(REPO_ROOT / ".release-please-manifest.json")["."]
    assert manifest_version == tracked_version


def test_card_version_matches_manifest() -> None:
    """The card's banner version must track the manifest."""
    manifest_version = _load(COMPONENT_DIR / "manifest.json")["version"]
    assert f'"{manifest_version}"; // x-release-please-version' in CARD.read_text(encoding="utf-8")


def test_release_please_updates_the_card() -> None:
    """A version bump that skipped the card would leave a stale banner."""
    config = _load(REPO_ROOT / "release-please-config.json")
    extra = config["packages"]["."]["extra-files"]
    assert "custom_components/connection_test/frontend/connection-test-card.js" in extra


def test_hacs_json_has_name() -> None:
    assert _load(REPO_ROOT / "hacs.json").get("name")


def test_brand_icon_present() -> None:
    """HACS validates a brand icon for integrations."""
    assert (COMPONENT_DIR / "brand" / "icon.png").is_file()


def test_config_flow_declared_and_translated() -> None:
    """``config_flow: true`` requires a flow module and matching strings."""
    manifest = _load(COMPONENT_DIR / "manifest.json")
    assert manifest.get("config_flow") is True
    assert (COMPONENT_DIR / "config_flow.py").is_file()

    strings = _load(COMPONENT_DIR / "strings.json")
    assert "user" in strings["config"]["step"]
    # translations/en.json must stay in sync with strings.json.
    assert _load(COMPONENT_DIR / "translations" / "en.json") == strings


def test_service_fields_documented_and_declared() -> None:
    """A field in services.yaml with no string is an unlabelled box in the UI.

    Nothing else catches this: the service still works, hassfest does not
    compare the two files, and the only symptom is a blank label.
    """
    services_yaml = (COMPONENT_DIR / "services.yaml").read_text(encoding="utf-8")
    documented = _load(COMPONENT_DIR / "strings.json")["services"]["report"]["fields"]
    for field in documented:
        assert f"    {field}:" in services_yaml, f"{field} documented but not in services.yaml"


def test_api_paths_agree_between_python_and_the_card() -> None:
    """The card fetches these by literal path; a rename on one side fails silently.

    Python lints clean, the card syntax-checks, and the only symptom is a test
    that always reports a failure.
    """
    const_py = (COMPONENT_DIR / "const.py").read_text(encoding="utf-8")
    card_js = CARD.read_text(encoding="utf-8")
    for path in ("/api/connection_test/echo", "/api/connection_test/download", "/api/connection_test/upload"):
        assert f'"{path}"' in const_py, f"{path} not defined in const.py"
        assert f'"{path}"' in card_js, f"{path} not used by the card"


def test_endpoints_stay_under_api() -> None:
    """The /api/ prefix is what keeps the service worker out of the way.

    Moved anywhere else -- /local/ especially -- the frontend's catch-all
    StaleWhileRevalidate route answers a download from Cache Storage and the
    result becomes fiction. See const.py.
    """
    const_py = (COMPONENT_DIR / "const.py").read_text(encoding="utf-8")
    for line in const_py.splitlines():
        if line.startswith(("API_ECHO", "API_DOWNLOAD", "API_UPLOAD")):
            assert '"/api/' in line, f"endpoint escaped /api/: {line}"


def test_the_card_is_loadable_outside_a_browser() -> None:
    """Registration must stay guarded, or the Node card tests cannot run."""
    card = CARD.read_text(encoding="utf-8")
    assert 'if (typeof customElements !== "undefined")' in card
    assert 'typeof module !== "undefined"' in card
