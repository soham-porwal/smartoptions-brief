"""python -m smartoptions.render --in out/<date> --out out/<date>/index.html"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import render


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="smartoptions.render", description=__doc__)
    ap.add_argument("--in", dest="in_dir", required=True, help="directory holding macro/calendar/equities/relations.json")
    ap.add_argument("--out", dest="out", default=None, help="output HTML path (default: <in>/index.html)")
    a = ap.parse_args(argv)
    out = Path(a.out) if a.out else Path(a.in_dir) / "index.html"
    res = render(Path(a.in_dir), out)
    print(json.dumps(res, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
