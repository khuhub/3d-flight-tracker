import type { HistoryIndex, SnapshotMessage } from '@flight/shared';

async function get<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(`/api/history${path}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  if (!response.ok) {
    if (response.status === 404) throw new Error('That time is no longer in flight history.');
    if (response.status === 503) throw new Error('Flight history is busy. Try again.');
    throw new Error('Could not load flight history.');
  }
  try {
    return await response.json() as T;
  } catch {
    throw new Error('Could not read flight history. Try again.');
  }
}

export const historyClient = {
  index: (signal: AbortSignal) => get<HistoryIndex>('', signal),
  seek: (generation: string, at: number, signal: AbortSignal) =>
    get<SnapshotMessage[]>(`/${generation}?at=${Math.floor(at)}`, signal),
  frame: (generation: string, sequence: number, signal: AbortSignal) =>
    get<SnapshotMessage>(`/${generation}/${sequence}`, signal),
};
