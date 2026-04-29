#!/usr/bin/env python3
"""
dash_update.py — update a practice's dashboard HTML from a month-end report email.

The dashboard at <practice>-dashboard.html embeds its data as a single inline
JSON blob: `const RAW = {...};`. This script parses an emailed month-end
report (the format produced by practice-form.html's Email Report button) and
upserts the new month's values into that JSON blob.

Usage:

  # Single report file -> single dashboard
  python tools/dash_update.py --practice abas --report path/to/email.txt

  # Batch: process every .txt file in a directory
  python tools/dash_update.py --practice abas --reports-dir path/to/dir/

  # Preview without writing
  python tools/dash_update.py --practice abas --report email.txt --dry-run

  # Update + commit + push (use carefully)
  python tools/dash_update.py --practice abas --report email.txt --commit

Email format expected (matches practice-form.html emailReport()):

  Dr. <Practice>'s Practice -- <Mon> <Year> Month End Report

  Total Dr. Days Worked This Month: <N>

  -- CROWNS --
  From Last Month: <N>
  Prepped: <N> (<SD> SD)
  Future Booked: <N>
  Diagnosed Non-Cosmetic: <N>

  -- DOCTOR PRODUCTION --
  <Name>: $X / Y days (AVG: $Z)

  -- SPECIALTY --
  <Name>: $X         (omit line if zero)

  -- VISITS --
  New Patients: <N>
  Prophies: <N>
  Perio Maint: <N>
  SRP: <N>
  Arrestin: $<N or --> | Laser: $<N or -->

  -- HYGIENE --
  <Name>: $X / Y days (AVG: $Z)
  Empties: <N>            (informational, not stored — no RAW slot)
  Total: $X

  -- EXAMS --
  0150 Comp Exam: <N>
  0120 Periodic Exam: <N>
  0140 Limited Exam: <N>
  Bite Wellness: <N or -->

  -- IMAGING --
  Panos: <N>
  FMX: <N>
  CBCT: <N>             (optional, only practices that have it)

  -- RESULTS --
  Production: $X
  Collections: $X
  Next Month Schedule: $X

The "--" / "ââ" section markers are accepted in any byte form — the parser
splits on the section keyword (CROWNS, DOCTOR PRODUCTION, etc.).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parent.parent
VALID_PRACTICES = {"abas", "murray", "vanek", "pigneri", "bilbeisi"}

MONTH_ABBR = {
    "Jan": 1, "Feb": 2, "Mar": 3, "Apr": 4, "May": 5, "Jun": 6,
    "Jul": 7, "Aug": 8, "Sep": 9, "Oct": 10, "Nov": 11, "Dec": 12,
}
ABBR_BY_NUM = {v: k for k, v in MONTH_ABBR.items()}


# ----------------------------------------------------------------------------
# Email parsing
# ----------------------------------------------------------------------------

@dataclass
class ParsedReport:
    practice_label: str          # raw practice name from header (e.g. "Dr. Abas's Practice")
    iso_date: str                # "2026-03"
    days_in: int | None = None
    crowns: dict[str, int] = field(default_factory=dict)
    doctors: list[dict] = field(default_factory=list)
    specialty: dict[str, int] = field(default_factory=dict)
    visits: dict[str, int] = field(default_factory=dict)
    hygienists: list[dict] = field(default_factory=list)
    exams: dict[str, int] = field(default_factory=dict)
    imaging: dict[str, int] = field(default_factory=dict)
    results: dict[str, int] = field(default_factory=dict)


_HEADER_RE = re.compile(
    r"(?P<practice>Dr\.\s*[\w'\.\- ]+?Practice)\s*--\s*(?P<mon>[A-Za-z]{3})\s+(?P<year>\d{4})\s+Month End Report",
    re.IGNORECASE,
)


def _money(s: str) -> int | None:
    """Parse '$12,345' / '12345' / '12,345.67' / '--' -> int dollars or None."""
    s = s.strip().replace("$", "").replace(",", "")
    if s in ("", "--", "-"):
        return None
    try:
        return int(round(float(s)))
    except ValueError:
        return None


def _int(s: str) -> int | None:
    s = s.strip()
    if s in ("", "--", "-"):
        return None
    try:
        return int(round(float(s.replace(",", ""))))
    except ValueError:
        return None


def _section(body: str, name: str) -> str:
    """Extract everything between a '<noise><name><noise>' marker and the next marker.

    The form's emailReport uses non-ASCII characters as section markers, but the
    only stable cue is the SECTION NAME word in caps. We split on that.
    """
    # Find a line that contains the section name in uppercase (with possible surrounding chars)
    pattern = re.compile(rf"^[^\n]*\b{re.escape(name)}\b[^\n]*$", re.MULTILINE)
    matches = list(pattern.finditer(body))
    if not matches:
        return ""
    start = matches[0].end()
    # Find next section marker line — any line that looks like a header (all caps word for at least 4 letters)
    after = body[start:]
    next_marker = re.search(
        r"^[^\n]*\b(CROWNS|DOCTOR PRODUCTION|SPECIALTY|VISITS|HYGIENE|EXAMS|IMAGING|RESULTS)\b[^\n]*$",
        after,
        re.MULTILINE,
    )
    end = next_marker.start() if next_marker else len(after)
    return after[:end].strip()


def parse_report(text: str) -> ParsedReport:
    m = _HEADER_RE.search(text)
    if not m:
        raise ValueError(
            "Couldn't find report header. Expected line like:\n"
            "  Dr. Abas's Practice -- Dec 2025 Month End Report"
        )
    practice_label = m.group("practice")
    mon_abbr = m.group("mon").title()
    if mon_abbr not in MONTH_ABBR:
        raise ValueError(f"Unknown month abbreviation: {mon_abbr}")
    year = int(m.group("year"))
    iso_date = f"{year:04d}-{MONTH_ABBR[mon_abbr]:02d}"

    rep = ParsedReport(practice_label=practice_label, iso_date=iso_date)

    # Total Dr. Days
    md = re.search(r"Total Dr\. Days Worked This Month:\s*(\S+)", text)
    if md:
        rep.days_in = _int(md.group(1))

    # Crowns
    sect = _section(text, "CROWNS")
    if sect:
        for label, key in [
            ("From Last Month", "Crowns from LAST MONTH"),
            ("Prepped", "Crowns PREPPED"),
            ("Future Booked", "Crowns FUTURE BOOKED"),
            ("Diagnosed Non-Cosmetic", "Crown diagnosed - NON Cosmetic"),
        ]:
            mm = re.search(rf"^\s*{re.escape(label)}\s*:\s*([^\n(]+)", sect, re.MULTILINE)
            if mm:
                v = _int(mm.group(1))
                if v is not None:
                    rep.crowns[key] = v

    # Doctor Production: lines like "Dr. Abas: $58,182 / 14 days (AVG: $4,156)"
    sect = _section(text, "DOCTOR PRODUCTION")
    for line in sect.splitlines():
        mm = re.match(
            r"\s*(?P<name>[^:]+?)\s*:\s*\$?(?P<prod>[\d,.\-]+)\s*/\s*(?P<days>[\d.]+)\s*days",
            line,
        )
        if mm:
            prod = _money(mm.group("prod"))
            days = _int(mm.group("days"))
            if prod is not None and days is not None:
                rep.doctors.append({"name": mm.group("name").strip(), "production": prod, "days": days})

    # Specialty: "Cosmetic: $1234"
    sect = _section(text, "SPECIALTY")
    for line in sect.splitlines():
        mm = re.match(r"\s*(?P<name>[^:]+?)\s*:\s*\$?(?P<v>[\d,.\-]+)", line)
        if mm:
            v = _money(mm.group("v"))
            if v:
                rep.specialty[mm.group("name").strip()] = v

    # Visits
    sect = _section(text, "VISITS")
    visit_map = {
        "new patients": "New Patients seen",
        "prophies": "1110 Prophy",
        "perio maint": "4910 Perio Maint",
        "srp": "SRP--PATIENTS NOT Quads",
    }
    for line in sect.splitlines():
        # Standard "label: number" lines
        mm = re.match(r"\s*([^:|]+?)\s*:\s*([^|\n]+)", line)
        if mm:
            label = mm.group(1).strip().lower()
            if label in visit_map:
                v = _int(mm.group(2))
                if v is not None:
                    rep.visits[visit_map[label]] = v
        # "Arrestin: $-- | Laser: $--" — both on one line
        am = re.search(r"Arrestin\s*:\s*\$?([^|]+?)(?:\s*\||\s*$)", line)
        if am:
            v = _money(am.group(1))
            if v is not None:
                rep.visits["Arrestin $"] = v
        lm = re.search(r"Laser\s*:\s*\$?([^|]+?)(?:\s*\||\s*$)", line)
        if lm:
            v = _money(lm.group(1))
            if v is not None:
                rep.visits["Laser $"] = v

    # Hygiene: "Tina: $17,311 / 14 days (AVG: $1,237)"
    sect = _section(text, "HYGIENE")
    for line in sect.splitlines():
        mm = re.match(
            r"\s*(?P<name>[^:]+?)\s*:\s*\$?(?P<prod>[\d,.\-]+)\s*/\s*(?P<days>[\d.]+)\s*days",
            line,
        )
        if mm:
            prod = _money(mm.group("prod"))
            days = _int(mm.group("days"))
            if prod is not None and days is not None:
                rep.hygienists.append({"name": mm.group("name").strip(), "production": prod, "days": days})

    # Exams
    sect = _section(text, "EXAMS")
    exam_map = {
        "0150 comp exam": "0150 Comp Exam",
        "0120 periodic exam": "0120 Periodic Exam",
        "0140 limited exam": "0140 Limited Exam",
        "bite wellness": "Bite Wellness",
    }
    for line in sect.splitlines():
        mm = re.match(r"\s*([^:]+?)\s*:\s*([^\n]+)", line)
        if mm:
            label = mm.group(1).strip().lower()
            if label in exam_map:
                v = _int(mm.group(2))
                if v is not None:
                    rep.exams[exam_map[label]] = v

    # Imaging
    sect = _section(text, "IMAGING")
    imaging_map = {
        "panos": "Panos",
        "fmx": "FMX",
        "cbct": "CBCT",
        "digital scan": "Digital Scan",
    }
    for line in sect.splitlines():
        mm = re.match(r"\s*([^:]+?)\s*:\s*([^\n]+)", line)
        if mm:
            label = mm.group(1).strip().lower()
            if label in imaging_map:
                v = _int(mm.group(2))
                if v is not None:
                    rep.imaging[imaging_map[label]] = v

    # Results
    sect = _section(text, "RESULTS")
    results_map = {
        "production": "Production",
        "collections": "Collections",
        "next month schedule": "Future Scheduled",
    }
    for line in sect.splitlines():
        mm = re.match(r"\s*([^:]+?)\s*:\s*([^\n]+)", line)
        if mm:
            label = mm.group(1).strip().lower()
            if label in results_map:
                v = _money(mm.group(2))
                if v is not None:
                    rep.results[results_map[label]] = v

    return rep


# ----------------------------------------------------------------------------
# RAW JSON manipulation
# ----------------------------------------------------------------------------

_RAW_RE = re.compile(r"const RAW = (\{.*?\});", re.DOTALL)


def load_raw(html: str) -> dict[str, list]:
    m = _RAW_RE.search(html)
    if not m:
        raise ValueError("Couldn't find `const RAW = {...};` in dashboard HTML.")
    return json.loads(m.group(1))


def write_raw(html: str, raw: dict[str, list]) -> str:
    """Replace the `const RAW = {...};` line in the HTML with new JSON.

    JSON is dumped compact (no whitespace) on one line to match existing format.
    """
    new_blob = json.dumps(raw, separators=(",", ":"), ensure_ascii=False)
    new_line = f"const RAW = {new_blob};"
    return _RAW_RE.sub(lambda _m: new_line, html, count=1)


def upsert_entries(raw: dict[str, list], rep: ParsedReport) -> dict[str, int]:
    """Replace any entries for rep.iso_date with the new ones from rep.

    Returns a per-category count of entries written.
    """
    written: dict[str, int] = {c: 0 for c in
                               ("results", "days", "crowns", "doctor", "hygiene",
                                "visits", "exams", "imaging", "specialty")}
    for cat in written:
        raw.setdefault(cat, [])
        # Remove existing entries for this date
        raw[cat] = [e for e in raw[cat] if e.get("date") != rep.iso_date]

    # results
    for dim, val in rep.results.items():
        raw["results"].append({"date": rep.iso_date, "dimension": dim, "value": val})
        written["results"] += 1

    # days (no dimension; just value)
    if rep.days_in is not None:
        raw["days"].append({"date": rep.iso_date, "value": rep.days_in})
        written["days"] += 1

    # crowns
    for dim, val in rep.crowns.items():
        raw["crowns"].append({"date": rep.iso_date, "dimension": dim, "value": val})
        written["crowns"] += 1

    # doctor (per-doctor row)
    for d in rep.doctors:
        raw["doctor"].append({"date": rep.iso_date, "name": d["name"],
                              "production": d["production"], "days": d["days"]})
        written["doctor"] += 1

    # hygiene (per-hygienist row)
    for h in rep.hygienists:
        raw["hygiene"].append({"date": rep.iso_date, "name": h["name"],
                               "production": h["production"], "days": h["days"]})
        written["hygiene"] += 1

    # visits (count, not value, to match canonical pattern)
    for dim, val in rep.visits.items():
        raw["visits"].append({"date": rep.iso_date, "dimension": dim, "count": val})
        written["visits"] += 1

    # exams (count)
    for dim, val in rep.exams.items():
        raw["exams"].append({"date": rep.iso_date, "dimension": dim, "count": val})
        written["exams"] += 1

    # imaging (count)
    for dim, val in rep.imaging.items():
        raw["imaging"].append({"date": rep.iso_date, "dimension": dim, "count": val})
        written["imaging"] += 1

    # specialty (production)
    for dim, val in rep.specialty.items():
        raw["specialty"].append({"date": rep.iso_date, "dimension": dim, "production": val})
        written["specialty"] += 1

    # Sort each category by (date, dimension) for stable diffs
    for cat, entries in raw.items():
        entries.sort(key=lambda e: (e.get("date", ""), e.get("dimension", ""), e.get("name", "")))

    return written


# ----------------------------------------------------------------------------
# Git plumbing
# ----------------------------------------------------------------------------

def _git(*args: str) -> str:
    out = subprocess.run(
        ["git", *args], cwd=REPO_ROOT, capture_output=True, text=True, check=False
    )
    if out.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed:\n{out.stderr}")
    return out.stdout.strip()


def commit_and_push(practice: str, iso_date: str) -> None:
    _git("add", f"{practice}-dashboard.html")
    msg = f"Update {practice} dashboard with {iso_date} month-end data"
    _git("commit", "-m", msg)
    _git("push")


# ----------------------------------------------------------------------------
# CLI
# ----------------------------------------------------------------------------

def process_one_report(
    practice: str, report_path: Path, dry_run: bool, verbose: bool
) -> tuple[str, dict[str, int]]:
    text = report_path.read_text(encoding="utf-8", errors="replace")
    rep = parse_report(text)

    # Sanity: warn if practice name in report doesn't roughly match expected practice arg
    expected_in_label = practice.lower()
    if expected_in_label not in rep.practice_label.lower():
        print(
            f"WARN: report header says '{rep.practice_label}' but --practice={practice}",
            file=sys.stderr,
        )

    dash_path = REPO_ROOT / f"{practice}-dashboard.html"
    if not dash_path.exists():
        raise FileNotFoundError(f"No dashboard at {dash_path}")

    html = dash_path.read_text(encoding="utf-8")
    raw = load_raw(html)
    written = upsert_entries(raw, rep)
    new_html = write_raw(html, raw)

    if verbose:
        print(f"\n[{report_path.name}] -> {practice}-dashboard.html  date={rep.iso_date}")
        for cat, n in written.items():
            print(f"  {cat:<10} {n} entries")

    if not dry_run:
        dash_path.write_text(new_html, encoding="utf-8")

    return rep.iso_date, written


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--practice", required=True, choices=sorted(VALID_PRACTICES))
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--report", type=Path, help="Single report file (.txt)")
    g.add_argument("--reports-dir", type=Path,
                   help="Directory of report files; processes all *.txt")
    p.add_argument("--dry-run", action="store_true",
                   help="Parse and show what would change, but don't write the dashboard")
    p.add_argument("--commit", action="store_true",
                   help="git commit+push the updated dashboard after writing")
    p.add_argument("--quiet", action="store_true")
    args = p.parse_args(argv)

    verbose = not args.quiet

    if args.report:
        report_files = [args.report]
    else:
        report_files = sorted(args.reports_dir.glob("*.txt"))
        if not report_files:
            print(f"No .txt files found in {args.reports_dir}", file=sys.stderr)
            return 1

    iso_dates_processed: list[str] = []
    for rf in report_files:
        try:
            iso, _ = process_one_report(args.practice, rf, args.dry_run, verbose)
            iso_dates_processed.append(iso)
        except Exception as e:
            print(f"ERROR in {rf}: {e}", file=sys.stderr)
            return 1

    if args.commit and not args.dry_run:
        for iso in sorted(set(iso_dates_processed)):
            commit_and_push(args.practice, iso)
            if verbose:
                print(f"Pushed {args.practice} {iso}")

    if args.dry_run and verbose:
        print("\n(dry run — no files written)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
