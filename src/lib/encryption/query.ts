export type Row = Record<string, unknown>;

function object(value: unknown): value is Row { return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date); }
function scalar(value: unknown): unknown { return value instanceof Date ? value.getTime() : value; }
function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) return scalar(a) === scalar(b);
  if (object(a) || Array.isArray(a)) return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

function matchValue(actual: unknown, condition: unknown): boolean {
  if (!object(condition)) return same(actual, condition);
  const insensitive = condition.mode === "insensitive";
  const normalized = (value: unknown) => insensitive && typeof value === "string" ? value.toLocaleLowerCase() : scalar(value);
  const current = normalized(actual);
  const compare = (value: unknown, predicate: (left: string | number, right: string | number) => boolean) => {
    const expected = normalized(value);
    return current !== null && current !== undefined && (typeof current === "string" || typeof current === "number")
      && (typeof expected === "string" || typeof expected === "number") && predicate(current, expected);
  };
  const known = new Set(["equals", "in", "notIn", "lt", "lte", "gt", "gte", "not", "contains", "startsWith", "endsWith", "mode", "has", "hasSome", "hasEvery", "isEmpty", "is", "isNot", "some", "every", "none", "path", "array_contains"]);
  if (Object.keys(condition).some((key) => !known.has(key))) {
    if (object(actual)) return matchesWhere(actual, condition);
    throw new Error("Unsupported encrypted predicate");
  }
  for (const [operator, expected] of Object.entries(condition)) {
    if (expected === undefined || operator === "mode") continue;
    switch (operator) {
      case "equals": if (!same(normalized(actual), normalized(expected))) return false; break;
      case "in": if (!Array.isArray(expected) || !expected.some((value) => same(normalized(actual), normalized(value)))) return false; break;
      case "notIn": if (!Array.isArray(expected) || expected.some((value) => same(normalized(actual), normalized(value)))) return false; break;
      case "lt": if (!compare(expected, (a, b) => a < b)) return false; break;
      case "lte": if (!compare(expected, (a, b) => a <= b)) return false; break;
      case "gt": if (!compare(expected, (a, b) => a > b)) return false; break;
      case "gte": if (!compare(expected, (a, b) => a >= b)) return false; break;
      case "not": if (matchValue(actual, expected)) return false; break;
      case "contains": if (typeof current !== "string" || typeof normalized(expected) !== "string" || !current.includes(normalized(expected) as string)) return false; break;
      case "startsWith": if (typeof current !== "string" || typeof normalized(expected) !== "string" || !current.startsWith(normalized(expected) as string)) return false; break;
      case "endsWith": if (typeof current !== "string" || typeof normalized(expected) !== "string" || !current.endsWith(normalized(expected) as string)) return false; break;
      case "has": if (!Array.isArray(actual) || !actual.some((value) => same(value, expected))) return false; break;
      case "hasSome": if (!Array.isArray(actual) || !Array.isArray(expected) || !actual.some((value) => expected.some((item) => same(value, item)))) return false; break;
      case "hasEvery": if (!Array.isArray(actual) || !Array.isArray(expected) || !expected.every((value) => actual.some((item) => same(value, item)))) return false; break;
      case "isEmpty": if (!Array.isArray(actual) || (actual.length === 0) !== expected) return false; break;
      case "is": if (expected === null ? actual !== null : !object(actual) || !matchesWhere(actual, expected as Row)) return false; break;
      case "isNot": if (expected === null ? actual === null : object(actual) && matchesWhere(actual, expected as Row)) return false; break;
      case "some": if (!Array.isArray(actual) || !actual.some((item) => object(item) && matchesWhere(item, expected as Row))) return false; break;
      case "every": if (!Array.isArray(actual) || !actual.every((item) => object(item) && matchesWhere(item, expected as Row))) return false; break;
      case "none": if (!Array.isArray(actual) || actual.some((item) => object(item) && matchesWhere(item, expected as Row))) return false; break;
      default: throw new Error("Unsupported encrypted predicate");
    }
  }
  return true;
}

