import { formatRowDate } from '../lib/dates';
import type { Result } from '../lib/filters';
import type { DistanceUnit } from '../lib/geo';
import { isApproximate, precisionNote, SHOW_STATUS_LABEL } from '../lib/labels';
import { distanceText, entryText, vendorNote } from '../lib/rowtext';
import { snapshotFromRow } from '../lib/myshows';
import type { Vocab } from '../lib/types';
import { showPath, withBase } from '../lib/urls';
import type { MyShowsApi } from './hooks';
import { SellsChips, SizeBadge, TypeBadge } from './ui';

interface Props {
  results: Result[];
  vocab: Vocab;
  unit: DistanceUnit;
  my: MyShowsApi;
}

export function ResultsList({ results, vocab, unit, my }: Props) {
  return (
    <ul class="result-list">
      {results.map(({ row, miles, minutes }) => {
        const tracked = row.i in my.store.shows;
        const dist = distanceText(miles, minutes, unit);
        const vendor = vendorNote(row);
        const note = isApproximate(row.g) ? precisionNote(row.g ?? 'city') : null;
        return (
          <li class="result" key={row.i}>
            <div class="result-top">
              <span class="result-date">{formatRowDate(row.d, row.e ?? row.d, new Date().getFullYear())}</span>
              {dist && <span class="result-dist">{dist}</span>}
            </div>
            <h3 class="result-name">
              <a href={withBase(showPath(row.i))}>{row.n}</a>
            </h3>
            <div class="result-meta">
              <span>
                {row.c}, {row.r}
              </span>
              <span class="badges">
                <TypeBadge type={row.t} />
                <SizeBadge size={row.sz} />
                {row.st && row.st !== 'scheduled' && <span class="badge badge-warn">{SHOW_STATUS_LABEL[row.st]}</span>}
                {row.vf === 'o' && <span class="badge badge-ok">Confirmed by organizer</span>}
              </span>
            </div>
            <SellsChips ids={row.sl} vocab={vocab} />
            <div class="result-meta">
              <span>{entryText(row)}</span>
              {vendor && <span class="result-vendor">{vendor}</span>}
              {note && <span>{note}</span>}
            </div>
            <div class="result-actions">
              <button
                type="button"
                class="btn btn-small"
                aria-pressed={tracked}
                aria-label={tracked ? `${row.n} is on My shows. Remove it.` : `Add ${row.n} to My shows`}
                onClick={() => (tracked ? my.remove(row.i) : my.add(row.i, snapshotFromRow(row), { deadline: row.vd ?? null }))}
              >
                {tracked ? 'On My shows' : 'Add to My shows'}
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
