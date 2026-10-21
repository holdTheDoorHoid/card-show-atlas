"""States, provinces, country names and simple bounding boxes.

The boxes are deliberately generous rectangles (roughly 0.1 degrees of slack). They catch a
marker that landed in the wrong state or the wrong hemisphere, not a marker that is a mile off.
Each box is (min_lat, min_lon, max_lat, max_lon).
"""

from __future__ import annotations

from .util import norm_text

US_STATES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California",
    "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware", "DC": "District of Columbia",
    "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois",
    "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana",
    "ME": "Maine", "MD": "Maryland", "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota",
    "MS": "Mississippi", "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada",
    "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
    "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon",
    "PA": "Pennsylvania", "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota",
    "TN": "Tennessee", "TX": "Texas", "UT": "Utah", "VT": "Vermont", "VA": "Virginia",
    "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
    "PR": "Puerto Rico", "VI": "U.S. Virgin Islands", "GU": "Guam", "AS": "American Samoa",
    "MP": "Northern Mariana Islands",
}

CA_PROVINCES = {
    "AB": "Alberta", "BC": "British Columbia", "MB": "Manitoba", "NB": "New Brunswick",
    "NL": "Newfoundland and Labrador", "NS": "Nova Scotia", "NT": "Northwest Territories",
    "NU": "Nunavut", "ON": "Ontario", "PE": "Prince Edward Island", "QC": "Quebec",
    "SK": "Saskatchewan", "YT": "Yukon",
}

REGION_COUNTRY = {**{c: "US" for c in US_STATES}, **{c: "CA" for c in CA_PROVINCES}}

_NAME_TO_CODE: dict[str, str] = {}
for _code, _name in {**US_STATES, **CA_PROVINCES}.items():
    _NAME_TO_CODE[norm_text(_name)] = _code
_NAME_TO_CODE.update({
    "washington dc": "DC", "washington d c": "DC", "dc": "DC",
    "newfoundland": "NL", "labrador": "NL", "pei": "PE", "prince edward island": "PE",
    "quebec": "QC", "québec": "QC", "virgin islands": "VI", "us virgin islands": "VI",
    "n b": "NB", "n s": "NS", "n l": "NL", "p e i": "PE", "b c": "BC", "p q": "QC",
    "penn": "PA", "penna": "PA", "calif": "CA", "mass": "MA", "conn": "CT", "fla": "FL",
    "ont": "ON", "que": "QC", "alta": "AB", "sask": "SK", "man": "MB",
})

COUNTRY_NAMES = {
    "us": "US", "usa": "US", "u s": "US", "u s a": "US", "united states": "US",
    "united states of america": "US", "america": "US",
    "ca": "CA", "can": "CA", "canada": "CA",
}

