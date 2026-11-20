/* L9_META
 * layer: module
 * role: build_intelligence_spend
 * status: active
 *
 * Period-scoped reservations for direct DeepSeek calls. Ceilings are the
 * daemon's existing budget configuration. A non-positive DAILY_SPEND_CAP is
 * disabled, the same rule as LlmService.enforceDailyCap. Totals are summed
 * from dated entries on disk, so a week or month rolls over and a restart
 * still sees the open period.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface DirectSpendCeilings {
  monthlyUsd: number;
  weeklyUsd: number;
  globalMonthlyUsd: number;
  dailyUsd?: number;
}

export type SpendScope = "month" | "week" | "global" | "day";

interface SpendEntry {
  clientId: string;
  buildId: string;
  usd: number;
  at: string;
}

const LEDGER_FILE = "spend-ledger.json";

export function defaultSpendLedgerDir(): string {
  return path.join(process.cwd(), ".l9", "build-intelligence");
}

export function clearSpendLedger(dir = defaultSpendLedgerDir()): void {
  try {
    unlinkSync(path.join(dir, LEDGER_FILE));
  } catch {
    // Absent is already clear.
  }
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}

/** ISO week in UTC, the calendar the ceiling names (weekly, monthly) use. */
export function isoWeekKey(date: Date): string {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function activeDailyCap(dailyUsd: number | undefined): number | undefined {
  if (dailyUsd === undefined || !Number.isFinite(dailyUsd) || dailyUsd <= 0) return undefined;
  return dailyUsd;
}

function isEntry(value: unknown): value is SpendEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as SpendEntry;
  return (
    typeof entry.clientId === "string" &&
    typeof entry.buildId === "string" &&
    typeof entry.usd === "number" &&
    Number.isFinite(entry.usd) &&
    entry.usd >= 0 &&
    typeof entry.at === "string" &&
    !Number.isNaN(new Date(entry.at).getTime())
  );
}

function readEntries(file: string): SpendEntry[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw new Error("Direct spend ledger is unreadable");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Direct spend ledger is unreadable");
  }
  const entries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entries) || !entries.every(isEntry)) {
    throw new Error("Direct spend ledger is unreadable");
  }
  return entries;
}

function relevant(entry: SpendEntry, now: Date): boolean {
  const at = new Date(entry.at);
  return (
    dayKey(at) === dayKey(now) ||
    isoWeekKey(at) === isoWeekKey(now) ||
    monthKey(at) === monthKey(now)
  );
}

interface PeriodTotals {
  monthly: number;
  weekly: number;
  global: number;
  daily: number;
}

function addToPeriod(
  totals: PeriodTotals,
  entry: SpendEntry,
  clientId: string,
  month: string,
  week: string,
  day: string,
): void {
  const at = new Date(entry.at);
  if (monthKey(at) === month) {
    totals.global += entry.usd;
    if (entry.clientId === clientId) totals.monthly += entry.usd;
  }
  if (entry.clientId !== clientId) return;
  if (isoWeekKey(at) === week) totals.weekly += entry.usd;
  if (dayKey(at) === day) totals.daily += entry.usd;
}

function refusedScope(
  totals: PeriodTotals,
  next: number,
  ceilings: DirectSpendCeilings,
): SpendScope | undefined {
  if (totals.monthly + next > ceilings.monthlyUsd + 1e-12) return "month";
  if (totals.weekly + next > ceilings.weeklyUsd + 1e-12) return "week";
  if (totals.global + next > ceilings.globalMonthlyUsd + 1e-12) return "global";
  const dailyCap = activeDailyCap(ceilings.dailyUsd);
  if (dailyCap !== undefined && totals.daily + next > dailyCap + 1e-12) return "day";
  return undefined;
}

/**
 * Admit and persist one reservation. Returns the ceiling that refused it, or
 * undefined after the entry is durable. Refusal writes nothing.
 */
export function reserveDirectSpend(input: {
  dir: string;
  clientId: string;
  buildId: string;
  usd: number;
  ceilings: DirectSpendCeilings;
  now: Date;
}): SpendScope | undefined {
  const file = path.join(input.dir, LEDGER_FILE);
  const entries = readEntries(file).filter((entry) => relevant(entry, input.now));
  const month = monthKey(input.now);
  const week = isoWeekKey(input.now);
  const day = dayKey(input.now);
  const totals: PeriodTotals = { monthly: 0, weekly: 0, global: 0, daily: 0 };
  for (const entry of entries) {
    addToPeriod(totals, entry, input.clientId, month, week, day);
  }
  const scope = refusedScope(totals, input.usd, input.ceilings);
  if (scope) return scope;
  entries.push({
    clientId: input.clientId,
    buildId: input.buildId,
    usd: input.usd,
    at: input.now.toISOString(),
  });
  mkdirSync(input.dir, { recursive: true });
  const tmp = path.join(input.dir, `.${LEDGER_FILE}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify({ entries }));
  renameSync(tmp, file);
  return undefined;
}
