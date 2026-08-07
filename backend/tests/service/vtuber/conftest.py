"""Shared reset for the screen-observation module's process-global tables.

`_last_prune_at` throttles a session's prune sweep to once an hour, keyed by
session id. Several files here drive `_prune_old_observations("s1", ...)`, so
whichever ran first left the throttle armed and the next one's sweep did
nothing — passing or failing purely on collection order. It passed locally and
failed in CI, which is the worst version of that: the suite disagreed with
itself depending on where it ran.

The module already exposes the reset hook; it just was not applied everywhere.
"""

import pytest


@pytest.fixture(autouse=True)
def _reset_screen_observation_state():
    from service.vtuber.screen_observation import reset_cooldown_state_for_tests

    reset_cooldown_state_for_tests()
    yield
    reset_cooldown_state_for_tests()
