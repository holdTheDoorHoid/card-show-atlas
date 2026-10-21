// Settings that are expected to change over time live here, in one place.

export const SITE_NAME = 'Card Show Atlas';
export const SITE_ORIGIN = 'https://holdthedoorhoid.github.io';
/** Keep in step with `base` in astro.config.mjs. */
export const BASE_PATH = '/card-show-atlas';
export const GITHUB_REPO = 'holdTheDoorHoid/card-show-atlas';

/**
 * The public Google Form for adding a show without an account. Leave it empty until the owner has
 * created the form: every button that uses it is hidden while it is empty.
 */
export const GOOGLE_FORM_URL = '';

/**
 * Map tiles. One constant, so the tile source can be swapped in one edit. The default is the public
 * OpenStreetMap tile server: it needs the attribution below and light use only
 * (https://operations.osmfoundation.org/policies/tiles/). A busy site should switch to a tile
 * provider with an agreement.
 */
export const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
export const TILE_MAX_ZOOM = 19;

/** Where the map starts when nothing else says otherwise (middle of the lower 48). */
export const DEFAULT_MAP_CENTER: [number, number] = [39.5, -98.35];
export const DEFAULT_MAP_ZOOM = 4;

/** Shows are listed for this many days after today on the timeline. */
export const TIMELINE_DAYS = 365;
/** The longest time window on the map: about three months. */
export const MAX_WINDOW_DAYS = 92;

/** Distance slider limits, in the unit being shown. */
export const DISTANCE_MIN = 10;
export const DISTANCE_MAX_MI = 500;
export const DISTANCE_MAX_KM = 800;

/** A show whose last check is older than this many days gets a "may be out of date" note. */
export const STALE_AFTER_DAYS = 45;
