from __future__ import annotations

import json
import logging
from typing import Any


LOGGER = logging.getLogger("fantasy_gm")


def record_event(event: str, **fields: Any) -> None:
    """Emit a structured operational event without user or league identifiers."""
    safe_fields = {
        key: value
        for key, value in fields.items()
        if value is None or isinstance(value, (str, int, float, bool))
    }
    LOGGER.info(json.dumps({"event": event, **safe_fields}, sort_keys=True, separators=(",", ":")))
