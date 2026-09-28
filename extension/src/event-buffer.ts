import type { StreamBatch, StreamEntry, StreamReadOptions } from '../../src/protocol.js';

/** Bounded by both entry count and serialized size, never silently drops history. */
export class EventBuffer {
  readonly generation = crypto.randomUUID();
  private seq = 0;
  private listeners = new Set<(entry: StreamEntry) => void>();
  subscribe(listener: (entry: StreamEntry) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private entries: StreamEntry[] = [];
  private bytes = 0;
  private sizes: number[] = [];
  constructor(private readonly capacity = 500) {}
  cursor(): string { return `${this.generation}:${this.seq}`; }
  push(value: Omit<StreamEntry, 'seq' | 'timestamp'>): void {
    let entry: StreamEntry = { ...value, seq: ++this.seq, timestamp: new Date().toISOString() };
    let size = JSON.stringify(entry).length;
    if (size > 16_000) {
      entry = { seq: entry.seq, timestamp: entry.timestamp, event: entry.event, level: entry.level,
        message: JSON.stringify(value).slice(0, 12_000), truncated: true };
      size = JSON.stringify(entry).length;
    }
    for (const listener of this.listeners) listener(entry);
    this.entries.push(entry); this.sizes.push(size); this.bytes += size;
    while (this.entries.length > this.capacity || this.bytes > 200_000) {
      this.entries.shift(); this.bytes -= this.sizes.shift()!;
    }
  }
  read(opts: StreamReadOptions = {}): StreamBatch {
    const match = opts.cursor?.match(/^(.+):(\d+)$/);
    if (opts.cursor && !match) throw Object.assign(new Error('Invalid stream cursor'), { code: 'invalid_cursor' });
    const reset = Boolean(match && match[1] !== this.generation);
    const after = match && !reset ? Number(match[2]) : 0;
    if (after > this.seq) throw Object.assign(new Error('Stream cursor is ahead of this buffer'), { code: 'invalid_cursor' });
    const first = this.entries[0]?.seq ?? this.seq + 1;
    const dropped = Math.max(0, first - after - 1);
    const limit = opts.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw Object.assign(new Error('limit must be an integer from 1 to 500'), { code: 'invalid_args' });
    const matching = this.entries.filter(e => e.seq > after &&
      (!opts.levels?.length || opts.levels.includes(e.level ?? '')) &&
      (!opts.filter || JSON.stringify(e).includes(opts.filter)));
    const entries = matching.slice(0, limit);
    const hasMore = matching.length > limit;
    // Advance over filtered-out entries too, so an empty poll still makes progress.
    const sequence = hasMore ? entries.at(-1)!.seq : this.seq;
    return { entries, cursor: `${this.generation}:${sequence}`, hasMore, dropped, reset };
  }
}
