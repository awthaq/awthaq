// Plan 29 ticket 02 (ADR-EA-049): the type-level interface of plugin-owned events, pinned. Nothing here executes
// beyond building schemas: the assertions are the `@ts-expect-error` directives and the assignability constants,
// checked by `tsc -p tsconfig.test.json`. Stand-ins are local; ticket 04 points them at `EventDefinition`.
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as AuthEvents from "../src/AuthEvents.ts";
import { Actor, type Defined, defineEvent } from "../src/internal/eventDefinition.ts";
import { UserId } from "../src/Users.ts";

// ---- stand-ins for the new names (§3.2, §3.4, §3.5) ------------------------------------------
interface AnyEvent {
  readonly _tag: string;
}
/**
 * Finding (a)/(d): besides the two `never` service pins of §2.6.3, `Any` pins `Type` to `AnyEvent`. Without it
 * `TypeOf<Any>` is `unknown` (`Schema.Top`'s), and `Published<TypeOf<D>>` fails its `AnyEvent` constraint.
 */
type Any = Schema.Top &
  Defined & {
    readonly Type: AnyEvent;
    readonly EncodingServices: never;
    readonly DecodingServices: never;
  };
type TypeOf<D extends Any> = D["Type"];
type Input<D extends Any> = D["~type.make.in"];
type Published<E extends AnyEvent = AuthEvents.AuthEvent> = E & AuthEvents.EventMetadata;

/** Mutual assignability, so a mismatch in either direction is a compile error at the call. */
const same =
  <A>() =>
  <B extends A>(..._proof: [A] extends [B] ? [] : [never]) =>
    undefined;

const UserIdSchema = Schema.String.pipe(Schema.brand("UserId"));
const LocalDef = defineEvent(
  "auth.local.happened",
  { userId: UserIdSchema, note: Schema.String },
  { actor: Actor.field("userId"), pii: ["note"] },
);
const OtherDef = defineEvent(
  "auth.other.happened",
  { count: Schema.Number },
  { actor: Actor.none, pii: [] },
);

