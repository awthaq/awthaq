// P20a: reading a wire response without a type assertion. A response body is untrusted
// `unknown` to a step; these narrow it the way a client would, and fail the scenario loudly
// (rather than reading `undefined`) when the shape is not what the step is about to assert on.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** A response drained once, so several Thens can read it (a `Response` body is single-use). */
export interface Snapshot {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
}

export const snapshot = (response: Response) =>
  Effect.promise(async () => ({
    status: response.status,
    headers: response.headers,
    text: await response.text(),
  }));

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parseJson = (text: string): unknown => decodeJson(text);

export const jsonOf = (response: Snapshot): unknown => parseJson(response.text);

/** The body as a JSON object; anything else fails the step. */
export const objectOf = (response: Snapshot): Readonly<Record<string, unknown>> => {
  const body = jsonOf(response);
  if (!isRecord(body)) throw new Error(`expected a JSON object body, got: ${response.text}`);
  return body;
};

/** The body as a JSON array of objects; anything else fails the step. */
export const objectsOf = (response: Snapshot): ReadonlyArray<Readonly<Record<string, unknown>>> => {
  const body = jsonOf(response);
  if (!Array.isArray(body)) throw new Error(`expected a JSON array body, got: ${response.text}`);
  return body.map((entry) => {
    if (!isRecord(entry)) throw new Error(`expected an array of objects, got: ${response.text}`);
    return entry;
  });
};

export const stringField = (record: Readonly<Record<string, unknown>>, key: string): string => {
  const value = record[key];
  if (typeof value !== "string")
    throw new Error(`expected "${key}" to be a string, got ${String(value)}`);
  return value;
};
