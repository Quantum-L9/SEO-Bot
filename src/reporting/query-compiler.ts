/* L9_META
 * layer: module
 * role: seo_bot_engine
 * status: active
 */

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L9 SEO Bot - Reporting Query Compiler (ADR-0015)
 *
 * Compiles a `{ view, filters, orderBy, limit }` request into a single
 * parameterized SELECT against one registry-declared relation.
 *
 * Design rules, in order of importance:
 *   1. Every identifier (relation, column, ORDER BY fragment) comes from the
 *      registry. Caller input selects WHICH registry entry, never its text.
 *   2. Every caller-supplied VALUE becomes a bound parameter ($1, $2, …).
 *   3. Compilation is pure and synchronous — no database, no clock, no I/O — so
 *      the SQL a request produces is fully testable without Postgres.
 *   4. Unknown view, unknown filter, unknown order alias, or an out-of-range
 *      value is a rejection, never a silently-dropped clause.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { createHash } from "node:crypto";
import {
  type FilterSpec,
  getReportingView,
  type ReportingAudience,
  type ReportingViewDefinition,
} from "./views.js";

export interface ReportingQueryRequest {
  view: string;
  filters?: Record<string, unknown>;
  orderBy?: string;
  limit?: number;
}

export interface CompiledReportingQuery {
  /** Parameterized SQL using $1..$n placeholders. Also the audited/hashed form. */
  readonly text: string;
  readonly params: readonly unknown[];
  readonly columns: readonly string[];
  readonly view: string;
  readonly relation: string;
  readonly orderBy: string;
  readonly limit: number;
  /** Validated, normalized filter values — safe to persist in the audit row. */
  readonly appliedFilters: Readonly<Record<string, unknown>>;
  /** sha256 of `text`. Identifies the query SHAPE, never its parameter values. */
  readonly sqlHash: string;
}

/** Thrown for any request the registry does not permit. Maps to HTTP 400. */
export class ReportingQueryError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "ReportingQueryError";
  }
}

function requireFiniteNumber(filterName: string, raw: unknown): number {
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ReportingQueryError(`Filter "${filterName}" must be a finite number`);
  }
  return value;
}

function requireIntegerInRange(filterName: string, raw: unknown, min: number, max: number): number {
  const value = requireFiniteNumber(filterName, raw);
  if (!Number.isInteger(value)) {
    throw new ReportingQueryError(`Filter "${filterName}" must be an integer`);
  }
  if (value < min || value > max) {
    throw new ReportingQueryError(`Filter "${filterName}" must be between ${min} and ${max}`);
  }
  return value;
}

function requireNumberInRange(filterName: string, raw: unknown, min: number, max: number): number {
  const value = requireFiniteNumber(filterName, raw);
  if (value < min || value > max) {
    throw new ReportingQueryError(`Filter "${filterName}" must be between ${min} and ${max}`);
  }
  return value;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(filterName: string, raw: unknown): string {
  if (typeof raw !== "string" || !UUID_PATTERN.test(raw)) {
    throw new ReportingQueryError(`Filter "${filterName}" must be a UUID`);
  }
  return raw.toLowerCase();
}

function requireEnum(filterName: string, raw: unknown, values: readonly string[]): string {
  if (typeof raw !== "string" || !values.includes(raw)) {
    throw new ReportingQueryError(`Filter "${filterName}" must be one of: ${values.join(", ")}`);
  }
  return raw;
}

function requireEnumList(
  filterName: string,
  raw: unknown,
  values: readonly string[],
  maxSelected: number,
): string[] {
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) {
    throw new ReportingQueryError(`Filter "${filterName}" must select at least one value`);
  }
  if (list.length > maxSelected) {
    throw new ReportingQueryError(`Filter "${filterName}" accepts at most ${maxSelected} value(s)`);
  }
  const selected = list.map((entry) => requireEnum(filterName, entry, values));
  return [...new Set(selected)];
}

interface Predicate {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly applied: unknown;
}

