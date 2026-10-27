#!/usr/bin/env python3
"""Build the policymaker demo and the commute survey (static, single-file pages) into OUT.

    python3 static/build.py --out /var/www/kalisi

Writes OUT/demo/index.html (shareable demo), OUT/demo/presenter.html (with presenter notes and demo controls)
and OUT/survey/index.html. Python standard library only.

Configuration comes from environment variables, so the server's .env decides it:
  KALISI_DOMAIN         public name; the survey's "See how the app would work" button opens https://<it>/demo/
  SURVEY_ENDPOINT       Google Apps Script web-app URL ending in /exec (docs/survey/SURVEY_SETUP.md).
                        Empty = preview mode: the survey works but tells people nothing was saved.
  SURVEY_ORG_NAME       shown on the consent screen
  SURVEY_ORG_CONTACT    email shown for deletion requests
  SURVEY_RETENTION      how long answers are kept (default "12 months")
  GOOGLE_MAPS_API_KEY   optional; address search uses built-in OpenStreetMap data without it (docs/survey/SETUP.md)

Sources (static/src): template.html (the app), leaflet.min.css, metro-lines.json (HMRL GTFS),
search.b64 and map.b64 (OpenStreetMap gazetteer and roads, gzip + base64).
"""
import argparse
import json
import os
import re
from pathlib import Path

SRC = Path(__file__).resolve().parent / "src"
H3_TAG = '<script src="https://cdn.jsdelivr.net/npm/h3-js@4.1.0/dist/h3-js.umd.js"></script>'
OSM = 'Address search and maps © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors (ODbL). Metro stations: HMRL timetable feed, Open Data Telangana.'
HEAD = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
        '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}'
        'body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>\n</head>\n<body>\n')
TAIL = "\n</body>\n</html>\n"


def assemble() -> str:
    t = (SRC / "template.html").read_text(encoding="utf-8")
    for marker, f in [("/*LEAFLET_CSS*/", "leaflet.min.css"), ("/*METRO*/null", "metro-lines.json"),
                      ("/*SEARCH_DATA*/", "search.b64"), ("/*MAP_DATA*/", "map.b64")]:
        assert t.count(marker) == 1, marker
        t = t.replace(marker, (SRC / f).read_text(encoding="utf-8").strip())
    return t


def set_const(page: str, name: str, value) -> str:
    """Replace the whole `const NAME = ...;` line with a safely quoted value."""
    pat = re.compile(rf"^const {name} = .*?;.*$", re.M)
    assert len(pat.findall(page)) == 1, name
    return pat.sub(lambda _: f"const {name} = {json.dumps(value)};", page)


def configure(page: str, survey: bool) -> str:
    env = os.environ.get
    domain = env("KALISI_DOMAIN", "")
    page = set_const(page, "GOOGLE_MAPS_API_KEY", env("GOOGLE_MAPS_API_KEY", ""))
    if survey:
        page = set_const(page, "SURVEY_ENDPOINT", env("SURVEY_ENDPOINT", ""))
        page = set_const(page, "ORG_NAME", env("SURVEY_ORG_NAME", "") or "[Your organisation]")
        page = set_const(page, "ORG_CONTACT", env("SURVEY_ORG_CONTACT", "") or "[contact email]")
        page = set_const(page, "RETENTION", env("SURVEY_RETENTION", "") or "12 months")
        page = set_const(page, "DEMO_URL", f"https://{domain}/demo/" if domain else "../demo/")
    return page


def build(out: Path) -> dict[str, int]:
    t = assemble()
    notes = re.compile(r"  <!--NOTES-->.*?<!--/NOTES-->\n", re.S)
    clean = (notes.sub("", t).replace("  <!--CREDITS-->", f'  <p class="credits">Concept demo: riders, drivers, routes, prices and numbers are fictional. {OSM}</p>')
             .replace('<div class="stage">', '<div class="stage solo">', 1).replace("<!--H3-->\n", ""))
    presenter = (t.replace("  <!--NOTES-->\n", "").replace("  <!--/NOTES-->\n", "").replace("  <!--CREDITS-->\n", "")
                 .replace("<title>Kalisi Commute</title>", "<title>Kalisi Commute Presenter</title>", 1).replace("<!--H3-->\n", ""))
    survey = (notes.sub("", t).replace("<!--H3-->", H3_TAG).replace("  <!--CREDITS-->", f'  <p class="credits">Research survey. {OSM}</p>')
              .replace('<div class="stage">', '<div class="stage solo">', 1)
              .replace("const SURVEY = /*SURVEY_MODE*/false;", "const SURVEY = true;")
              .replace("<title>Kalisi Commute</title>", "<title>Kalisi Commute Survey</title>", 1))
    assert 'class="notes"' not in clean and 'class="notes"' in presenter and "const SURVEY = true;" in survey
    pages = {"demo/index.html": configure(clean, False), "demo/presenter.html": configure(presenter, False),
             "survey/index.html": configure(survey, True)}
    sizes = {}
    for rel, html in pages.items():
        p = out / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(HEAD + html + TAIL, encoding="utf-8")
        sizes[rel] = p.stat().st_size
    return sizes


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, type=Path)
    for rel, n in build(ap.parse_args().out).items():
        print(f"  {rel}: {n / 1e6:.1f} MB")
