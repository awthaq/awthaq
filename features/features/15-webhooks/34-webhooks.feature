# Acceptance scenarios restating spec/behaviors/ as Gherkin (see spec/README.md
# and features/README.md). A file tagged @unwired is registered with zero steps and
# does not run; a wired file runs under `pnpm test:bdd` against the real plugins,
# so only its passing scenarios are runtime evidence.

# P20a: authored against the shipped `@awthaq/webhooks` (ADR-EA-030 Decision 7). The World is the
# real in-memory core, records, `Encryption` over a fixed key and the plugin's own service; the
# receiver is a programmable fake `HttpClient` that records every request it is asked to send (its
# `redirect` mode included), so what a scenario asserts about a delivery is what a receiver
# would have seen on the wire. Time is the test clock: backoff, grace windows, leases and
# retention advance by `the clock advances`, never by waiting.

@webhooks
Feature: Outbound Webhooks

  # BEH-EA-275 — spec/behaviors/34-webhooks.md; see also BEH-EA-100, ADR-EA-030
  @BEH-EA-275
  Rule: Deliveries are signed like Standard Webhooks and re-stamped on every attempt

    @REQ-EA-1127
    Scenario: A delivery is a signed JSON POST that the receiver verifies with the endpoint's secret
      Given an endpoint "billing" registered for "auth.user.signedIn"
      And a "auth.user.signedIn" event "e1" for user "user-1"
      When event "e1" is queued and delivered
      Then endpoint "billing" was sent 1 request
      And that request is a POST of a JSON body
      And its "webhook-id" header is the id of event "e1"
      And its "webhook-signature" header is one "v1," signature
      And verifying that request under the secret of "billing" succeeds and yields the id of event "e1"

    @REQ-EA-1128
    Scenario: Every attempt is re-stamped but keeps the event id as the receiver's idempotency key
      Given an endpoint "billing" registered for "auth.user.signedIn"
      And the receiver answers 500 to the first attempt and 200 afterwards
      And a "auth.user.signedIn" event "e1" for user "user-1"
      When event "e1" is queued and delivered
      And the clock advances 10 seconds
      And the delivery worker runs
      Then endpoint "billing" was sent 2 requests
      And both requests carry the same "webhook-id"
      And the second request's "webhook-timestamp" is 10 seconds after the first's

    @REQ-EA-1129
    Scenario: A rotated-out secret keeps signing alongside the new one for the grace window
      Given an endpoint "billing" registered for "auth.user.signedIn"
      And the secret of "billing" is rotated, keeping the old one as "old"
      And a "auth.user.signedIn" event "e1" for user "user-1"
      When event "e1" is queued and delivered
      Then the request to "billing" carries 2 signatures
      And verifying that request under the secret "old" succeeds
      And verifying that request under the current secret of "billing" succeeds

    @REQ-EA-1130
    Scenario: After the grace window only the new secret signs
      Given an endpoint "billing" registered for "auth.user.signedIn"
      And the secret of "billing" is rotated, keeping the old one as "old"
      And the clock advances 25 hours
      And a "auth.user.signedIn" event "e1" for user "user-1"
      When event "e1" is queued and delivered
      Then the request to "billing" carries 1 signature
      And verifying that request under the secret "old" is refused as "noMatchingSignature"
      And verifying that request under the current secret of "billing" succeeds

    @REQ-EA-1131
    Scenario Outline: The receiver's verification refuses what it must refuse
      Given an endpoint "billing" registered for "auth.user.signedIn"
      And a "auth.user.signedIn" event "e1" for user "user-1"
      When event "e1" is queued and delivered
      And the receiver verifies that request after <tampering>
      Then the verification is refused as "<reason>"

      Examples:
        | tampering                                          | reason                    |
        | removing the "webhook-signature" header            | missingHeaders            |
        | removing the "webhook-id" header                   | missingHeaders            |
        | setting "webhook-timestamp" to "12ab"              | malformedTimestamp        |
        | its own clock running 6 minutes ahead              | timestampOutsideTolerance |
        | its own clock running 6 minutes behind             | timestampOutsideTolerance |
        | changing one character of the body                 | noMatchingSignature       |
        | replacing the signature with one from another key  | noMatchingSignature       |

    @REQ-EA-1132
    Scenario Outline: A timestamp inside the replay window is accepted in both directions
      Given an endpoint "billing" registered for "auth.user.signedIn"
      And a "auth.user.signedIn" event "e1" for user "user-1"
      When event "e1" is queued and delivered
      And the receiver verifies that request after its own clock running <offset>
      Then the verification succeeds

      Examples:
        | offset            |
        | 4 minutes ahead   |
        | 4 minutes behind  |

    # @skip: constant-time comparison is a timing property that no in-process scenario can observe;
    # covered by packages/ports/test/Hmac.test.ts (constantTimeEqualString) and the
    # every-candidate-is-checked loop in WebhookSignature.verify.
    @skip
    @REQ-EA-1133
    Scenario: Every candidate signature is compared in constant time
      Given a receiver holding two accepted secrets
      When a request signed under the second secret is verified
      Then every presented signature is compared against every accepted secret in constant time

  # BEH-EA-276 — spec/behaviors/34-webhooks.md; see also ADR-EA-030, BEH-EA-275
  @BEH-EA-276
  Rule: Each endpoint has its own secret, shown once, stored sealed, and rotatable with an overlap

    @REQ-EA-1134
    Scenario: The secret is returned when an endpoint is created and never again
      Given the administrator gate allows every action
      When the administrator registers "https://hooks.example.com/billing" for "auth.user.*" as "billing"
      Then the creation response carries a secret of the form "whsec_" followed by 32 random bytes
      And listing endpoints never contains that secret
      And reading endpoint "billing" never contains that secret

    @REQ-EA-1135
    Scenario: The stored secret is an Encryption envelope bound to its endpoint and field
      Given an endpoint "billing" registered for "auth.user.*"
      And an endpoint "other" registered for "auth.user.*"
      Then the stored secret of "billing" does not contain its plaintext
      And it decrypts to the plaintext only under the additional data naming "billing" and "secret"
      And it does not decrypt under the additional data naming "other" and "secret"
      And it does not decrypt under the additional data naming "billing" and "previousSecret"

    @REQ-EA-1136
    Scenario: A sealed secret copied into another endpoint's row does not decrypt, and nothing is sent
      Given an endpoint "billing" registered for "auth.user.signedIn"
      And an endpoint "other" registered for "auth.user.signedIn"
      And the sealed secret of "other" is copied into the row of "billing"
      And a "auth.user.signedIn" event "e1" for user "user-1"
      When event "e1" is queued and delivered
      Then endpoint "billing" was sent 0 requests
      And the delivery of event "e1" to "billing" failed as "secret"

    @REQ-EA-1137
    Scenario: The previous secret swapped into the current field does not decrypt, and nothing is sent
      Given an endpoint "billing" registered for "auth.user.signedIn"
      And the secret of "billing" is rotated, keeping the old one as "old"
      And the previous sealed secret of "billing" is moved into its current secret field
      And a "auth.user.signedIn" event "e1" for user "user-1"
      When event "e1" is queued and delivered
      Then endpoint "billing" was sent 0 requests
      And the delivery of event "e1" to "billing" failed as "secret"

    @REQ-EA-1138
    Scenario: Rotation makes a new secret current and keeps the previous one for the default 24 hours
      Given an endpoint "billing" registered for "auth.user.signedIn"
      When the secret of "billing" is rotated, keeping the old one as "old"
      Then the secret of "billing" is different from "old"
      And the previous secret of "billing" expires 24 hours from now

    @REQ-EA-1139
    Scenario: A second rotation forgets the first secret
      Given an endpoint "billing" registered for "auth.user.signedIn"
      And the secret of "billing" is rotated, keeping the old one as "first"
      And the secret of "billing" is rotated, keeping the old one as "second"
      And a "auth.user.signedIn" event "e1" for user "user-1"
      When event "e1" is queued and delivered
      Then the request to "billing" carries 2 signatures
      And verifying that request under the secret "second" succeeds
      And verifying that request under the current secret of "billing" succeeds
      And verifying that request under the secret "first" is refused as "noMatchingSignature"

  # BEH-EA-277 — spec/behaviors/34-webhooks.md; see also ADR-EA-029, BEH-EA-100, BEH-EA-282
  @BEH-EA-277
  Rule: A payload carries identifiers only, and an external consumer inherits that posture

    @REQ-EA-1140
    Scenario: The delivered document is the versioned envelope with the event's own fields
      Given an endpoint "billing" registered for "auth.user.signedIn"
      And a "auth.user.signedIn" event "e1" for user "user-1"
      When event "e1" is queued and delivered
      Then the body sent to "billing" has version 1, type "auth.user.signedIn", the id of event "e1" and an ISO timestamp
      And its data is exactly the event's fields "userId" and "strategy"

    @REQ-EA-1141
    Scenario: The correlation and trace ids ride along when the event has them
      Given an endpoint "billing" registered for "auth.user.signedIn"
      And a "auth.user.signedIn" event "e1" for user "user-1" with correlation "corr-1" and trace "trace-1"
      When event "e1" is queued and delivered
      Then the body sent to "billing" carries correlationId "corr-1" and traceId "trace-1"

    @REQ-EA-1142
    Scenario: Free text about a person is never sent
      Given an endpoint "billing" registered for "auth.admin.impersonationStarted"
      And an impersonation event "e1" with the justification "Customer jane.doe@example.com reported fraud"
      When event "e1" is queued and delivered
      Then the body sent to "billing" does not contain "jane.doe@example.com"
      And the body sent to "billing" does not contain "fraud"
      And the body sent to "billing" contains "user-2"

    @REQ-EA-1143
    Scenario: The client address and user agent are withheld by default
      Given an endpoint "billing" registered for "auth.user.signInFailed"
      And a sign-in failure event "e1" from "203.0.113.9" with the user agent "Mozilla/5.0"
      When event "e1" is queued and delivered
      Then the body sent to "billing" does not contain "203.0.113.9"
      And the body sent to "billing" does not contain "Mozilla"
      And the body sent to "billing" has no client block

    @REQ-EA-1144
    Scenario: includeClientContext opts the client address and user agent in
      Given the plugin is configured with includeClientContext
      And an endpoint "billing" registered for "auth.user.signInFailed"
      And a sign-in failure event "e1" from "203.0.113.9" with the user agent "Mozilla/5.0"
      When event "e1" is queued and delivered
      Then the body sent to "billing" has the client block ip "203.0.113.9" and userAgent "Mozilla/5.0"

    @REQ-EA-1145
    Scenario Outline: A field named like a credential or contact detail is dropped whatever the event schema declares
      Given a "auth.user.signedIn" event "e1" for user "user-1" that also carries a field "<field>" holding "leak-me"
      When the payload of event "e1" is built with includeClientContext
      Then the payload does not contain "leak-me"
      And the payload still contains the field "userId"

      Examples:
        | field         |
        | email         |
        | phone         |
        | Password      |
        | accessToken   |
        | secret        |
        | passwordHash  |
        | authorization |
        | cookie        |

    @REQ-EA-1146
    Scenario: The delivery log the API returns never carries the payload
      Given the administrator gate allows every action
      And an endpoint "billing" registered for "auth.user.signedIn"
      And a "auth.user.signedIn" event "e1" for user "user-1"
      When event "e1" is queued and delivered
      Then listing the deliveries of "billing" returns 1 delivery with outcome fields only
      And that listing does not contain the payload

  # BEH-EA-278 — spec/behaviors/34-webhooks.md; see also BEH-EA-100
  @BEH-EA-278
  Rule: An endpoint subscribes to named events and hears only what happens after it exists

    @REQ-EA-1147
    Scenario Outline: An event is queued only for endpoints whose filter matches it
      Given an endpoint "billing" registered for "<filter>"
      And a "<tag>" event "e1" for user "user-1"
      When event "e1" is queued
      Then <outcome> for "billing"

      Examples:
        | filter                    | tag                       | outcome                    |
        | auth.user.signedIn        | auth.user.signedIn        | event "e1" is queued       |
        | auth.user.signedIn        | auth.user.created         | nothing is queued          |
        | auth.user.*               | auth.user.created         | event "e1" is queued       |
        | auth.organization.*       | auth.user.signedIn        | nothing is queued          |
        | auth.organization.*       | auth.organization.created | event "e1" is queued       |
        | *                         | auth.organization.updated | event "e1" is queued       |

    @REQ-EA-1148
    Scenario Outline: A filter that matches no publishable tag is refused at registration
      Given the administrator gate allows every action
      When the administrator tries to register "https://hooks.example.com/billing" for "<filter>"
      Then registration is refused as InvalidWebhookEndpoint naming "matches no event"
      And no endpoint exists

      Examples:
        | filter               |
        | auth.user.signedInn  |
        | nothing.*            |

    @REQ-EA-1149
    Scenario: An empty filter is not a valid registration
      Then a registration with no event tags is rejected by the endpoint payload schema

    @REQ-EA-1150
    Scenario: An endpoint does not receive the log's history
      Given a "auth.user.signedIn" event "early" for user "early-user"
      And the clock advances 5 seconds
      And an endpoint "late" registered for "*"
      And a "auth.user.signedIn" event "later" for user "later-user"
      When events "early" and "later" are queued
      Then event "later" is queued for "late"
      And event "early" is not queued for "late"

    @REQ-EA-1151
    Scenario: A disabled endpoint hears nothing, and switching it back on resumes from then
      Given the administrator gate allows every action
      And an endpoint "billing" registered for "*"
      And endpoint "billing" is switched off
      And a "auth.user.signedIn" event "e1" for user "user-1"
      And a "auth.user.signedIn" event "e2" for user "user-2"
      When event "e1" is queued
      And endpoint "billing" is switched back on
      And event "e2" is queued
      Then event "e2" is queued for "billing"
      And event "e1" is not queued for "billing"

  # BEH-EA-279 — spec/behaviors/34-webhooks.md; see also BEH-EA-100, ADR-EA-030
  @BEH-EA-279
  Rule: Deliveries are queued idempotently from the relay and sent at-least-once with retry, backoff and dead-letter

    @REQ-EA-1152
    Scenario: A batch handed over again adds nothing
      Given an endpoint "billing" registered for "*"
      And a "auth.user.signedIn" event "e1" for user "user-1"
      And a "auth.user.created" event "e2" for user "user-2"
      When events "e1" and "e2" are queued
      And events "e1" and "e2" are queued again
      Then the first hand-over queued 2 deliveries and the second queued 0
      And "billing" holds exactly 2 delivery rows

    @REQ-EA-1153
    Scenario: The relay's cursor advances once the batch is queued, whether or not a receiver is healthy
      Given an endpoint "healthy" registered for "auth.user.signedIn"
      And an endpoint "dead" registered for "auth.user.signedIn"
      And the receiver answers 503 to "dead"
      And events are published on the bus: a "auth.user.signedIn" event for user "relayed" and a "auth.user.created" event for user "ignored"
      When the relay named "webhooks" hands over what it has settled
      And the relay hands over what it has settled again
      And the delivery worker runs
      Then the first hand-over carried 2 events and the second carried 0
      And endpoint "healthy" was sent 1 request
      And endpoint "dead" was sent 1 request
      And the delivery to "healthy" succeeded while the delivery to "dead" is pending its retry

    @REQ-EA-1154
    Scenario: A failing receiver is retried on a capped exponential schedule, then dead-lettered
      Given the plugin allows 3 delivery attempts, retrying after 10 seconds with a factor of 3
      And an endpoint "billing" registered for "auth.user.signedIn"
      And the receiver answers 503
      And a "auth.user.signedIn" event "e1" for user "user-1"
      When event "e1" is queued and delivered
      Then the delivery of event "e1" to "billing" is pending after 1 attempt
      When the clock advances 9 seconds
      Then the delivery worker finds nothing due
      When the clock advances 1 seconds
      Then the delivery worker attempts 1 delivery
      When the clock advances 29 seconds
      Then the delivery worker finds nothing due
      When the clock advances 1 seconds
      Then the delivery worker attempts 1 delivery
      And the delivery of event "e1" to "billing" is dead after 3 attempts
      When the clock advances 24 hours
      Then the delivery worker finds nothing due
      And endpoint "billing" was sent 3 requests

    @REQ-EA-1155
    Scenario: The retry delay is capped at retryMax
      Given the plugin allows 4 delivery attempts, retrying after 10 seconds with a factor of 3
      And the retry delay is capped at 20 seconds
      And an endpoint "billing" registered for "auth.user.signedIn"
      And the receiver answers 503
      And a "auth.user.signedIn" event "e1" for user "user-1"
      When event "e1" is queued and delivered
      And the clock advances 10 seconds
      And the delivery worker runs
      And the clock advances 19 seconds
      Then the delivery worker finds nothing due
      When the clock advances 1 seconds
      Then the delivery worker attempts 1 delivery

    # @skip: a request deadline is registered on the test clock only after the real (WebCrypto) secret
    # decryption finishes, so a scenario cannot advance it deterministically without polling real time;
    # covered by packages/webhooks/test/WebhookDelivery.test.ts "a receiver that never answers times out
    # after requestTimeout, and that is a failed attempt".
    @skip
    @REQ-EA-1156
    Scenario: A receiver that never answers is a failed attempt after requestTimeout
      Given an endpoint "billing" registered for "auth.user.signedIn"
      And the receiver never answers
      When an event is queued and delivered
      Then the delivery is recorded as a timeout attempt

    @REQ-EA-1157
    Scenario Outline: The outcome of an attempt is a status code or an error class, never a body or a message
      Given an endpoint "billing" registered for "auth.user.signedIn"
      And the receiver <behaviour>
      And a "auth.user.signedIn" event "e1" for user "user-1"
      When event "e1" is queued and delivered
      Then the delivery of event "e1" to "billing" records <status> and the error class "<class>"

      Examples:
        | behaviour                                           | status          | class   |
        | answers 500                                         | status code 500 | status  |
        | answers 404                                         | status code 404 | status  |
        | fails at the transport level                        | no status code  | connect |

    @REQ-EA-1158
    Scenario: A dead delivery is never sent again unless an administrator retries it
      Given the administrator gate allows every action
      And the plugin allows 1 delivery attempts, retrying after 10 seconds with a factor of 3
      And an endpoint "billing" registered for "auth.user.signedIn"
      And the receiver answers 503
      And a "auth.user.signedIn" event "e1" for user "user-1"
      When event "e1" is queued and delivered
      Then the delivery of event "e1" to "billing" is dead after 1 attempt
      When the clock advances 1 hours
      Then the delivery worker finds nothing due
      When the administrator retries the delivery of event "e1" to "billing"
      Then the delivery of event "e1" to "billing" is pending after 0 attempts
      And the delivery worker attempts 1 delivery

    @REQ-EA-1159
    Scenario: Consecutive dead-letters switch an endpoint off, and a success resets the count
      Given the plugin allows 1 delivery attempts, retrying after 10 seconds with a factor of 3
      And endpoints are switched off after 2 consecutive dead-lettered deliveries
      And an endpoint "billing" registered for "auth.user.signedIn"
      And the receiver answers 503
      And a "auth.user.signedIn" event "e1" for user "user-1"
      And a "auth.user.signedIn" event "e2" for user "user-2"
      And a "auth.user.signedIn" event "e3" for user "user-3"
      When events "e1" and "e2" are queued and delivered
      Then endpoint "billing" is switched off because it is "failing"
      And event "e3" is not queued for "billing" when it is queued

    @REQ-EA-1160
    Scenario: A success after dead-letters resets the consecutive count
      Given the plugin allows 1 delivery attempts, retrying after 10 seconds with a factor of 3
      And endpoints are switched off after 2 consecutive dead-lettered deliveries
      And an endpoint "billing" registered for "auth.user.signedIn"
      And the receiver answers 503
      And a "auth.user.signedIn" event "e1" for user "user-1"
      And a "auth.user.signedIn" event "e2" for user "user-2"
      When event "e1" is queued and delivered
      And the receiver answers 200
      And event "e2" is queued and delivered
      Then endpoint "billing" has 0 consecutive dead-letters and is still enabled

    @REQ-EA-1161
    Scenario: A claimed delivery is leased, and a lapsed lease is sent again
      Given an endpoint "billing" registered for "auth.user.signedIn"
      And a "auth.user.signedIn" event "e1" for user "user-1"
      When event "e1" is queued
      And a worker claims what is due and never finishes
      Then a second worker finds nothing due
      When the clock advances 61 seconds
      Then the delivery worker attempts 1 delivery
      And endpoint "billing" was sent 1 request

    @REQ-EA-1162
    Scenario: Every attempt is counted on awthaq_webhook_deliveries_total by outcome
      Given an endpoint "billing" registered for "auth.user.signedIn"
      And a "auth.user.signedIn" event "e1" for user "user-1"
      When event "e1" is queued and delivered
      Then the counter awthaq_webhook_deliveries_total for outcome "succeeded" grew by 1

  # BEH-EA-280 — spec/behaviors/34-webhooks.md; see also ADR-EA-030
  @BEH-EA-280
  Rule: An endpoint URL is an SSRF surface, checked when registered and again on every attempt

    @REQ-EA-1163
    Scenario Outline: A URL that could reach the internal network is refused at registration
      Given the administrator gate allows every action
      When the administrator tries to register "<url>" for "*"
      Then registration is refused as InvalidWebhookEndpoint naming "<rule>"
      And no endpoint exists

      Examples:
        | url                                   | rule                 |
        | http://hooks.example.com/x            | must be https        |
        | https://user:pw@hooks.example.com/x   | credentials          |
        | https://169.254.169.254/latest        | private or loopback  |
        | https://[::ffff:127.0.0.1]/x          | private or loopback  |
        | https://localhost/x                   | private or loopback  |
        | https://intranet/x                    | fully qualified      |
        | not a url                             | absolute URL         |
        | https://rebind.example.com/x          | resolves to a private |
        | https://nx.example.com/x              | does not resolve     |

    @REQ-EA-1164
    Scenario: A public https host is accepted
      Given the administrator gate allows every action
      When the administrator registers "https://hooks.example.com/billing" for "*" as "billing"
      Then endpoint "billing" exists

    @REQ-EA-1165
    Scenario: A name that now resolves to a private address is refused at attempt time, with no request made
      Given an endpoint "rebound" registered for "auth.user.signedIn" at "https://rebind.example.com/hook"
      And a "auth.user.signedIn" event "e1" for user "user-1"
      When event "e1" is queued and delivered
      Then no request was sent to any receiver
      And the delivery of event "e1" to "rebound" failed as "blocked"

    @REQ-EA-1166
    Scenario: A private literal in a stored URL is refused at attempt time too
      Given an endpoint "metadata" registered for "auth.user.signedIn" at "https://169.254.169.254/latest/meta-data"
      And a "auth.user.signedIn" event "e1" for user "user-1"
      When event "e1" is queued and delivered
      Then no request was sent to any receiver
      And the delivery of event "e1" to "metadata" failed as "blocked"

    @REQ-EA-1167
    Scenario: A redirect is a failed attempt and is never followed
      Given an endpoint "billing" registered for "auth.user.signedIn"
      And the receiver answers 302 with a Location header naming the cloud metadata address
      And a "auth.user.signedIn" event "e1" for user "user-1"
      When event "e1" is queued and delivered
      Then endpoint "billing" was sent 1 request
      And that request told the client not to follow redirects
      And the delivery of event "e1" to "billing" records status code 302 and the error class "status"
      And the request was not repeated at the redirect target

    @REQ-EA-1168
    Scenario: The response body is neither read nor stored
      Given an endpoint "billing" registered for "auth.user.signedIn"
      And the receiver answers 500 with the body "secret-internal-detail"
      And a "auth.user.signedIn" event "e1" for user "user-1"
      When event "e1" is queued and delivered
      Then the delivery log of "billing" does not contain "secret-internal-detail"

    @REQ-EA-1169
    Scenario: allowPrivateTargets lifts the scheme and host rules for development
      Given the plugin is configured with allowPrivateTargets
      And the administrator gate allows every action
      When the administrator registers "http://localhost:3000/hook" for "*" as "local"
      Then endpoint "local" exists
      And a delivery to "local" is sent

    @REQ-EA-1170
    Scenario: allowPrivateTargets never lifts the credentials rule
      Given the plugin is configured with allowPrivateTargets
      And the administrator gate allows every action
      When the administrator tries to register "http://a:b@localhost/hook" for "*"
      Then registration is refused as InvalidWebhookEndpoint naming "credentials"

  # BEH-EA-281 — spec/behaviors/34-webhooks.md; see also BEH-EA-071, BEH-EA-095
  @BEH-EA-281
  Rule: Administration is fail-closed, on the admin tier, and rate limited

    @REQ-EA-1171
    Scenario: With no gate configured every operation is denied, audited, and touches nothing
      Given no administrator gate is configured
      When the administrator attempts every webhooks operation
      Then all 9 are refused as WebhooksActionDenied
      And each refusal published auth.admin.actionDenied naming "webhooks.<action>"
      And no endpoint exists

    @REQ-EA-1172
    Scenario: The gate sees the action, so an auditor can read while only an owner registers
      Given the administrator gate allows only actions starting with "list"
      When the administrator tries to register "https://hooks.example.com/billing" for "*"
      Then registration is refused as WebhooksActionDenied
      And listing endpoints is allowed

    @REQ-EA-1173
    Scenario: A caller who fails the gate learns nothing about which ids exist
      Given no administrator gate is configured
      And an endpoint "real" registered for "*"
      When the administrator reads endpoint "real" and an unknown endpoint "fake"
      Then both are refused as WebhooksActionDenied

    @REQ-EA-1174
    Scenario: A caller who passes the gate gets 404 only for an id that does not exist
      Given the administrator gate allows every action
      When the administrator reads an unknown endpoint "fake"
      Then the read is refused as WebhookEndpointNotFound

    @REQ-EA-1175
    Scenario: Past the gate each administrator is limited per window
      Given the administrator gate allows every action
      And each administrator may make 2 calls per minute
      When administrator "admin-1" lists endpoints 3 times
      Then the third call is refused as RateLimited
      And administrator "admin-2" may still list endpoints
      When the clock advances 1 minutes
      Then administrator "admin-1" may list endpoints again

    @REQ-EA-1176
    Scenario: Registration stops at maxEndpoints
      Given the administrator gate allows every action
      And no more than 2 endpoints may be registered
      When the administrator registers 3 endpoints
      Then the third is refused as WebhookEndpointLimitReached

    @REQ-EA-1177
    Scenario: The group is served on the admin tier and not the public one
      Then composing Webhooks puts "webhooks.admin" in the admin API and not in the public API

    @REQ-EA-1178
    Scenario: An unauthenticated request is 401 before the gate is asked
      Given the webhooks admin API is served over HTTP with the gate allowing every action
      When an unauthenticated client registers an endpoint
      Then the response status is 401

    @REQ-EA-1179
    Scenario: An authenticated request is 403 while the gate is unconfigured
      Given the webhooks admin API is served over HTTP with no gate configured
      When a signed-in administrator registers an endpoint
      Then the response status is 403 with the tag "WebhooksActionDenied"

    @REQ-EA-1180
    Scenario: A state-changing request without the CSRF token is refused before the gate
      Given the webhooks admin API is served over HTTP with the gate allowing every action
      When a signed-in administrator registers an endpoint without the CSRF token
      Then the response status is 403

    @REQ-EA-1181
    Scenario: A registered endpoint can be updated, rotated, listed, retried and deleted through the gate
      Given the administrator gate allows every action
      And an endpoint "billing" registered for "auth.user.*"
      When the administrator updates "billing" to filter "auth.session.*" and switches it off and on
      And the administrator deletes "billing"
      Then endpoint "billing" no longer exists
      And deleting it again is refused as WebhookEndpointNotFound

  # BEH-EA-282 — spec/behaviors/34-webhooks.md; see also BEH-EA-095, BEH-EA-254
  @BEH-EA-282
  Rule: The delivery log takes part in erasure and export, and is pruned

    @REQ-EA-1182
    Scenario: Erasing a user removes the delivery rows about them and leaves everyone else's
      Given an endpoint "billing" registered for "*"
      And a "auth.user.signedIn" event "mine" for user "me"
      And a "auth.user.signedIn" event "theirs" for user "them"
      When events "mine" and "theirs" are queued
      And the account erasure of "me" runs
      Then "billing" holds no delivery row about "me"
      And "billing" still holds the delivery row about "them"

    @REQ-EA-1183
    Scenario: The data-subject export lists the outcomes of deliveries about the subject, never a body
      Given an endpoint "billing" registered for "*"
      And a "auth.user.signedIn" event "mine" for user "me"
      And a "auth.user.signedIn" event "theirs" for user "them"
      When events "mine" and "theirs" are queued
      Then the export for "me" lists event "mine" and not event "theirs"
      And the export for "me" contains no body

    @REQ-EA-1184
    Scenario: Finished rows are pruned after the retention period and pending rows never are
      Given an endpoint "billing" registered for "*"
      And a "auth.user.signedIn" event "done" for user "user-1"
      And a "auth.user.signedIn" event "waiting" for user "user-2"
      When event "done" is queued and delivered
      And event "waiting" is queued
      And the clock advances 29 days
      And the retention prune runs
      Then the prune removed 0 rows
      When the clock advances 2 days
      And the retention prune runs
      Then the prune removed 1 row
      And the delivery of event "waiting" to "billing" is still pending

    @REQ-EA-1185
    Scenario: Over an endpoint's outbound budget a delivery waits and no attempt is spent
      Given each endpoint may receive 1 delivery per minute
      And an endpoint "billing" registered for "*"
      And a "auth.user.signedIn" event "e1" for user "user-1"
      And a "auth.user.signedIn" event "e2" for user "user-2"
      When events "e1" and "e2" are queued and delivered
      Then endpoint "billing" was sent 1 request
      And one delivery to "billing" is pending with 0 attempts and one succeeded
      When the clock advances 1 minutes
      Then the delivery worker attempts 1 delivery
      And endpoint "billing" was sent 2 requests

    # @skip: needs the account-deletion handler composed with the relay to publish auth.user.deleted
    # after the erasure transaction commits; that ordering is core's (BEH-EA-095), covered by
    # packages/core/test/AccountErasure.test.ts, and the queued delivery is the ordinary enqueue path
    # exercised above.
    @skip
    @REQ-EA-1186
    Scenario: The auth.user.deleted delivery is queued after the erasure commits and names the erased id
      Given an endpoint "billing" registered for "auth.user.deleted"
      When the account "me" is deleted and the relay runs
      Then a delivery naming "me" is queued after the erasure committed

  # BEH-EA-299 — spec/behaviors/34-webhooks.md; see also BEH-EA-230, BEH-EA-231, BEH-EA-100
  @BEH-EA-299
  Rule: An event carries the tenant it happened in, through the audit log and onto the wire

    @REQ-EA-1187
    Scenario: A tenant's event carries its tenant through the audit log to the delivered document
      Given an endpoint "acme" of tenant "org-a" registered for "auth.user.signedIn"
      When a "auth.user.signedIn" event for user "user-1" is published inside tenant "org-a" and relayed from the audit log
      Then the audit row of that event names tenant "org-a"
      And the body sent to "acme" carries tenantId "org-a"
      And the body sent to "acme" has no "tenantId" among its data fields

    @REQ-EA-1188
    Scenario: An event outside any tenant carries none
      Given an endpoint "billing" registered for "auth.user.signedIn"
      When a "auth.user.signedIn" event for user "user-1" is published outside a tenant and relayed from the audit log
      Then the audit row of that event names no tenant
      And the body sent to "billing" has no tenantId

  # BEH-EA-300 — spec/behaviors/34-webhooks.md; see also BEH-EA-230, BEH-EA-281
  @BEH-EA-300
  Rule: An endpoint belongs to a tenant and hears only that tenant's events, and administration is scoped to it

    @REQ-EA-1189
    Scenario Outline: An event is queued only for the endpoints of its own tenant
      Given an endpoint "platform" registered for "*"
      And an endpoint "acme" of tenant "org-a" registered for "*"
      And an endpoint "globex" of tenant "org-b" registered for "*"
      And a "auth.user.signedIn" event "e1" for user "user-1" in scope "<scope>"
      When event "e1" is queued
      Then event "e1" is queued only for "<hears>"

      Examples:
        | scope | hears    |
        | org-a | acme     |
        | org-b | globex   |
        | none  | platform |

    @REQ-EA-1190
    Scenario: The platform's endpoint hears every tenant only when it is configured to, and a tenant's endpoint never hears another
      Given the plugin is configured to let platform endpoints hear every tenant
      And an endpoint "platform" registered for "*"
      And an endpoint "acme" of tenant "org-a" registered for "*"
      And an endpoint "globex" of tenant "org-b" registered for "*"
      And a "auth.user.signedIn" event "e1" for user "user-1" in scope "org-a"
      When event "e1" is queued
      Then event "e1" is queued for "platform"
      And event "e1" is queued for "acme"
      And event "e1" is not queued for "globex"

    @REQ-EA-1191
    Scenario: An endpoint registered inside a tenant is stamped with it and invisible from another scope
      Given the administrator gate allows every action
      When the administrator in scope "org-a" registers "https://hooks.example.com/acme" for "*" as "acme"
      Then endpoint "acme" belongs to tenant "org-a"
      And the administrator in scope "org-a" lists 1 endpoint
      And the administrator in scope "org-b" lists 0 endpoints
      And the administrator in scope "none" lists 0 endpoints

    @REQ-EA-1192
    Scenario Outline: Another scope's endpoint is answered exactly like one that does not exist
      Given the administrator gate allows every action
      And the administrator in scope "org-a" registers "https://hooks.example.com/acme" for "*" as "acme"
      When the administrator in scope "<scope>" tries every operation on endpoint "acme"
      Then every operation is answered exactly as for an endpoint that does not exist
      And endpoint "acme" is untouched and enabled

      Examples:
        | scope |
        | org-b |
        | none  |

    @REQ-EA-1193
    Scenario: The endpoint limit is a per-tenant budget
      Given the administrator gate allows every action
      And no more than 1 endpoints may be registered
      When the administrator in scope "org-a" registers 2 endpoints, one at a time
      Then the first succeeds and the second is refused as WebhookEndpointLimitReached
      And the administrator in scope "org-b" lists 0 endpoints

  # BEH-EA-301 — spec/behaviors/34-webhooks.md; see also BEH-EA-275, BEH-EA-281
  @BEH-EA-301
  Rule: A test ping sends one signed synthetic event through the same delivery path

    @REQ-EA-1194
    Scenario: A ping is queued without any network call, then delivered signed and logged
      Given the administrator gate allows every action
      And an endpoint "billing" registered for "auth.user.signedIn"
      When the administrator sends a test ping to "billing"
      Then the ping is queued as pending and nothing has been sent
      When the delivery worker runs
      Then endpoint "billing" was sent 1 request
      And that request is a POST of a JSON body
      And the body sent to "billing" is the test event naming endpoint "billing"
      And that request verifies under the secret of "billing"
      And the delivery log of "billing" shows the test delivery as succeeded

    @REQ-EA-1195
    Scenario: A failed ping is a single attempt and does not count against the endpoint
      Given the administrator gate allows every action
      And endpoints are switched off after 1 consecutive dead-lettered deliveries
      And an endpoint "billing" registered for "auth.user.signedIn"
      And the receiver answers 503
      When the administrator sends a test ping to "billing"
      And the delivery worker runs
      Then the test delivery of "billing" is dead after 1 attempt
      And endpoint "billing" has 0 consecutive dead-letters and is still enabled

    @REQ-EA-1196
    Scenario: A disabled endpoint refuses a ping
      Given the administrator gate allows every action
      And an endpoint "billing" registered for "auth.user.signedIn"
      And endpoint "billing" is switched off
      When the administrator sends a test ping to "billing"
      Then the ping is refused as InvalidWebhookEndpoint

    @REQ-EA-1197
    Scenario: A ping is behind the gate by its own action name
      Given the administrator gate allows only actions starting with "list"
      And an endpoint "billing" registered for "auth.user.signedIn"
      When the administrator sends a test ping to "billing"
      Then the ping is refused as WebhooksActionDenied

  # BEH-EA-302 — spec/behaviors/34-webhooks.md; see also BEH-EA-224, BEH-EA-281
  @BEH-EA-302
  Rule: Every successful administrative mutation is audited, by identifiers only

    @REQ-EA-1198
    Scenario: Registering an endpoint publishes an audit event naming the administrator
      Given the administrator gate allows every action
      When the administrator registers "https://hooks.example.com/billing" for "*" as "billing"
      Then the audit log holds an "auth.webhooks.endpointCreated" event for "billing" naming administrator "admin-1"

    @REQ-EA-1199
    Scenario Outline: Each later mutation publishes one audit event naming the administrator
      Given the administrator gate allows every action
      And the administrator registers "https://hooks.example.com/billing" for "*" as "billing"
      When the administrator <mutation> "billing"
      Then the audit log holds an "<event>" event for "billing" naming administrator "admin-1"

      Examples:
        | mutation                       | event                          |
        | updates the description of     | auth.webhooks.endpointUpdated  |
        | rotates the secret of          | auth.webhooks.secretRotated    |
        | sends a test ping to           | auth.webhooks.testQueued       |
        | deletes                        | auth.webhooks.endpointDeleted  |

    @REQ-EA-1200
    Scenario: An update's audit event names the fields it changed, never their values
      Given the administrator gate allows every action
      And the administrator registers "https://hooks.example.com/billing" for "*" as "billing"
      When the administrator updates "billing" to the URL "https://other.example.com/private-path-token" and the description "sensitive free text"
      Then the audit log holds an "auth.webhooks.endpointUpdated" event for "billing" naming the fields "url" and "description"
      And no audit event mentions "private-path-token" or "sensitive free text"

    @REQ-EA-1201
    Scenario: A refused operation publishes no mutation event
      Given the administrator gate allows every action
      When the administrator tries to register "http://insecure.example.com/x" for "*"
      And the administrator tries to delete an unknown endpoint "fake"
      Then the audit log holds no webhooks mutation event

  # BEH-EA-303 — spec/behaviors/34-webhooks.md; see also BEH-EA-280, ADR-EA-030
  @BEH-EA-303
  Rule: An attempt connects to the address it checked, so a name that flips between check and connect has nothing to flip

    @REQ-EA-1202
    Scenario: An attempt resolves once and connects to that address, keeping the registered name
      Given an endpoint "billing" registered for "auth.user.signedIn" at "https://hooks.example.com:8443/awthaq"
      And a "auth.user.signedIn" event "e1" for user "user-1"
      When event "e1" is queued and delivered
      Then the transport was asked to connect to "93.184.216.34" for the host "hooks.example.com"
      And the name "hooks.example.com" was resolved 1 time

    @REQ-EA-1203
    Scenario: A name that flips to a private address after the first attempt is refused on the second and never contacted
      Given the name "flip.example.com" resolves to "93.184.216.34" and then to "169.254.169.254"
      And an endpoint "flipper" registered for "auth.user.signedIn" at "https://flip.example.com/hook"
      And the receiver answers 503
      And a "auth.user.signedIn" event "e1" for user "user-1"
      When event "e1" is queued and delivered
      And the clock advances 10 seconds
      And the delivery worker runs
      Then the transport was asked to connect exactly 1 time
      And the transport was asked to connect to "93.184.216.34" for the host "flip.example.com"
      And the delivery of event "e1" to "flipper" failed as "blocked"
      And the name "flip.example.com" was resolved 2 times

    @REQ-EA-1204
    Scenario: One private answer among several public ones refuses the attempt before any connection
      Given an endpoint "mixed" registered for "auth.user.signedIn" at "https://mixed.example.com/hook"
      And a "auth.user.signedIn" event "e1" for user "user-1"
      When event "e1" is queued and delivered
      Then the transport was never asked to connect
      And the delivery of event "e1" to "mixed" failed as "blocked"

    @REQ-EA-1205
    Scenario Outline: The transport judges the address it is handed, whatever the caller checked
      When a transport request for "https://hooks.example.com/x" is pinned to "<address>"
      Then the connection is refused as blocked

      Examples:
        | address         |
        | 169.254.169.254 |
        | 10.0.0.5        |
        | 127.0.0.1       |
        | ::1             |
        | fd00::1         |

    @REQ-EA-1206
    Scenario: The pinned transport reaches a real receiver by the pin, with the registered name as Host
      When a delivery for "hooks.example.com" is sent through the pinned transport to loopback
      Then the receiver was reached and saw the Host "hooks.example.com" with its port

  # BEH-EA-304 — spec/behaviors/34-webhooks.md; see also BEH-EA-276, BEH-EA-281
  @BEH-EA-304
  Rule: An endpoint can carry custom request headers, sealed at rest and never returned

    @REQ-EA-1207
    Scenario: The values are sealed at rest and the API returns names only
      Given the administrator gate allows every action
      When the administrator registers "https://hooks.example.com/billing" for "auth.user.signedIn" with the headers "Authorization" holding "Bearer very-secret-token" as "billing"
      Then the stored headers of "billing" do not contain "very-secret-token"
      And reading endpoint "billing" shows the header name "authorization" and never "very-secret-token"

    @REQ-EA-1208
    Scenario: The headers are sent with every delivery beneath the delivery's own
      Given the administrator gate allows every action
      And the administrator registers "https://hooks.example.com/billing" for "auth.user.signedIn" with the headers "Authorization" holding "Bearer very-secret-token" as "billing"
      And a "auth.user.signedIn" event "e1" for user "user-1"
      When event "e1" is queued and delivered
      Then the request to "billing" carries the header "authorization" holding "Bearer very-secret-token"
      And the request to "billing" carries 1 signature

    @REQ-EA-1209
    Scenario Outline: A header the delivery sets itself, or that could change the request, is refused
      Given the administrator gate allows every action
      When the administrator tries to register "https://hooks.example.com/billing" for "*" with the header "<name>" holding "x"
      Then registration is refused as InvalidWebhookEndpoint naming "cannot be customised"
      And no endpoint exists

      Examples:
        | name              |
        | Host              |
        | Content-Type      |
        | Transfer-Encoding |
        | webhook-signature |
        | Cookie            |

    @REQ-EA-1210
    Scenario: A header value that could split the request is refused
      Given the administrator gate allows every action
      When the administrator tries to register "https://hooks.example.com/billing" for "*" with the header "x-team" holding a value split across two lines
      Then registration is refused as InvalidWebhookEndpoint naming "printable ASCII"
      And no endpoint exists
