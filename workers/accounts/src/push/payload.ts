// What a notification may say. The relay and the push service see this, so it is
// a type code and a count and nothing else: no session name, tool, path, prompt
// or model text can reach it, because there is no field to carry one.
export const PUSH_TYPES = ["approval", "input", "error"] as const;
export type PushType = (typeof PUSH_TYPES)[number];

export const MAX_PUSH_COUNT = 99;

export interface PushPayload {
  v: 1;
  type: PushType;
  count: number;
}

export function pushPayload(type: PushType, count: number): PushPayload {
  const clamped = Number.isFinite(count) ? Math.min(MAX_PUSH_COUNT, Math.max(1, Math.trunc(count))) : 1;
  return { v: 1, type, count: clamped };
}

export function encodePayload(payload: PushPayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ v: payload.v, type: payload.type, count: payload.count }));
}

export function isPushType(value: unknown): value is PushType {
  return typeof value === "string" && (PUSH_TYPES as readonly string[]).includes(value);
}
