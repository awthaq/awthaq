// What an admin test reads back off the open event stream (ADR-EA-049): core's events and the admin plugins'
// own, narrowed by `AuthEvents.is`, so a handler still narrows on `_tag`.
import { AuthEvents } from "@awthaq/core";
import * as AdminEvents from "../../src/AdminEvents.ts";

/** The selector: every core tag plus `Admin`'s and `AdminAccounts`' definitions. */
export const adminTestEvents = [
  ...AuthEvents.eventTags,
  ...AdminEvents.events,
  ...AdminEvents.accountsEvents,
];

/** A delivered core or admin event. */
export type AdminTestEvent = AuthEvents.Handled<typeof adminTestEvents>;
