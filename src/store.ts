/** Verlauf der Box-Statistik (statistics.dnsQueryCount) in SQLite. */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface StatsSample {
  ts: number;
  total: number;
  blocked: number;
}

export interface StatsInterval {
  /** Ende des Intervalls (ms) */
  ts: number;
  total: number;
  blocked: number;
}

export class StatsStore {
  private db: Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, "whyblocked.sqlite"));
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("CREATE TABLE IF NOT EXISTS stats (ts INTEGER PRIMARY KEY, total INTEGER NOT NULL, blocked INTEGER NOT NULL)");
  }

  add(sample: StatsSample): void {
    this.db.query("INSERT OR REPLACE INTO stats (ts, total, blocked) VALUES (?, ?, ?)").run(sample.ts, sample.total, sample.blocked);
  }

  since(ts: number): StatsSample[] {
    return this.db.query("SELECT ts, total, blocked FROM stats WHERE ts >= ? ORDER BY ts").all(ts) as StatsSample[];
  }

  prune(olderThan: number): void {
    this.db.query("DELETE FROM stats WHERE ts < ?").run(olderThan);
  }
}

/**
 * Macht aus Zählerständen Anfragen pro Intervall. Die Box zählt fortlaufend;
 * fällt ein Zähler (Neustart, Tageswechsel), zählt der neue Stand als Intervallwert.
 */
export function toIntervals(samples: StatsSample[]): StatsInterval[] {
  const out: StatsInterval[] = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]!;
    const cur = samples[i]!;
    const reset = cur.total < prev.total || cur.blocked < prev.blocked;
    out.push({
      ts: cur.ts,
      total: reset ? cur.total : cur.total - prev.total,
      blocked: reset ? cur.blocked : cur.blocked - prev.blocked,
    });
  }
  return out;
}
