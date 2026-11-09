---
"@awthaq/webhooks": minor
"@awthaq/core": minor
---

The readers of "every tag" read the composition's event registry (ADR-EA-049). `@awthaq/webhooks` validates endpoint filters against `AuthEvents.EventRegistry` (core's events plus every composed plugin's: provide `auth.eventsLayer`, as `AuthHost.layer` does), drops the personal-data fields that registry declares for each event, and does not enqueue an event whose tag the registry does not hold (logged as `auth.webhooks.unknownEvent`): without its definition its personal-data fields are unknown. `@awthaq/core`'s `Retention` refuses a rule tag that is not an event of the composition with `Defects/InvalidConfiguration` (at `sweep`, and when `layerScheduled` is built).

Migration: `WebhookPayload.knownEventTags` is removed; read `AuthEvents.EventRegistry`'s `tags`. `WebhookPayload.unknownPattern(patterns, tags)` and `WebhookPayload.toBody(event, options, pii)` take the registry's tags and the event's `piiFieldsOf`. A host composing without `AuthHost.layer` provides `auth.eventsLayer` to the webhooks plugin and its background relay, or filters naming a plugin's events are refused and those events are not delivered. A Retention rule must name a tag of the composition. BEH-EA-277, BEH-EA-278, ADR-EA-049.
