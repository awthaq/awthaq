// TMS-004: shared eviction for the in-memory `Sessions`/`Verification` twins.
//
// Both layers keep rows in a `Ref<HashMap>` that only ever grew: a row left
// behind by an attacker-chosen identifier (a verification reservation, a
// never-consumed token, a session nobody revokes) stayed in the process for
// its lifetime. The prune runs inside the layer's own `Ref.update`/`Ref.modify`,
// so it never breaks the atomicity those steps rely on.

import * as DateTime from "effect/DateTime";
import * as HashMap from "effect/HashMap";

/** The map size below which pruning is skipped: it is an O(n) scan, so small dev/test maps never pay for it. */
export const pruneThreshold = 10_000;

/** Drops every entry whose expiry is at or before `now`. */
export const pruneExpired = <K, V>(
  map: HashMap.HashMap<K, V>,
  now: DateTime.Utc,
  expiryOf: (value: V) => DateTime.Utc,
): HashMap.HashMap<K, V> =>
  HashMap.filter(map, (value) => DateTime.isLessThan(now, expiryOf(value)));

/** `pruneExpired`, but only once `map` has outgrown `threshold`. */
export const pruneExpiredAbove = <K, V>(
  map: HashMap.HashMap<K, V>,
  now: DateTime.Utc,
  expiryOf: (value: V) => DateTime.Utc,
  threshold: number = pruneThreshold,
): HashMap.HashMap<K, V> =>
  HashMap.size(map) > threshold ? pruneExpired(map, now, expiryOf) : map;