function compilePredicate(
  filterName: string,
  spec: FilterSpec,
  raw: unknown,
  nextParamIndex: number,
): Predicate {
  switch (spec.kind) {
    case "uuid": {
      const value = requireUuid(filterName, raw);
      return {
        sql: `${spec.column} ${spec.operator} $${nextParamIndex}::uuid`,
        params: [value],
        applied: value,
      };
    }
    case "int": {
      const value = requireIntegerInRange(filterName, raw, spec.min, spec.max);
      return {
        sql: `${spec.column} ${spec.operator} $${nextParamIndex}::int`,
        params: [value],
        applied: value,
      };
    }
    case "number": {
      const value = requireNumberInRange(filterName, raw, spec.min, spec.max);
      return {
        sql: `${spec.column} ${spec.operator} $${nextParamIndex}::numeric`,
        params: [value],
        applied: value,
      };
    }
    case "enum": {
      const value = requireEnum(filterName, raw, spec.values);
      return {
        sql: `${spec.column} ${spec.operator} $${nextParamIndex}`,
        params: [value],
        applied: value,
      };
    }
    case "enumIn": {
      const values = requireEnumList(filterName, raw, spec.values, spec.maxSelected);
      const placeholders = values.map((_, offset) => `$${nextParamIndex + offset}`);
      return {
        sql: `${spec.column} IN (${placeholders.join(", ")})`,
        params: values,
        applied: values,
      };
    }
    case "recentDays": {
      const value = requireIntegerInRange(filterName, raw, spec.min, spec.max);
      return {
        sql: `${spec.column} >= now() - ($${nextParamIndex}::int * interval '1 day')`,
        params: [value],
        applied: value,
      };
    }
    default: {
      // Exhaustiveness guard: a new FilterSpec kind fails compilation, not silently.
      const exhaustive: never = spec;
      throw new ReportingQueryError(`Unsupported filter kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function resolveProjection(
  view: ReportingViewDefinition,
  audience: ReportingAudience,
): readonly string[] {
  const columns = view.projections[audience];
  if (!columns || columns.length === 0) {
    throw new ReportingQueryError(
      `View "${view.name}" is not available to the ${audience} audience`,
    );
  }
  return columns;
}

/**
 * Compile a request. Pure: no database, no clock, no environment.
 *
 * @throws {ReportingQueryError} for any unknown view/filter/order alias, any
 * value outside its declared range, and any view the audience may not reach.
 */
export function compileReportingQuery(
  request: ReportingQueryRequest,
  audience: ReportingAudience,
): CompiledReportingQuery {
  if (typeof request?.view !== "string" || request.view.length === 0) {
    throw new ReportingQueryError("A view name is required");
  }

  const view = getReportingView(request.view);
  if (!view) {
    throw new ReportingQueryError(`Unknown view "${request.view}"`);
  }

  const columns = resolveProjection(view, audience);

  const requestedFilters = request.filters ?? {};
  if (typeof requestedFilters !== "object" || Array.isArray(requestedFilters)) {
    throw new ReportingQueryError("filters must be an object");
  }

  const predicates: string[] = [];
  const params: unknown[] = [];
  const appliedFilters: Record<string, unknown> = {};

  // Iterate the REGISTRY, not the request, so filter order — and therefore the
  // compiled SQL and its hash — is deterministic regardless of key order in the
  // caller's JSON.
  for (const [filterName, spec] of Object.entries(view.filters)) {
    if (!Object.hasOwn(requestedFilters, filterName)) continue;
    const raw = requestedFilters[filterName];
    if (raw === undefined || raw === null) continue;
    const predicate = compilePredicate(filterName, spec, raw, params.length + 1);
    predicates.push(predicate.sql);
    params.push(...predicate.params);
    appliedFilters[filterName] = predicate.applied;
  }

  const unknownFilters = Object.keys(requestedFilters).filter(
    (name) => !Object.hasOwn(view.filters, name),
  );
  if (unknownFilters.length > 0) {
    throw new ReportingQueryError(
      `Unknown filter(s) for view "${view.name}": ${unknownFilters.join(", ")}. ` +
        `Available: ${Object.keys(view.filters).join(", ") || "none"}`,
    );
  }

  const orderAlias = request.orderBy ?? view.defaultOrderBy;
  const orderFragment = view.orderBy[orderAlias];
  if (!orderFragment) {
    throw new ReportingQueryError(
      `Unknown orderBy "${orderAlias}" for view "${view.name}". ` +
        `Available: ${Object.keys(view.orderBy).join(", ")}`,
    );
  }

  const limit =
    request.limit === undefined || request.limit === null
      ? view.defaultLimit
      : requireIntegerInRange("limit", request.limit, 1, view.maxLimit);

  const limitPlaceholder = `$${params.length + 1}`;
  params.push(limit);

  const where = predicates.length > 0 ? ` WHERE ${predicates.join(" AND ")}` : "";
  const text =
    `SELECT ${columns.join(", ")} FROM ${view.relation}${where} ` +
    `ORDER BY ${orderFragment} LIMIT ${limitPlaceholder}`;

  return {
    text,
    params,
    columns,
    view: view.name,
    relation: view.relation,
    orderBy: orderAlias,
    limit,
    appliedFilters,
    sqlHash: createHash("sha256").update(text).digest("hex"),
  };
}
