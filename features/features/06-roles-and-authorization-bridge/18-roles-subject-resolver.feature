# awthaq is pre-implementation (see spec/README.md). Every scenario in
# this file specifies intended behavior of a system that does not exist yet
# — a target the future testing harness (BEH-EA-193..200) is meant to
# execute against, not a record of anything verified today.

@authorization-bridge @roles-subject-resolver
Feature: Roles and the Subject Resolver

  # BEH-EA-137 — spec/behaviors/18-roles-subject-resolver.md. The fail-closed
  # consequence named in the source prose ("every policy that needs a role
  # or permission denies") keeps qadi's own evaluation a black box
  # throughout this file: "qadi's evaluator would return a Deny decision" is
  # a Given, never something derived from role or permission logic here —
  # that logic is qadi's own specification's job.
  @BEH-EA-137
  Rule: The SubjectResolver slot defaults to identity-only

    @REQ-EA-382
    Scenario: The default resolver produces a subject carrying only an id
      Given no plugin overrides the "SubjectResolver" slot
      When "SubjectResolver" resolves a signed-in user's principal
      Then the resulting "AuthSubject" carries only "id"

    @REQ-EA-383
    Scenario: No roles or permissions are invented when no roles-providing plugin is installed
      Given no roles-providing plugin is installed
      When "SubjectResolver" resolves a signed-in user's principal
      Then the resulting "AuthSubject"'s "roles" and "permissions" are empty
      And no role or permission is invented for the subject

    @REQ-EA-384
    Scenario: The default resolver's empty permission set makes a permission-gated policy deny by construction, not by an implicit allow
      Given no roles plugin is installed, so the default "SubjectResolver" produces an "AuthSubject" with empty "roles" and empty "permissions"
      And qadi's evaluator would return a Deny decision for a policy requiring any permission, evaluated against that subject
      When a permission-gated policy is evaluated for that subject
      Then the Deny decision follows from the subject carrying no permissions
      And no implicit "everyone can" default is applied anywhere in awthaq's own resolution

  # BEH-EA-138 — spec/behaviors/18-roles-subject-resolver.md; see also
  # ADR-EA-012.
  # Compile-time contract: the enforcing mechanism is the TypeScript
  # compiler (Validate<P>), not a runtime step. These scenarios record the
  # intended developer-facing outcome; the eventual verification artifact
  # is a type-level test (definitions-of-done.md gate 5).
  @BEH-EA-138 @compile-time
  Rule: `Roles` overrides the slot exclusively

    @REQ-EA-385
    Scenario: A plugin tuple with exactly one SubjectResolver override composes successfully
      Given a plugin tuple containing "Password", "Organization", and "Roles", where only "Roles" overrides the "SubjectResolver" slot
      When "Auth.make" composes the tuple
      Then composition succeeds

    @REQ-EA-386
    Scenario: Two plugins overriding SubjectResolver fail composition, naming both and the slot
      Given a plugin tuple containing "Roles" and "Organization", both overriding the "SubjectResolver" slot
      When "Auth.make" composes the tuple
      Then composition is rejected
      And the rejection names "Roles", "Organization", and "SubjectResolver"

    @REQ-EA-387
    Scenario: The slot conflict is caught at Auth.make and never deferred to the first request
      Given a plugin tuple containing "Roles" and "Organization", both overriding the "SubjectResolver" slot
      When an application attempts to build and run a server from that tuple
      Then no server ever starts, because composition already failed at "Auth.make"
      And the conflict is never surfaced as a first-request runtime error

  # BEH-EA-139 — spec/behaviors/18-roles-subject-resolver.md
  @BEH-EA-139
  Rule: Roles flatten through the DAG once per resolution

    @REQ-EA-388
    Scenario: Assigned roles are flattened into a permissions set once, at resolution time
      Given a user "alice" whose assigned roles carry inherited permissions through qadi's role graph
      When "SubjectResolver" resolves "alice"'s principal
      Then the resulting "AuthSubject" carries a "permissions" set already flattened through the role graph
      And the flattening happens exactly once, during resolution

    @REQ-EA-389
    Scenario: A policy evaluation performs a set-membership test rather than walking the role graph itself
      Given an "AuthSubject" whose "permissions" set was already flattened by "SubjectResolver"
      When a policy evaluation checks whether the subject holds a permission
      Then the check is a membership test against the pre-computed "permissions" set
      And the policy evaluation does not walk the role inheritance graph itself

    @REQ-EA-390
    Scenario: Multiple downstream authorization calls in the same request reuse the same pre-flattened permission set
      Given an "AuthSubject" resolved once for the current request, with permissions already flattened
      When the request's handler makes several separate qadi calls, such as "check", "enforce", and "filter", against that subject
      Then each call performs a set-membership test against the same pre-computed "permissions"
      And none of them triggers a fresh role-graph walk

  # BEH-EA-140 — spec/behaviors/18-roles-subject-resolver.md
  @BEH-EA-140
  Rule: API-key scopes become permissions

    @REQ-EA-391
    Scenario: An ApiKeyPrincipal's configured scopes map directly onto the subject's permissions
      Given an "ApiKeyPrincipal" with keyId "key-1" and scopes ["project:read"]
      When "SubjectResolver" resolves the "ApiKeyPrincipal"
      Then the resulting "AuthSubject" has id "apikey:key-1"
      And "AuthSubject.permissions" equals exactly ["project:read"]

    @REQ-EA-392
    Scenario: SubjectResolver never grants a scope the key was not issued with
      Given an "ApiKeyPrincipal" with scopes ["project:read"]
      When "SubjectResolver" resolves the "ApiKeyPrincipal"
      Then "AuthSubject.permissions" contains no permission beyond "project:read"
      And no additional scope is granted beyond what the key was issued with

    @REQ-EA-393
    Scenario: SubjectResolver does not consult the role graph for an API-key principal
      Given an "ApiKeyPrincipal" with scopes ["project:read"], for a key belonging to a user who also holds roles
      When "SubjectResolver" resolves the "ApiKeyPrincipal"
      Then the resulting permissions come only from the key's own scopes
      And the user's role assignments are not consulted

  # BEH-EA-141 — spec/behaviors/18-roles-subject-resolver.md
  @BEH-EA-141
  Rule: Service principals carry their own scopes

    @REQ-EA-394
    Scenario: A ServicePrincipal's permissions are resolved from its own declared scopes
      Given a "ServicePrincipal" named "reportsService" with declared scopes ["reports:read"]
      When "SubjectResolver" resolves the "ServicePrincipal"
      Then the resulting "AuthSubject" has id "service:reportsService"
      And "AuthSubject.permissions" equals exactly ["reports:read"]

    @REQ-EA-395
    Scenario: A ServicePrincipal's resolved permissions are independent of any user or API-key subject
      Given a "ServicePrincipal" named "reportsService" with its own declared scopes, resolved within a background job with no associated user or API key
      When "SubjectResolver" resolves the "ServicePrincipal"
      Then the resolved permissions come only from the service's own declared scopes
      And no user or API-key subject data is borrowed or consulted

  # BEH-EA-142 — spec/behaviors/18-roles-subject-resolver.md. This
  # requirement describes a property SubjectResolver must support if a
  # principal carries `actingAs` (as the non-normative MOD-EA-015 adoption
  # record envisions an Admin plugin supplying); no Admin plugin or its
  # BEH-EA ids are yet specified anywhere in this repository.
  @BEH-EA-142
  Rule: Impersonation is a static subject attribute

    @REQ-EA-396
    Scenario: A principal's actingAs value is placed on the subject's static attributes
      Given a "UserPrincipal" carrying "actingAs: { type: 'user', id: 'admin-1' }"
      When "SubjectResolver" resolves that principal
      Then the resulting "AuthSubject.attributes.actingAs" equals "{ type: 'user', id: 'admin-1' }"

    @REQ-EA-397
    Scenario: A policy branching on impersonation reads actingAs from static attributes, never through a resolver round-trip
      Given a policy that branches on whether the caller is impersonating another user
      When that policy reads the "actingAs" value for evaluation
      Then it reads "actingAs" from the subject's static "attributes"
      And no "AttributeResolver" round-trip is made to obtain it

    @REQ-EA-398
    Scenario: A subject attribute that can change independently of the session is resolved, not placed statically like actingAs
      Given a subject attribute that can change independently of the current session, such as a subscription plan
      When a policy needs that attribute's current value
      Then it is resolved through "AttributeResolver", not placed statically on the subject the way "actingAs" is

  # BEH-EA-143 — spec/behaviors/18-roles-subject-resolver.md
  @BEH-EA-143
  Rule: No credential resolves to qadi's `anonymous` subject

    @REQ-EA-399
    Scenario: An AnonymousPrincipal resolves to qadi's canonical anonymous subject
      Given "CurrentPrincipal" is "AnonymousPrincipal"
      When "SubjectResolver" resolves the principal
      Then the resulting subject is qadi's canonical "anonymous" subject

    @REQ-EA-400
    Scenario: SubjectResolver never synthesizes an awthaq-specific representation of "no one"
      Given "CurrentPrincipal" is "AnonymousPrincipal"
      When "SubjectResolver" resolves the principal
      Then no awthaq-specific representation of "no one" is synthesized
      And the same "anonymous" subject value that any other qadi-fronted service produces is used

    @REQ-EA-401
    Scenario: The same anonymous subject value reaches qadi's evaluator regardless of which qadi-fronted service produced it
      Given a request with no credential at all
      When "SubjectResolver" resolves "CurrentPrincipal" for that request
      Then the same "anonymous" subject value reaches qadi's evaluator that any other qadi-fronted service would have produced

  # BEH-EA-144 — spec/behaviors/18-roles-subject-resolver.md
  @BEH-EA-144
  Rule: The session view exposes the resolved subject

    @REQ-EA-402
    Scenario: GET /auth/session includes the resolved subject as SubjectDto with plain arrays
      Given a signed-in user "alice"
      When "alice" requests "GET /auth/session"
      Then the response body includes a "subject" field
      And "subject" is encoded as "SubjectDto" with "roles" and "permissions" as plain arrays

    @REQ-EA-403
    Scenario: The subject field is never omitted merely because no roles plugin is installed
      Given a signed-in user "alice" and no roles plugin installed
      When "alice" requests "GET /auth/session"
      Then the response still includes a "subject" field
      And "subject.roles" and "subject.permissions" are present as empty arrays, not omitted

    @REQ-EA-404
    Scenario: The subject field has the same shape whether or not a roles plugin is installed
      Given two applications, one with a roles plugin installed and one without
      When each requests "GET /auth/session" for a signed-in user
      Then both responses include a "subject" field with the same shape
      And the client's subject derivation can rely on that field being present regardless of which plugins are installed