export function matchesWhere(row: Row, where: Row = {}): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (condition === undefined) continue;
    if (key === "AND" || key === "OR" || key === "NOT") {
      const terms = Array.isArray(condition) ? condition : [condition];
      if (!terms.every(object)) throw new Error("Unsupported encrypted predicate");
      if (key === "AND" && !terms.every((term) => matchesWhere(row, term))) return false;
      if (key === "OR" && !terms.some((term) => matchesWhere(row, term))) return false;
      if (key === "NOT" && !terms.every((term) => !matchesWhere(row, term))) return false;
    } else if (!(key in row) && object(condition) && Object.keys(condition).every((part) => part in row)) {
      if (!matchesWhere(row, condition)) return false;
    } else {
      if (!(key in row)) throw new Error("Unsupported encrypted field");
      if (!matchValue(row[key], condition)) return false;
    }
  }
  return true;
}

function compareOrder(a: Row, b: Row, order: Row): number {
  for (const [key, direction] of Object.entries(order)) {
    if (object(direction) && !("sort" in direction)) {
      const difference = compareOrder((a[key] ?? {}) as Row, (b[key] ?? {}) as Row, direction);
      if (difference) return difference;
      continue;
    }
    const sort = object(direction) ? direction.sort : direction;
    if (sort !== "asc" && sort !== "desc") throw new Error("Unsupported encrypted order");
    const left = scalar(a[key]), right = scalar(b[key]);
    if (same(left, right)) continue;
    const nulls = object(direction) ? direction.nulls : undefined;
    const nullFirst = nulls === "first" || (nulls === undefined && sort === "desc");
    if (left === null || left === undefined) return nullFirst ? -1 : 1;
    if (right === null || right === undefined) return nullFirst ? 1 : -1;
    if ((typeof left !== "string" && typeof left !== "number" && typeof left !== "boolean") || (typeof right !== "string" && typeof right !== "number" && typeof right !== "boolean")) throw new Error("Unsupported encrypted order");
    return (left < right ? -1 : 1) * (sort === "asc" ? 1 : -1);
  }
  return 0;
}

export function orderRows<T extends Row>(rows: T[], orderBy?: Row | Row[]): T[] {
  if (!orderBy) return rows;
  const orders = Array.isArray(orderBy) ? orderBy : [orderBy];
  return rows.sort((a, b) => {
    for (const order of orders) { const difference = compareOrder(a, b, order); if (difference) return difference; }
    return 0;
  });
}

export function aggregateRows(rows: Row[], selection: Row): Row {
  const output: Row = {};
  for (const kind of ["_count", "_sum", "_min", "_max", "_avg"]) {
    const requested = selection[kind];
    if (!requested) continue;
    if (kind === "_count" && requested === true) { output[kind] = rows.length; continue; }
    const fields = requested as Row;
    const values: Row = {};
    for (const field of Object.keys(fields)) {
      const present = rows.map((row) => row[field]).filter((value) => value !== null && value !== undefined);
      if (kind === "_count") values[field] = field === "_all" ? rows.length : present.length;
      else if (!present.length) values[field] = null;
      else if (kind === "_min" || kind === "_max") values[field] = orderRows(present.map((value) => ({ value })), { value: kind === "_min" ? "asc" : "desc" })[0].value;
      else {
        if (present.some((value) => typeof value !== "number")) throw new Error("Invalid encrypted aggregate");
        const sum = (present as number[]).reduce((total, value) => total + value, 0);
        if (!Number.isSafeInteger(sum)) throw new Error("Encrypted aggregate exceeds integer capacity");
        values[field] = kind === "_avg" ? sum / present.length : sum;
      }
    }
    output[kind] = values;
  }
  return output;
}

export function groupRows(rows: Row[], args: Row): Row[] {
  const by = args.by as string[];
  if (!Array.isArray(by) || !by.length) throw new Error("Invalid encrypted group");
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = JSON.stringify(by.map((field) => scalar(row[field])));
    const group = groups.get(key) ?? [];
    group.push(row); groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({ ...Object.fromEntries(by.map((field) => [field, group[0][field]])), ...aggregateRows(group, args) }));
}
