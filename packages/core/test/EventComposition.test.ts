// ADR-EA-049 (plan 29 ticket 07): a plugin declares the events it publishes on its class (`events`), and
// `Auth.make` composes them with core's into `Built.events`, lists them in `manifest.events`, provides them
// through `Built.eventsLayer`, and refuses a tag declared twice (core's included) with `Auth/EventTagConflict`.
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Persistence from "../src/Persistence.ts";
import * as AuditLog from "../src/AuditLog.ts";
import * as Auth from "../src/Auth.ts";
import * as AuthEvents from "../src/AuthEvents.ts";
import * as AuthPlugin from "../src/AuthPlugin.ts";
import * as EventDefinition from "../src/EventDefinition.ts";
import * as Users from "../src/Users.ts";

const userId = Users.UserId("11111111-1111-1111-1111-111111111111");

// ---- two stand-in plugins, each publishing its own events ------------------------------------

const NotesCreatedEvent = EventDefinition.define(
  "auth.notes.created",
  { userId: EventDefinition.UserId, noteId: Schema.String },
  { actor: EventDefinition.Actor.field("userId"), pii: [] },
);
const NotesFlaggedEvent = EventDefinition.define(
  "auth.notes.flagged",
  { userId: EventDefinition.UserId, reason: Schema.String },
  { actor: EventDefinition.Actor.none, pii: ["reason"], attempt: true },
);
const TasksDoneEvent = EventDefinition.define(
  "auth.tasks.done",
  { taskId: Schema.String },
  { actor: EventDefinition.Actor.none, pii: [] },
);

const contract = <const G extends string>(group: G) =>
  HttpApi.make("auth").add(
    HttpApiGroup.make(group).add(
      HttpApiEndpoint.get(group, `/${group}`, { success: Schema.String }),
    ),
  );

const NotesApi = contract("notes");
class Notes extends AuthPlugin.Service<Notes, { readonly ok: true }>()("notes", {
  apiVersion: 1,
  contract: NotesApi,
  events: [NotesCreatedEvent, NotesFlaggedEvent],
}) {
  static readonly layer = AuthPlugin.layer(Notes, {
    make: Effect.succeed<{ readonly ok: true }>({ ok: true }),
    handlers: HttpApiBuilder.group(NotesApi, "notes", (handlers) =>
      handlers.handle("notes", () => Effect.succeed("notes")),
    ),
  });
}

const TasksApi = contract("tasks");
class Tasks extends AuthPlugin.Service<Tasks, { readonly ok: true }>()("tasks", {
  apiVersion: 1,
  contract: TasksApi,
  events: [TasksDoneEvent],
}) {
  static readonly layer = AuthPlugin.layer(Tasks, {
    make: Effect.succeed<{ readonly ok: true }>({ ok: true }),
    handlers: HttpApiBuilder.group(TasksApi, "tasks", (handlers) =>
      handlers.handle("tasks", () => Effect.succeed("tasks")),
    ),
  });
}

/** Stand-ins that each declare whatever `events` they are given, under their own id. */
const DupEvent = EventDefinition.define(
  "auth.dup.happened",
  {},
  { actor: EventDefinition.Actor.none, pii: [] },
);
const ReservedEvent = EventDefinition.define(
  "awthaq.foreignEvent",
  {},
  { actor: EventDefinition.Actor.none, pii: [] },
);

const FirstApi = contract("first");
class First extends AuthPlugin.Service<First, { readonly ok: true }>()("first", {
  apiVersion: 1,
  contract: FirstApi,
  events: [DupEvent],
}) {
  static readonly layer = AuthPlugin.layer(First, {
    make: Effect.succeed<{ readonly ok: true }>({ ok: true }),
    handlers: HttpApiBuilder.group(FirstApi, "first", (handlers) =>
      handlers.handle("first", () => Effect.succeed("first")),
    ),
  });
}

const SecondApi = contract("second");
class Second extends AuthPlugin.Service<Second, { readonly ok: true }>()("second", {
  apiVersion: 1,
  contract: SecondApi,
  events: [DupEvent],
}) {
  static readonly layer = AuthPlugin.layer(Second, {
    make: Effect.succeed<{ readonly ok: true }>({ ok: true }),
    handlers: HttpApiBuilder.group(SecondApi, "second", (handlers) =>
      handlers.handle("second", () => Effect.succeed("second")),
    ),
  });
}

