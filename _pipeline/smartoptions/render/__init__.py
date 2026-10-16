"""LANE R: render out/<date>/{macro,calendar,equities,relations}.json into one self-contained HTML page.

Never fetches the network. Any input may be missing: its section renders as "unavailable" with the reason.
"""
from __future__ import annotations

from pathlib import Path

from ..log import event
from .load import load_inputs
from .page import build_page


def render(in_dir: Path, out_path: Path, log_dir: Path | None = None) -> dict:
    data, reasons = load_inputs(Path(in_dir), log_dir=log_dir)
    try:
        page = build_page(data, reasons)
    except Exception as e:  # a render bug must be visible in the build log, then re-raised (no silent empty page)
        event("render", "page", "FAIL", f"{type(e).__name__}: {e}", log_dir=log_dir)
        raise
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_suffix(out_path.suffix + ".tmp")
    tmp.write_text(page, encoding="utf-8")
    tmp.replace(out_path)
    loaded = [k for k, v in data.items() if v is not None]
    sev = "OK" if len(loaded) == 4 else "WARN"
    event("render", "page", sev, f"wrote {out_path} ({len(page)} chars); inputs loaded: {loaded}; missing: {sorted(reasons)}",
          count=len(page), log_dir=log_dir)
    return {"out": str(out_path), "bytes": len(page.encode("utf-8")), "loaded": loaded, "missing": reasons}
