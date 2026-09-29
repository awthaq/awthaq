@cross-cutting @rate-limiting
Feature: Rate Limiting

  # BEH-EA-105 — spec/behaviors/14-rate-limiting.md; see also ADR-EA-010.
  @BEH-EA-105
  Rule: The RateLimiter port

    # @skip: blocked by @awthaq/two-factor (P15/THS-001), a placeholder package today; the same property for the shipped
    # password plugin is asserted by REQ-EA-279 (it reaches the port only, with no store in its graph).
    @skip
    @REQ-EA-278
    Scenario: RateLimiter is a port the application provides, not one a plugin bundles
      Given a plugin "two-factor" that needs rate limiting for its "verify" endpoint
      When "two-factor" is composed into an application
      Then "two-factor" requires "RateLimiter" as a port in its Layer's requirements
      And "two-factor" does not bundle its own limiter implementation

    @REQ-EA-279
    Scenario: A plugin must not bypass the RateLimiter port to enforce a limit directly against a store
      Given a plugin wanting to throttle one of its own endpoints
      When it enforces that limit
      Then it does so only by calling "RateLimiter.consume"
      And it does not read or write a rate-limit count directly against any backing store itself

    @REQ-EA-280
    Scenario: The default fixed-window algorithm fails once the limit is exceeded within the current window
      Given a "RateLimiter" configured with "limit" 3 and "window" "10 seconds" for key "alice"
      And "alice" has called "consume" 3 times within the current window
      When "alice" calls "consume" a 4th time within that same window
      Then the 4th call fails with "RateLimited"

    @REQ-EA-281
    Scenario: The default fixed-window algorithm accepts up to twice the limit across a window boundary
      Given a "RateLimiter" configured with "limit" 3 and "window" "10 seconds" for key "alice"
      When "alice" consumes 3 times just before the window boundary and 3 more times just after it
      Then all 6 calls succeed
      And this is the documented, accepted cost of the fixed-window default

    @REQ-EA-282
    Scenario: check-then-increment is one atomic operation against the backing store
      Given a "RateLimiter" backed by a store with an atomic compare-and-increment primitive
      When two concurrent "consume" calls for the same key race at exactly the limit boundary
      Then at most "limit" calls succeed
      And the store's atomicity prevents both calls from observing a pre-increment count under the limit

    @REQ-EA-283
    Scenario: A store without an atomic check-then-increment primitive is not a legal RateLimiter implementation
      Given a candidate "RateLimiter" implementation whose "consume" reads the current count, decides "not yet at the limit" in application code, and only then writes the incremented count back
      When two concurrent "consume" calls for the same key race
      Then both calls can observe a pre-increment count under "limit" and both proceed
      And this implementation does not honor "consume"'s contract, so it is not a legal implementation of the "RateLimiter" port

    @REQ-EA-284
    Scenario: RateLimiter.layer fails open by default when its backing store is unreachable
      Given "RateLimiter"'s backing store is unreachable
      When "consume" is called
      Then "consume" succeeds and the request proceeds unthrottled
      And no request fails with an unrelated 5xx server error merely because the rate-limit store is unavailable

    @REQ-EA-285
    Scenario: An application may configure RateLimiter to fail closed instead of the fail-open default
      Given an application that provides a "RateLimiter" Layer configured with "onStoreUnavailable: \"reject\""
      And its backing store is unreachable
      When "consume" is called
      Then "consume" fails with "RateLimited" or a distinct outage error
      And the request does not proceed

  # BEH-EA-106 — spec/behaviors/14-rate-limiting.md
  @BEH-EA-106
  Rule: The RateLimited error

    @REQ-EA-286
    Scenario: Exceeding a configured limit fails with a typed RateLimited error carrying retryAfterMillis
      Given a "RateLimiter" configured with "limit" 3 and "window" "10 seconds"
      And the limit has already been reached within the current window
      When a further "consume" call is made within that window
      Then the call fails with "RateLimited"
      And the failure carries a "retryAfterMillis" field

    @REQ-EA-287
    Scenario: A rate-limit rejection never surfaces as a generic or untyped error
      Given the same exceeded limit
      When the call fails
      Then the failure is not a generic or untyped error
      And a client can render a "try again in n seconds" message from "retryAfterMillis" alone, without parsing any message string

    @REQ-EA-689
    Scenario: An HTTP client receives a 429 RateLimited body carrying retryAfterMillis
      Given the password plugin's sign-in rule enforced by a real limiter over the memory store
      When "alice" attempts to sign in with a wrong password more often than the rule allows
      Then the refused request is a 429 whose body is a RateLimited value carrying retryAfterMillis

  # BEH-EA-107 — spec/behaviors/14-rate-limiting.md
  @BEH-EA-107
  Rule: A plugin may only rate-limit its own endpoints

    @REQ-EA-288
    Scenario: A plugin's rate-limit rule naming its own contract group composes successfully
      Given plugin "invite" contributes a rate-limit rule naming group "invite"
      When the application is composed
      Then the rule composes successfully

    @REQ-EA-289
    Scenario: A plugin's rate-limit rule naming another plugin's group is rejected at composition time
      Given plugin "invite" contributes a rate-limit rule naming group "password"
      When the application is composed
      Then composition is rejected
      And the rejection names "invite" as the contributing plugin and "password" as the group it does not own

  # BEH-EA-108 — spec/behaviors/14-rate-limiting.md
  @BEH-EA-108
  Rule: Key strategies

    # @skip: PV-240 — the strategy names "principal" and "ip" are registry metadata only; nothing derives a bucket key from
    # them (each plugin computes its keys itself through RateLimits.enforce, e.g. PasswordRateLimits), so there is no derivation
    # to observe until a resolver exists.
    @skip
    @REQ-EA-290
    Scenario Outline: A rate-limit rule keys its bucket using a built-in strategy
      Given a rule with key strategy "<strategy>"
      And a signed-in user "alice"
      When "consume" derives a bucket key for a request from "alice"
      Then the bucket key is derived from <source>

      Examples:
        | strategy  | source                              |
        | principal | "alice"'s CurrentPrincipal           |
        | ip        | the request's network origin         |

    @REQ-EA-291
    Scenario: A rate-limit rule may key its bucket on an explicit deterministic function of the request
      Given a rule with a custom key function deriving "signin:${email}" from the sign-in payload
      When "consume" derives a bucket key for a sign-in request
      Then the bucket key is the deterministic value that function computes for that request

    # @skip: compile-time (the RateLimitKey type admits only the two strategies or a function); asserted by tsc via
    # @ts-expect-error in packages/core/test/RateLimits.types.test.ts.
    @skip
    @REQ-EA-292
    Scenario: A rule must not key on a caller-controlled arbitrary value without the plugin author opting in explicitly
      Given a plugin author declaring a rule using only the built-in "principal" or "ip" strategies
      When that rule derives a bucket key
      Then neither built-in strategy allows keying on an arbitrary caller-supplied string such as an unvalidated header
      And only an explicit custom key function lets the author opt into deriving a key from request-supplied data

    @REQ-EA-293
    Scenario: Keying only on IP address can collectively throttle an entire NATed office
      Given a rule keyed by "ip"
      When many distinct users behind the same network address exceed the limit together
      Then all of them share the same bucket and are throttled together

    @REQ-EA-294
    Scenario: Keying on an attacker-chosen value makes the limiter's bucket space attacker-controlled
      Given a custom key function that keys on an unvalidated email field from the request payload
      When an attacker varies the email value on each request
      Then the attacker obtains a fresh bucket for every request, defeating the limit's purpose

  # BEH-EA-109 — spec/behaviors/14-rate-limiting.md
  @BEH-EA-109
  Rule: Swappable stores

    @REQ-EA-295
    Scenario: Providing a second RateLimiter Layer shadows the first rather than merging with it
      Given "RateLimiter.layer" is first provided with "RateLimiter.layerStoreMemory"
      And a second "Layer.provide" then supplies "RateLimiter.layerStoreRedisConfig(...)"
      When the application is composed
      Then the Redis-backed implementation is the one in effect
      And the memory-backed implementation is entirely shadowed, not merged

    @REQ-EA-296
    Scenario: awthaq never attempts to combine two RateLimiter store implementations into one
      Given two Layers are provided for the "RateLimiter" port
      When the application is composed
      Then only one implementation of "RateLimiter" exists in the composed graph
      And no attempt is made to combine both stores' behavior into a single implementation

  # BEH-EA-110 — spec/behaviors/14-rate-limiting.md
  @BEH-EA-110
  Rule: Built-in rules shipped by core plugins

    # @skip: blocked by @awthaq/two-factor (P15/THS-001), a placeholder package today; the shipped-default-rules claim is
    # asserted for the password plugin by REQ-EA-298.
    @skip
    @REQ-EA-297
    Scenario: An official plugin ships a default rate-limit rule for a brute-force-prone endpoint
      Given the official "two-factor" plugin's "verify" endpoint
      When "two-factor" is installed with no application-authored rate-limit configuration
      Then "/two-factor/verify" is rate limited to 3 attempts per 10 seconds by a rule the plugin itself ships

    @REQ-EA-298
    Scenario: An application does not have to add rate limiting itself to get a sane default on brute-force-prone endpoints
      Given an application installing the official "password" plugin with no rate-limit rules of its own
      When the application is composed
      Then its sign-in and password-reset-request endpoints are already rate limited by rules those plugins ship
      And the application required no additional rate-limiting code to get that protection

  # BEH-EA-111 — spec/behaviors/14-rate-limiting.md
  @BEH-EA-111
  Rule: Registry ordering

    @REQ-EA-299
    Scenario: Rate-limit rules are listed in dependency order, then declared order, then rule id
      Given rate-limit rules contributed by plugins with a dependency relationship, some declaring an explicit "order", and rule ids as the final tiebreaker
      When the rate-limit registry is read for its resolved rule list
      Then the listing is ordered by plugin dependency order first, then by declared "order", then by rule id

    @REQ-EA-300
    Scenario: The rate-limit registry uses the same three-key ordering discipline as the hook and event registries
      Given the resolved order of hook taps and the resolved order of rate-limit rules for the same plugin tuple
      When both are computed
      Then both follow the identical three-key ordering: dependency order, then declared "order", then id

  # BEH-EA-112 — spec/behaviors/14-rate-limiting.md
  @BEH-EA-112
  Rule: Testing with a permissive limiter

    @REQ-EA-301
    Scenario: TestAuth.layer provides a RateLimiter that never rejects under ordinary test iteration counts
      Given "TestAuth.layer(plugins)" is used to compose a test application
      When a test signs in 50 times in a loop
      Then none of the 50 attempts is rejected by "RateLimited"

    @REQ-EA-302
    Scenario: A test suite does not have to reconfigure or mock rate limiting to run a loop of sign-in attempts
      Given a test using "TestAuth.layer(plugins)" with no rate-limiting-specific setup
      When the test exercises a loop of repeated sign-in attempts
      Then it requires no additional reconfiguration or mocking of "RateLimiter" to do so

    @REQ-EA-303
    Scenario: A test wanting to exercise rate limiting specifically provides its own stricter RateLimiter Layer
      Given a test that wants to verify rate-limiting behavior itself
      When that test provides its own "RateLimiter" Layer configured with a strict limit, overriding "TestAuth.layer"'s permissive default
      Then that test's stricter limit is the one in effect for its scenario
