/** Times are in server wall-clock milliseconds, not the source observation's clock. */
export interface HistoryFrame {
  sequence: number;
  capturedAt: number;
  replayEpoch: number;
}

export interface HistoryIndex {
  /** Timeline identity, invalid after a server restart or a backwards server-clock jump. */
  generation: string;
  serverNow: number;
  frames: HistoryFrame[];
}
