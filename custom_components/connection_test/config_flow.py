"""Config flow for Connection Test.

There is nothing to configure -- the endpoints are fixed and every knob that
matters (payload sizes, ping count, how a client names itself) belongs to the
dashboard card, because it is a property of the *client* being measured rather
than of the server.

The flow exists because entities that attach to a device must belong to a
config entry. Set up as a YAML platform instead, Home Assistant logs "attempts
to attach a device to an entity without a config entry ... will stop working in
Home Assistant 2027.8.0", drops the device link, and the sensors land as bare
`sensor.latency`, `sensor.latency_2`, ... with no device name in front of them.
"""

from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult

from .const import DOMAIN


class ConnectionTestConfigFlow(ConfigFlow, domain=DOMAIN):
    """Single-instance config flow."""

    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        """Handle the single confirmation step."""
        # `single_config_entry` in the manifest makes Home Assistant abort a
        # second flow before it reaches here; this is the belt to that braces,
        # and keeps the behaviour explicit for anyone reading the flow.
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")

        if user_input is None:
            return self.async_show_form(step_id="user")

        return self.async_create_entry(title="Connection Test", data={})
