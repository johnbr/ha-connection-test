"""Import the integration's pure modules without Home Assistant installed.

CI installs pytest and ruff, nothing else -- no Home Assistant, no aiohttp, no
voluptuous. ``const.py`` and ``measure.py`` are deliberately free of all three,
but they live in a package whose ``__init__`` is not, and Python runs that
``__init__`` before any submodule.

Rather than stub out half of Home Assistant to get past it, the two pure
modules are imported under a synthetic package rooted at the same directory.
Their relative imports resolve, nothing else is loaded, and there is no stub
surface to drift out of date. Anything that touches the config flow, the views
or the entities needs a real Home Assistant plus
``pytest-homeassistant-custom-component`` and is out of scope here.
"""

from __future__ import annotations

import importlib
import sys
import types
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
COMPONENT_DIR = REPO_ROOT / "custom_components" / "connection_test"

_PURE_PACKAGE = "connection_test_pure"


def _install_pure_package() -> None:
    if _PURE_PACKAGE in sys.modules:
        return
    package = types.ModuleType(_PURE_PACKAGE)
    package.__path__ = [str(COMPONENT_DIR)]
    sys.modules[_PURE_PACKAGE] = package


_install_pure_package()

const = importlib.import_module(f"{_PURE_PACKAGE}.const")
measure = importlib.import_module(f"{_PURE_PACKAGE}.measure")