const ThiefApi = contract("thief");
class Thief extends AuthPlugin.Service<Thief, { readonly ok: true }>()("thief", {
  apiVersion: 1,
  contract: ThiefApi,
  events: [AuthEvents.UserCreatedEvent],
}) {
  static readonly layer = AuthPlugin.layer(Thief, {
    make: Effect.succeed<{ readonly ok: true }>({ ok: true }),
    handlers: HttpApiBuilder.group(ThiefApi, "thief", (handlers) =>
      handlers.handle("thief", () => Effect.succeed("thief")),
    ),
  });
}

const SquatterApi = contract("squatter");
class Squatter extends AuthPlugin.Service<Squatter, { readonly ok: true }>()("squatter", {
  apiVersion: 1,
  contract: SquatterApi,
  events: [ReservedEvent],
}) {
  static readonly layer = AuthPlugin.layer(Squatter, {
    make: Effect.succeed<{ readonly ok: true }>({ ok: true }),
    handlers: HttpApiBuilder.group(SquatterApi, "squatter", (handlers) =>
      handlers.handle("squatter", () => Effect.succeed("squatter")),
    ),
  });
}

const QuietApi = contract("quiet");
class Quiet extends AuthPlugin.Service<Quiet, { readonly ok: true }>()("quiet", {
  apiVersion: 1,
  contract: QuietApi,
}) {
  static readonly layer = AuthPlugin.layer(Quiet, {
    make: Effect.succeed<{ readonly ok: true }>({ ok: true }),
    handlers: HttpApiBuilder.group(QuietApi, "quiet", (handlers) =>
      handlers.handle("quiet", () => Effect.succeed("quiet")),
    ),
  });
}

const conflictOf = (make: () => unknown) => {
  try {
    make();
  } catch (error) {
    return error instanceof Auth.EventTagConflict ? Option.some(error) : Option.none();
  }
  return Option.none();
};

