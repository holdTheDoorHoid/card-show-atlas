"""Small helpers the source modules share.

Nothing here touches the network. The names start with an underscore so the harvest runner never
mistakes this file for a source.

LayoutChanged is the way a source says "the page does not look the way I was written for". The
runner turns any exception into a failed run that keeps the last good file, so a source that
raises LayoutChanged can never write junk. Give it a message a person can act on: which page,
what was expected, what was found.
"""

from __future__ import annotations

import re
from datetime import date, timedelta
from html import unescape

from ..regions import region_code
from ..textparse import find_dates
from ..util import norm_text


class LayoutChanged(RuntimeError):
    """A page no longer has the shape the source module expects."""

    def __init__(self, source: str, page: str, expected: str, found: str = ""):
        text = f"{source}: the page {page} no longer looks as expected ({expected})"
        if found:
            text += f"; found {found}"
        super().__init__(text + ". The layout may have changed, so nothing was written and the last good file was kept.")


# ---------------------------------------------------------------- text

_BREAKS = re.compile(r"<\s*(?:br|/p|/li|/h[1-6]|/div|/tr|/td|/th|/ul|/ol|/table|/section)\b[^>]*>", re.I)
_TAGS = re.compile(r"<[^>]+>")
_COMMENTS = re.compile(r"<!--.*?-->", re.S)
_SCRIPTS = re.compile(r"<(script|style)\b.*?</\1\s*>", re.I | re.S)


def strip_comments(html: str) -> str:
    return _COMMENTS.sub("", html or "")


def clean(fragment: str | None) -> str:
    """Visible text of an HTML fragment on one line: tags removed, entities decoded, spaces collapsed."""
    if not fragment:
        return ""
    text = _TAGS.sub(" ", _COMMENTS.sub(" ", fragment))
    return " ".join(unescape(text).replace("\xa0", " ").split())


def text_lines(fragment: str | None) -> list[str]:
    """Visible text of an HTML fragment, one entry per block or line break, empties dropped."""
    if not fragment:
        return []
    html = _SCRIPTS.sub(" ", _COMMENTS.sub(" ", fragment))
    html = _BREAKS.sub("\n", html)
    text = unescape(_TAGS.sub(" ", html)).replace("\xa0", " ")
    return [" ".join(line.split()) for line in text.splitlines() if line.strip()]


def dashes_to_hyphen(text: str) -> str:
    """The date reader knows the plain hyphen only."""
    return re.sub(r"\s*[‐-―−]\s*", "-", text)


def date_span(text: str, today: date | None = None) -> list[date]:
    """Every day from the first to the last date in a phrase like 'December 4-6, 2026'.

    Dates written without a year are only read when today is given. Returns [] when there is no date,
    or when the dates are more than two weeks apart (not one event).
    """
    found = find_dates(dashes_to_hyphen(text), today)
    if not found:
        return []
    first, last = min(found), max(found)
    if (last - first).days > 14:
        return []
    return [first + timedelta(days=i) for i in range((last - first).days + 1)]


def day_rows(days: list[date], open_first: str | None = None, close_last: str | None = None) -> list[dict]:
    rows = [{"date": d.isoformat(), "open": None, "close": None} for d in days]
    if rows:
        rows[0]["open"] = open_first
        rows[-1]["close"] = close_last
    return rows


def money_text(amount: float | int | None, currency: str = "USD") -> str:
    if amount is None:
        return ""
    n = int(amount) if float(amount) == int(amount) else round(float(amount), 2)
    return f"${n:,}" + ("" if currency == "USD" else f" {currency}")


# ---------------------------------------------------------------- places