describe("plugin-owned event types (plan 29 §2.6)", () => {
  it("(a) Input leaves _tag optional and keeps brands; a generic emit compiles with no assertion", () => {
    const input: Input<typeof LocalDef> = { userId: UserId("u-1"), note: "n" };
    // @ts-expect-error a bare string is not a UserId
    const bare: Input<typeof LocalDef> = { userId: "u-1", note: "n" };
    void input;
    void bare;

    const emit = <D extends Any>(definition: D, input: Input<D>) =>
      Effect.flatMap(Effect.orDie(definition.makeEffect(input)), (event) =>
        Effect.asVoid(Effect.orDie(Schema.encodeUnknownEffect(definition)(event))),
      );
    // Generic body: the requirement channel is `D["EncodingServices"]`, pinned to `never` by `Any`.
    const emitted: Effect.Effect<void> = emit(LocalDef, { userId: UserId("u-1"), note: "n" });
    void emitted;
    // Finding: `_tag` is not omitted but optional (the `tag()` constructor default), so the right literal is accepted
    // and any other is refused; callers simply leave it out.
    const tagged = () =>
      emit(LocalDef, { _tag: "auth.local.happened", userId: UserId("u-1"), note: "n" });
    const mistagged = () =>
      // @ts-expect-error another event's tag is not this definition's
      emit(LocalDef, { _tag: "auth.other.happened", userId: UserId("u-1"), note: "n" });
    void tagged;
    void mistagged;
  });

  it("(b) Schema.Union accepts a ReadonlyArray<Any>", () => {
    const members: ReadonlyArray<Any> = [LocalDef, OtherDef];
    const union = Schema.Union(members);
    void union;
  });

  it("(c) an EventsOf-style fold over '~events'? gives a union that narrows by _tag", () => {
    interface PluginA {
      readonly id: "a";
      readonly "~events"?: ReadonlyArray<typeof LocalDef>;
    }
    interface PluginB {
      readonly id: "b";
      readonly "~events"?: ReadonlyArray<typeof OtherDef>;
    }
    type EventsOfPlugin<Plugin> = Plugin extends { readonly "~events"?: infer Events }
      ? NonNullable<Events> extends ReadonlyArray<infer D extends Any>
        ? TypeOf<D>
        : never
      : never;
    type EventsOf<P extends ReadonlyArray<unknown>> =
      | AuthEvents.AuthEvent
      | EventsOfPlugin<P[number]>;
    const read = (event: EventsOf<readonly [PluginA, PluginB]>) => {
      switch (event._tag) {
        case "auth.local.happened":
          return event.note;
        case "auth.other.happened":
          return String(event.count);
        case "auth.session.issued":
          return event.sessionId;
        default:
          return "";
      }
    };
    void read;
  });

  it("(d) Handled of a mixed selector is the union of a core event and a definition's", () => {
    type Selector = AuthEvents.AuthEventTag | Any;
    type Select = Selector | ReadonlyArray<Selector>;
    type One<S extends Select> = S extends ReadonlyArray<infer Item> ? Item : S;
    type EventOfSelector<S> = S extends AuthEvents.AuthEventTag
      ? AuthEvents.EventOf<S>
      : S extends Any
        ? TypeOf<S>
        : never;
    type Handled<S extends Select> = Published<EventOfSelector<One<S>>>;
    same<Handled<readonly ["auth.session.issued", typeof LocalDef]>>()<
      Published<AuthEvents.EventOf<"auth.session.issued"> | TypeOf<typeof LocalDef>>
    >();
    const read = (event: Handled<readonly ["auth.session.issued", typeof LocalDef]>) =>
      event._tag === "auth.local.happened" ? event.note : event.sessionId;
    void read;
  });

  it("(e) a fixed-literal ForeignEvent keeps narrowing; an open member destroys it", () => {
    const ForeignEvent = Schema.TaggedStruct("awthaq.foreignEvent", {
      tag: Schema.String,
      fields: Schema.Record(Schema.String, Schema.Unknown),
    });
    const narrows = (payload: AuthEvents.AuthEvent | typeof ForeignEvent.Type) =>
      payload._tag === "auth.session.issued" ? payload.sessionId : "";
    void narrows;
    // §2.6.1: one member with an open `_tag` makes the compiler stop treating the union as discriminated, so the bus
    // is typed open (`PublishedAny`) and narrowed by validating guards instead.
    const lost = (payload: AuthEvents.AuthEvent | { readonly _tag: string }) =>
      payload._tag === "auth.session.issued"
        ? // @ts-expect-error `sessionId` does not exist on the open member
          payload.sessionId
        : "";
    void lost;
  });

  it("(f) an implementation returning Registry<AnyEvent> under an overload declaring Registry<EventsOf<P>>", () => {
    interface Registry<E extends AnyEvent> {
      readonly tags: ReadonlyArray<E["_tag"]>;
      readonly is: (value: AnyEvent) => value is E;
    }
    interface Plugin {
      readonly "~events"?: ReadonlyArray<Any>;
    }
    type EventsOf<P extends ReadonlyArray<Plugin>> =
      | AuthEvents.AuthEvent
      | (P[number] extends { readonly "~events"?: infer Events }
          ? NonNullable<Events> extends ReadonlyArray<infer D extends Any>
            ? TypeOf<D>
            : never
          : never);
    function compose<const P extends ReadonlyArray<Plugin>>(plugins: P): Registry<EventsOf<P>>;
    function compose(plugins: ReadonlyArray<Plugin>): Registry<AnyEvent> {
      return {
        tags: plugins.map(() => "x"),
        is: (value): value is AnyEvent => value._tag.length > 0,
      };
    }
    void compose;
  });
});
