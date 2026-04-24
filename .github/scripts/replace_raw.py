#!/usr/bin/env python3
"""Replace the `const RAW = {...};` line in [practice]-dashboard.html.

Reads a JSON object (the dashboard RAW shape, keys like `results`, `days`,
`crowns`, ...) from stdin. Serializes it to a single line and swaps the
existing `const RAW = {...};` declaration in the top-level dashboard file.

Usage:
    echo "$RAW_JSON" | python3 replace_raw.py murray
"""
import json
import re
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 2:
        sys.stderr.write("usage: replace_raw.py <practice>\n")
        return 2

    practice = sys.argv[1].strip().lower()
    if not re.match(r"^[a-z][a-z0-9_-]*$", practice):
        sys.stderr.write(f"invalid practice name: {practice!r}\n")
        return 2

    path = Path(f"{practice}-dashboard.html")
    if not path.exists():
        sys.stderr.write(f"dashboard file not found: {path}\n")
        return 1

    raw = json.loads(sys.stdin.read())
    # Serialize without spaces for minimal diff size. Matches the existing
    # single-line format in the dashboards so git diffs stay one line.
    new_blob = json.dumps(raw, separators=(",", ":"), ensure_ascii=False)

    html = path.read_text()
    pattern = re.compile(r"const\s+RAW\s*=\s*\{.*?\};", re.DOTALL)
    if not pattern.search(html):
        sys.stderr.write(
            f"no `const RAW = {{...}};` declaration found in {path}\n"
        )
        return 1

    new_html, n = pattern.subn(f"const RAW = {new_blob};", html, count=1)
    if n != 1:
        sys.stderr.write(f"expected exactly 1 replacement, got {n}\n")
        return 1

    path.write_text(new_html)
    print(f"Updated {path} ({len(new_blob)} bytes in RAW block)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