describe("Auth.make composes event definitions (ADR-EA-049)", () => {
  it("C1: two plugins declaring one tag are refused, naming both owners", () => {
    const conflict = conflictOf(() => Auth.make([First, Second]));
    assert.isTrue(Option.isSome(conflict));
    if (Option.isNone(conflict)) return;
    assert.strictEqual(conflict.value._tag, "Auth/EventTagConflict");
    assert.strictEqual(conflict.value.tag, "auth.dup.happened");
    assert.strictEqual(conflict.value.firstOwner, "first");
    assert.strictEqual(conflict.value.secondOwner, "second");
    assert.include(conflict.value.message, "E_EVENT_TAG_CONFLICT");
  });

  it("C2: a plugin declaring a core tag, or the reserved foreign-event tag, is refused with core as first owner", () => {
    const core = conflictOf(() => Auth.make([Thief]));
    assert.isTrue(Option.isSome(core) && core.value.firstOwner === "core");
    assert.isTrue(Option.isSome(core) && core.value.tag === "auth.user.created");
    const reserved = conflictOf(() => Auth.make([Squatter]));
    assert.isTrue(Option.isSome(reserved) && reserved.value.firstOwner === "core");
  });

  it("C3: the composed tags are core's, then each plugin's, in link order", () => {
    const auth = Auth.make([Notes, Tasks]);
    assert.deepStrictEqual(auth.events.tags, [
      ...AuthEvents.eventTags,
      "auth.notes.created",
      "auth.notes.flagged",
      "auth.tasks.done",
    ]);
    assert.strictEqual(auth.events.origin, "composition");
    assert.isTrue(auth.events.isAttempt("auth.notes.flagged"));
    assert.deepStrictEqual(auth.events.piiFieldsOf("auth.notes.flagged"), ["reason"]);
  });

  it("C4: manifest.events lists every event with its owner, actor, pii and attempt", () => {
    const auth = Auth.make([Notes, Tasks]);
    const byTag = new Map(auth.manifest.events.map((event) => [event.tag, event]));
    assert.strictEqual(auth.manifest.events.length, AuthEvents.eventTags.length + 3);
    assert.deepStrictEqual(byTag.get("auth.notes.created"), {
      tag: "auth.notes.created",
      owner: "notes",
      actor: { _tag: "Field", field: "userId" },
      pii: [],
      attempt: false,
    });
    assert.deepStrictEqual(byTag.get("auth.notes.flagged"), {
      tag: "auth.notes.flagged",
      owner: "notes",
      actor: { _tag: "None" },
      pii: ["reason"],
      attempt: true,
    });
    assert.strictEqual(byTag.get("auth.tasks.done")?.owner, "tasks");
    assert.strictEqual(byTag.get("auth.user.created")?.owner, "core");
  });

  it.effect("C5: eventsLayer provides the composed registry as AuthEvents.EventRegistry", () =>
    Effect.gen(function* () {
      const auth = Auth.make([Notes, Tasks]);
      const registry = yield* AuthEvents.EventRegistry.pipe(Effect.provide(auth.eventsLayer));
      assert.strictEqual(registry.origin, "composition");
      assert.isTrue(registry.isTag("auth.tasks.done"));
      // Without it, the reference is core's own registry.
      const fallback = yield* AuthEvents.EventRegistry;
      assert.strictEqual(fallback.origin, "core");
      assert.isFalse(fallback.isTag("auth.tasks.done"));
    }),
  );

  it.effect(
    "C6: AuthEvents.typed(auth.events).on(tag, h) narrows the handler and filters the stream",
    () =>
      Effect.gen(function* () {
        const auth = Auth.make([Notes, Tasks]);
        const typed = AuthEvents.typed(auth.events);
        const seen = yield* Queue.unbounded<string>();
        const events = yield* AuthEvents.AuthEvents;
        yield* Effect.scoped(
          Effect.gen(function* () {
            // `event.noteId` type-checks only because the handler is narrowed to `auth.notes.created`.
            yield* Layer.build(
              typed.on("auth.notes.created", (event) => Queue.offer(seen, event.noteId)),
            );
            yield* events.emit(TasksDoneEvent, { taskId: "t-1" });
            yield* events.emit(NotesCreatedEvent, { userId, noteId: "n-1" });
            assert.strictEqual(yield* Queue.take(seen), "n-1");
            yield* Effect.yieldNow;
            assert.strictEqual(yield* Queue.size(seen), 0);
          }),
        );
        const published = { ...core(), _tag: "auth.notes.created", userId, noteId: "n-2" };
        const partial = { ...core(), _tag: "auth.notes.created", userId };
        // `is` narrows to the composition's union, so the tag check reads `noteId` without a cast.
        assert.isTrue(
          typed.is(published) &&
            published._tag === "auth.notes.created" &&
            published.noteId === "n-2",
        );
        assert.isFalse(typed.is(partial));
        assert.isFalse(typed.is({ ...core(), _tag: "auth.elsewhere.happened" }));
      }).pipe(
        Effect.provide(
          AuthEvents.layer.pipe(
            Layer.provideMerge(AuditLog.layer.pipe(Layer.provide(Persistence.memory))),
            Layer.provide(Auth.make([Notes, Tasks]).eventsLayer),
            Layer.provide(Layer.succeed(AuthEvents.UndeclaredEventPolicy, "die")),
          ),
        ),
      ),
  );

  it("a plugin declaring no events contributes none; the type of its composition is core's union", () => {
    const auth = Auth.make([Quiet]);
    assert.deepStrictEqual(auth.events.tags, AuthEvents.eventTags);
    const narrow = (event: Auth.EventsOf<readonly [typeof Notes, typeof Tasks]>) =>
      event._tag === "auth.notes.created"
        ? event.noteId
        : event._tag === "auth.tasks.done"
          ? event.taskId
          : event._tag;
    void narrow;
  });
});

/** An envelope with nothing set, for guard checks on hand-built events. */
const core = () => ({
  eventId: "018f0000-0000-7000-8000-000000000001",
  occurredAt: DateTime.makeUnsafe(0),
  correlationId: Option.none<string>(),
  traceId: Option.none<string>(),
  spanId: Option.none<string>(),
  ip: Option.none<string>(),
  userAgent: Option.none<string>(),
  tenantId: Option.none<string>(),
});
