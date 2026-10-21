// Buttons on a show page that need the browser: the calendar file and My shows.
import { buildCalendar, fileNameFor, type IcsShow } from '../lib/ics';
import type { ShowSnapshot } from '../lib/myshows';
import { withBase } from '../lib/urls';
import { downloadText, useMyShows } from './hooks';

interface Props {
  id: string;
  name: string;
  ics: IcsShow;
  snapshot: ShowSnapshot;
  deadline: string | null;
  tablePrice: number | null;
  tableLabel: string;
  /** the show is over, so a calendar entry is no use */
  past: boolean;
}

export default function ShowActions({ id, name, ics, snapshot, deadline, tablePrice, tableLabel, past }: Props) {
  const my = useMyShows();
  const tracked = my.ready && id in my.store.shows;

  function addToCalendar() {
    downloadText(fileNameFor(name, 'ics'), 'text/calendar;charset=utf-8', buildCalendar({ name, shows: [ics], now: new Date() }));
  }

  return (
    <div>
      <div class="big-actions">
        <button type="button" class="btn btn-primary" onClick={addToCalendar} disabled={past}>
          Add to calendar
        </button>
        <button
          type="button"
          class="btn"
          aria-pressed={tracked}
          onClick={() => (tracked ? my.remove(id) : my.add(id, snapshot, { deadline, tablePrice, tableType: tableLabel }))}
        >
          {tracked ? 'On My shows (tap to remove)' : 'Add to My shows'}
        </button>
        <a class="btn" href={withBase(`plan/?show=${encodeURIComponent(id)}`)}>
          Plan a trip from here
        </a>
      </div>
      {tracked && (
        <p class="notice notice-ok" role="status">
          Saved on this device. <a href={withBase('my-shows/')}>Open My shows</a> to track your application.
        </p>
      )}
      {my.saveFailed && (
        <p class="notice notice-warn" role="alert">
          This browser would not save the list. Private windows often block saving.
        </p>
      )}
    </div>
  );
}
