import { HttpError } from "./errors";

export type Kind = "setting" | "provider" | "secret";
export interface Mutation {
  kind: Kind;
  key: string;
  expectedRevision: number;
  deleted: boolean;
  value?: unknown;
}
export interface MutationRequest { epoch: string; operationId: string; mutations: Mutation[]; }

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_request", "Expected a JSON object");
  return value as Record<string, unknown>;
}
export function text(value: unknown, label: string, max = 128): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new HttpError(400, "invalid_request", `${label} must be non-empty text of at most ${max} characters`);
  }
  return value;
}
export function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new HttpError(400, "invalid_request", `${label} must be a non-negative safe integer`);
  return value;
}
export function parseMutations(value: unknown): MutationRequest {
  const body = object(value);
  const epoch = text(body.epoch, "epoch");
  const operationId = text(body.operationId, "operationId");
  if (!Array.isArray(body.mutations) || body.mutations.length < 1 || body.mutations.length > 100) throw new HttpError(400, "invalid_request", "Supply between 1 and 100 mutations");
  const keys = new Set<string>();
  const mutations = body.mutations.map((raw): Mutation => {
    const item = object(raw);
    if (item.kind !== "setting" && item.kind !== "provider" && item.kind !== "secret") throw new HttpError(400, "invalid_request", "Unknown record kind");
    const kind = item.kind;
    const key = text(item.key, "key", 256);
    const identity = `${kind}:${key}`;
    if (keys.has(identity)) throw new HttpError(400, "invalid_request", "A transaction cannot modify a record twice");
    keys.add(identity);
    const expectedRevision = integer(item.expectedRevision, "expectedRevision");
    if (item.deleted !== undefined && typeof item.deleted !== "boolean") throw new HttpError(400, "invalid_request", "deleted must be a boolean");
    const deleted = item.deleted === true;
    if (deleted && Object.hasOwn(item, "value")) throw new HttpError(400, "invalid_request", "A deletion cannot include a value");
    if (!deleted && !Object.hasOwn(item, "value")) throw new HttpError(400, "invalid_request", "A write requires a value");
    if (kind === "provider" && !deleted) object(item.value);
    return { kind, key, expectedRevision, deleted, ...(!deleted ? { value: item.value } : {}) };
  });
  return { epoch, operationId, mutations };
}

// Request fingerprints are independent of object-key order, including nested values.
export function canonical(value: unknown, depth = 0): string {
  if (depth > 64) throw new HttpError(400, "invalid_request", "JSON nesting exceeds 64 levels");
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(",")}]`;
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical(item[key], depth + 1)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