BOXES: dict[str, tuple[float, float, float, float]] = {
    "AL": (30.1, -88.5, 35.1, -84.8), "AK": (51.1, -179.3, 71.5, -129.9),
    "AZ": (31.3, -114.9, 37.1, -109.0), "AR": (32.9, -94.7, 36.6, -89.6),
    "CA": (32.4, -124.5, 42.1, -114.1), "CO": (36.9, -109.1, 41.1, -102.0),
    "CT": (40.9, -73.8, 42.1, -71.7), "DE": (38.4, -75.8, 39.9, -75.0),
    "DC": (38.7, -77.2, 39.0, -76.9), "FL": (24.3, -87.7, 31.1, -79.9),
    "GA": (30.3, -85.7, 35.1, -80.7), "HI": (18.8, -160.4, 22.4, -154.7),
    "ID": (41.9, -117.3, 49.1, -111.0), "IL": (36.9, -91.6, 42.6, -87.0),
    "IN": (37.7, -88.2, 41.8, -84.7), "IA": (40.3, -96.7, 43.6, -90.1),
    "KS": (36.9, -102.1, 40.1, -94.5), "KY": (36.4, -89.6, 39.2, -81.9),
    "LA": (28.8, -94.1, 33.1, -88.7), "ME": (42.9, -71.2, 47.5, -66.8),
    "MD": (37.8, -79.6, 39.8, -74.9), "MA": (41.1, -73.6, 42.9, -69.8),
    "MI": (41.6, -90.5, 48.4, -82.0), "MN": (43.4, -97.3, 49.5, -89.4),
    "MS": (30.1, -91.7, 35.1, -88.0), "MO": (35.9, -95.8, 40.7, -89.0),
    "MT": (44.3, -116.1, 49.1, -103.9), "NE": (39.9, -104.1, 43.1, -95.2),
    "NV": (34.9, -120.1, 42.1, -114.0), "NH": (42.6, -72.6, 45.4, -70.6),
    "NJ": (38.8, -75.6, 41.4, -73.8), "NM": (31.2, -109.1, 37.1, -102.9),
    "NY": (40.4, -79.8, 45.1, -71.7), "NC": (33.7, -84.4, 36.7, -75.3),
    "ND": (45.8, -104.1, 49.1, -96.5), "OH": (38.3, -84.9, 42.1, -80.4),
    "OK": (33.5, -103.1, 37.1, -94.3), "OR": (41.9, -124.7, 46.4, -116.4),
    "PA": (39.6, -80.6, 42.3, -74.6), "RI": (41.0, -71.9, 42.1, -71.0),
    "SC": (31.9, -83.4, 35.3, -78.4), "SD": (42.4, -104.1, 46.0, -96.3),
    "TN": (34.9, -90.4, 36.7, -81.6), "TX": (25.7, -106.7, 36.6, -93.4),
    "UT": (36.9, -114.1, 42.1, -109.0), "VT": (42.7, -73.5, 45.1, -71.4),
    "VA": (36.4, -83.7, 39.5, -75.1), "WA": (45.4, -124.9, 49.1, -116.8),
    "WV": (37.1, -82.7, 40.7, -77.6), "WI": (42.4, -92.9, 47.4, -86.2),
    "WY": (40.9, -111.1, 45.1, -104.0),
    "PR": (17.8, -68.0, 18.6, -65.1), "VI": (17.6, -65.2, 18.5, -64.5), "GU": (13.1, 144.5, 13.8, 145.1),
    "AB": (48.9, -120.1, 60.1, -109.9), "BC": (48.1, -139.2, 60.1, -113.9),
    "MB": (48.9, -102.1, 60.1, -88.8), "NB": (44.4, -69.2, 48.2, -63.6),
    "NL": (46.5, -67.9, 60.5, -52.5), "NS": (43.3, -66.6, 47.1, -59.5),
    "NT": (59.9, -136.6, 78.9, -101.9), "NU": (51.4, -120.8, 83.3, -61.0),
    "ON": (41.6, -95.3, 57.0, -74.2), "PE": (45.8, -64.6, 47.2, -61.8),
    "QC": (44.9, -79.9, 62.7, -57.0), "SK": (48.9, -110.1, 60.1, -101.3),
    "YT": (59.9, -141.2, 69.8, -123.7),
}

# A second box for Alaska's Aleutian islands, which cross the 180th meridian.
EXTRA_BOXES: dict[str, list[tuple[float, float, float, float]]] = {
    "AK": [(51.0, 172.0, 53.5, 180.0)],
}

COUNTRY_BOXES = {
    "US": [(17.8, -179.4, 71.6, -64.4), (51.0, 172.0, 53.5, 180.0), (13.1, 144.5, 13.8, 145.1)],
    "CA": [(41.6, -141.2, 83.3, -52.5)],
}


def region_code(value: str | None) -> str | None:
    """Return a two letter state or province code for a code or a name, or None."""
    if not value:
        return None
    text = str(value).strip().rstrip(".")
    up = text.upper()
    if up in REGION_COUNTRY:
        return up
    return _NAME_TO_CODE.get(norm_text(text))


def country_code(value: str | None) -> str | None:
    if not value:
        return None
    return COUNTRY_NAMES.get(norm_text(value))


def country_of_region(code: str | None) -> str | None:
    return REGION_COUNTRY.get(code or "")


def in_region(lat: float, lon: float, region: str, margin: float = 0.1) -> bool | None:
    """True or False, or None when the region has no box."""
    boxes = []
    if region in BOXES:
        boxes.append(BOXES[region])
        boxes.extend(EXTRA_BOXES.get(region, []))
    if not boxes:
        return None
    for (a, b, c, d) in boxes:
        if a - margin <= lat <= c + margin and b - margin <= lon <= d + margin:
            return True
    return False


def in_country(lat: float, lon: float, country: str) -> bool | None:
    boxes = COUNTRY_BOXES.get(country)
    if not boxes:
        return None
    return any(a <= lat <= c and b <= lon <= d for (a, b, c, d) in boxes)
