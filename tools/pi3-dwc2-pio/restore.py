"""Restore the stock host. Safe to repeat within the same boot."""

import json
import os
import sys
from runtime import STATE, secure_state, restore_binding, require


def restore():
    # Keep state and the lock until reboot. A queued timer can then repeat safely.
    if not STATE.exists():
        require(os.geteuid() == 0, "Run this command as root")
        print("No runtime state exists. No action was taken.", file=sys.stderr)
        return
    with secure_state():
        saved = json.loads((STATE / "state.json").read_text())
        restore_binding(saved)
        saved["restored"] = True
        (STATE / "state.json").write_text(json.dumps(saved) + "\n")
    print("Stock dwc2 restored. The test module is unloaded.", file=sys.stderr)


if __name__ == "__main__":
    restore()