# Cities where card game premier events are held, to the state or province. Sources such as Limitless
# and the MTG wiki name a city and nothing else; the pipeline needs a region. A city that is not here is
# reported by the source module and skipped, never guessed. Add a line when a new one turns up.
_CITY_REGION = {
    "AL": "Birmingham, Huntsville, Mobile, Montgomery",
    "AZ": "Phoenix, Glendale, Tempe, Tucson, Mesa, Scottsdale",
    "AR": "Little Rock, Rogers, Conway, Fayetteville",
    "CA": "Los Angeles, San Diego, San Jose, San Francisco, Sacramento, Anaheim, Long Beach, Pasadena, Pomona, "
          "Ontario, Fresno, Oakland, Santa Clara, Burbank, Irvine, Oxnard, Riverside, Bakersfield, Stockton",
    "CO": "Denver, Colorado Springs, Aurora, Loveland",
    "CT": "Hartford, New Haven, Uncasville, Stamford, Mashantucket",
    "DC": "Washington, Washington DC, Washington D.C.",
    "DE": "Wilmington, Dover",
    "FL": "Orlando, Miami, Tampa, Jacksonville, Kissimmee, Oviedo, Daytona Beach, Fort Lauderdale, Sunrise, "
          "West Palm Beach, Pensacola, Sarasota, Tallahassee, Lakeland, Gainesville",
    "GA": "Atlanta, Savannah, Duluth, Augusta, Macon",
    "ID": "Boise, Nampa",
    "IL": "Chicago, Peoria, Rosemont, Collinsville, Schaumburg, Springfield IL, Naperville, Rockford, Champaign",
    "IN": "Indianapolis, Fort Wayne, South Bend, Evansville",
    "IA": "Des Moines, Cedar Rapids, Davenport",
    "KS": "Wichita, Overland Park, Kansas City KS, Topeka",
    "KY": "Louisville, Lexington",
    "LA": "New Orleans, Baton Rouge, Shreveport, Lafayette, Bossier City",
    "ME": "Portland ME, Bangor, Augusta ME",
    "MD": "Baltimore, College Park, Timonium, Hunt Valley, Rockville, Annapolis, Gaithersburg",
    "MA": "Boston, Worcester, Springfield MA, Marlborough, Providence MA",
    "MI": "Detroit, Novi, Grand Rapids, Lansing, Ann Arbor, Warren, Livonia",
    "MN": "Minneapolis, Saint Paul, St. Paul, Bloomington, Duluth MN",
    "MS": "Jackson, Biloxi, Tupelo",
    "MO": "St. Louis, Saint Louis, Kansas City, Springfield MO, Columbia",
    "NE": "Omaha, Lincoln",
    "NV": "Las Vegas, Reno, Henderson",
    "NH": "Manchester, Nashua, Concord NH",
    "NJ": "Edison, Secaucus, Atlantic City, Newark, Piscataway, Somerset, Parsippany, Meadowlands, East Rutherford",
    "NM": "Albuquerque, Santa Fe",
    "NY": "New York, Albany, Buffalo, Rochester, Syracuse, Queens, Brooklyn, Long Island, Uniondale",
    "NC": "Charlotte, Raleigh, Greensboro, Durham, Greenville NC, Winston-Salem, Fayetteville NC",
    "ND": "Fargo",
    "OH": "Columbus, Cleveland, Cincinnati, Dayton, Toledo, Akron, Newark OH, Sharonville",
    "OK": "Oklahoma City, Tulsa",
    "OR": "Portland, Eugene, Salem",
    "PA": "Philadelphia, Pittsburgh, Monroeville, Harrisburg, Allentown, Lancaster, Erie, King of Prussia",
    "RI": "Providence, Warwick",
    "SC": "Greenville, Charleston SC, Columbia SC, Myrtle Beach",
    "SD": "Sioux Falls",
    "TN": "Nashville, Memphis, Knoxville, Chattanooga, Murfreesboro",
    "TX": "Dallas, Fort Worth, Houston, San Antonio, Austin, Arlington, Mesquite, Irving, Grapevine, El Paso, "
          "Plano, Frisco, Corpus Christi, Lubbock, Round Rock, Waco",
    "UT": "Salt Lake City, Sandy, Provo, Ogden",
    "VT": "Burlington VT",
    "VA": "Richmond, Virginia Beach, Roanoke, Norfolk, Arlington VA, Chantilly, Hampton",
    "WA": "Seattle, Spokane, Tacoma, Bellevue, Everett, Puyallup, Vancouver WA",
    "WV": "Charleston WV, Huntington WV",
    "WI": "Milwaukee, Madison, Green Bay, Appleton, Oshkosh",
    "WY": "Cheyenne",
    "AB": "Calgary, Edmonton, Red Deer",
    "BC": "Vancouver, Victoria, Kelowna, Surrey, Abbotsford, Burnaby",
    "MB": "Winnipeg",
    "NB": "Moncton, Fredericton, Saint John",
    "NL": "St. John's",
    "NS": "Halifax",
    "ON": "Toronto, Ottawa, Mississauga, Niagara Falls, Hamilton, London, Kitchener, Waterloo, Markham, Brampton, "
          "Windsor, Vaughan, Concord, Oshawa, Barrie",
    "QC": "Montreal, Montréal, Quebec City, Quebec, Laval, Gatineau, Longueuil, Boucherville",
    "SK": "Saskatoon, Regina",
}

CITY_REGION: dict[str, str] = {}
# Names that more than one state or province has are written with a state suffix ('Portland ME') for the
# smaller city, so the plain name keeps the busier one.
for _region, _names in _CITY_REGION.items():
    for _name in _names.split(","):
        _name = _name.strip()
        if _name:
            CITY_REGION.setdefault(norm_text(_name), _region)
CITY_REGION["washington"] = "DC"
CITY_REGION["washington d c"] = "DC"


def city_and_region(text: str, hint: str | None = None) -> tuple[str, str] | None:
    """('Baltimore', 'MD') from 'Baltimore, MD', 'Baltimore, Maryland' or just 'Baltimore'. None when unknown.

    A trailing 'at Gen Con' style phrase is dropped. The hint is a state or province the caller already knows.
    """
    t = re.sub(r"\s+at\s+.+$", "", (text or "").strip(), flags=re.I)
    parts = [p.strip() for p in t.split(",") if p.strip()]
    if not parts:
        return None
    city = parts[0]
    if len(parts) > 1:
        code = region_code(parts[-1])
        if code:
            return city, code
    code = region_code(hint) if hint else None
    if code:
        return city, code
    code = CITY_REGION.get(norm_text(city))
    return (city, code) if code else None


def title_city(city: str) -> str:
    """'saint louis' style names keep their written case; all-lower or all-upper names are title-cased."""
    return city.title() if city == city.lower() or city == city.upper() else city
