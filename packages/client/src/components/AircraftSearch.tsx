import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';
import type { MotionTrack } from '@flight/shared';
import { indexAircraft, searchAircraft } from '../data/aircraftSearch';
import './aircraftSearch.css';

interface Props {
  tracks: readonly MotionTrack[];
  followLabel: string | null;
  followPaused: boolean;
  onSelect: (icao24: string) => void;
}

export function AircraftSearch({ tracks, followLabel, followPaused, onSelect }: Props) {
  const id = useId();
  const listId = `${id}-results`;
  const optionId = (icao24: string) => `${listId}-${icao24}`;
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const index = useMemo(() => indexAircraft(tracks), [tracks]);
  const results = useMemo(() => searchAircraft(index, query), [index, query]);
  const hasQuery = query.trim() !== '';
  const expanded = open && results.length > 0;
  const activeIndex = expanded ? results.findIndex((result) => result.icao24 === activeId) : -1;
  const activeOptionId = activeIndex < 0 ? undefined : optionId(results[activeIndex]!.icao24);

  useEffect(() => {
    if (activeOptionId) document.getElementById(activeOptionId)?.scrollIntoView({ block: 'nearest' });
  }, [activeOptionId]);

  function close(): void {
    setOpen(false);
    setActiveId(null);
  }

  function select(icao24: string): void {
    onSelect(icao24);
    setQuery('');
    close();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      close();
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && results.length > 0) {
      event.preventDefault();
      setOpen(true);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = activeIndex < 0 ? (step > 0 ? 0 : results.length - 1) : activeIndex + step;
      setActiveId(results[(next + results.length) % results.length]!.icao24);
    } else if (event.key === 'Enter' && expanded) {
      event.preventDefault();
      select(results[Math.max(0, activeIndex)]!.icao24);
    }
  }

  return (
    <div className="aircraft-search">
      <input
        type="text"
        role="combobox"
        aria-label="Search aircraft by callsign or ICAO24"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        aria-activedescendant={activeOptionId}
        autoComplete="off"
        spellCheck={false}
        placeholder="Callsign or ICAO24"
        value={query}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={close}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveId(null);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />
      <div className="aircraft-search-follow" role="status">
        {followLabel && (followPaused ? `Follow paused · ${followLabel}` : `Following ${followLabel} · Drag to stop`)}
      </div>
      {expanded && (
        <ul className="aircraft-search-results" id={listId} role="listbox" aria-label="Matching aircraft">
          {results.map(({ icao24, callsign }, i) => (
            <li
              key={icao24}
              id={optionId(icao24)}
              role="option"
              aria-selected={i === activeIndex}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select(icao24)}
            >
              <span>{callsign ?? 'No callsign'}</span>
              <span className="aircraft-search-address">{icao24}</span>
            </li>
          ))}
        </ul>
      )}
      {open && hasQuery && results.length === 0 && (
        <div className="aircraft-search-results aircraft-search-empty" role="status">No matching aircraft</div>
      )}
    </div>
  );
}
