# Telemetry

The telemetry integration is a cross-cutting service, not a plugin: it is
constructed once per auth instance (and independently, per CLI invocation)
and offered a single operation — `publish(event)` — whose entire contract
is gated by one invariant that must hold at every call site, with no
exception: **no telemetry event is ever transmitted unless the opt-in
precondition holds at the moment `publish` is called.** This document
specifies that gate precisely, and separately, specifies as a **disclosure**
(not an implementation) exactly what shape of data an emitted event
carries — because for a telemetry contract, the disclosure *is* the
contract that matters to a deployer deciding whether to opt in.

---

## 1. The opt-in/opt-out state machine

```
                          ┌───────────────────────────────┐
                          │   instance constructed         │
                          │   (telemetry service built)     │
                          └───────────────┬─────────────────┘
                                          │
                     evaluate: is telemetry enabled?
              ┌───────────────────────────┼───────────────────────────┐
              │                           │                           │
   explicit per-instance          environment-variable          neither set
   opt-in configured               opt-in set                  (the default)
   (enabled: true)               (BETTER_AUTH_TELEMETRY)
              │                           │                           │
              └─────────────┬─────────────┘                           │
                            ▼                                         ▼
                    is this a test run?                        DISABLED
              (and test-context bypass NOT set)                (publish is a
                    │yes            │no                         permanent
                    ▼               ▼                            no-op for
                DISABLED        ENABLED                     the life of this
             (opt-in is             │                            instance)
             suppressed              │
             during tests            ▼
             even if set)    every publish() call now
                              actually transmits
                              (subject to §2)
```

**Requires:** for the ENABLED state to be reached, at least one explicit
opt-in signal must be present (a per-instance configuration flag, or an
environment variable) — the **absence** of both is the documented default,
and the default is **disabled**. There is no implicit, silent, "phone home
unless you say no" posture anywhere in this contract: opt-in is
affirmative, not opt-out.

**Ensures:** once the enabled/disabled determination is made at
construction time, it is fixed for the lifetime of that constructed
instance — a later change to the environment variable does not retroactively
enable or disable an already-constructed instance's telemetry.

**Invariant (the one that matters most):** `publish` is a **provable
no-op** whenever the enabled determination is false, *and* whenever there
is no configured transmission destination at all (no endpoint and no
custom transport supplied) regardless of the enabled determination — the
absence of a destination is itself an independent, unconditional gate. Two
independent conditions must both hold for any network transmission (or
custom-transport invocation) to occur: (1) opt-in resolved true, and (2) a
destination is actually configured.

**On violation:** there is no "violation" state reachable through normal
use — the contract is constructed so that failing either gate degrades to
silence, never to an error and never to a fallback transmission. The only
way this invariant could be broken is a defect in the gating logic itself,
which would be a **SUPPLIER**-blamed contract violation (better-auth's own
telemetry service failing to honor its own documented default).

### 1.1 The test-environment carve-out is unconditional

**Ensures:** even when opt-in is otherwise satisfied, a run detected as a
test run is treated as disabled **unless** the caller explicitly requests
that the test carve-out itself be bypassed (a capability reserved for the
telemetry system's own test suite, not for ordinary deployer configuration).
This exists so that a project's own test runs — which may set the same
environment variables as production for unrelated reasons, or run in CI
with production-like configuration — never contribute telemetry noise.

**Invariant:** this carve-out can only ever **narrow** (never widen) when
telemetry actually transmits, relative to the opt-in gate alone — it never
causes transmission that the opt-in gate alone would have suppressed.

---

## 2. Debug mode is a redirection of the transmission target, not a bypass of the gate

**Ensures:** when a separate debug flag is set (per-instance configuration
or its own environment variable), a `publish` call that has already
cleared both gates in §1 does not perform a network transmission at all;
instead the fully-assembled event is written to the local operator-facing
log. **Invariant:** debug mode never causes an event to be constructed or
observed that would not otherwise have cleared the opt-in gate — it only
substitutes *where* an already-authorized event goes, from "over the
network to the configured endpoint" to "into this process's own log
output." This is deliberately safe for a deployer to enable independently
of opt-in status, because it can never cause data to leave the process it
would not already have left.

---

## 3. Anonymous identity: what is derived, and what never appears in the clear

**Ensures:** every transmitted event is attributed to a single stable
**anonymous identifier**, derived once per process and reused for every
subsequent event in that process's lifetime, computed by irreversibly
hashing (not encoding, not truncating — a one-way cryptographic digest)
one of, in priority order: (a) the local project's own declared name
combined with its configured base URL, (b) the local project's declared
name alone, (c) the configured base URL alone, or, if none of those
inputs is available, (d) a freshly generated random identifier with no
relationship to any project-identifying value at all.

**Invariant:** the project name and base URL themselves are **never**
transmitted in the clear anywhere in the event payload — only their
one-way hash digest is. This is the specific disclosure guarantee this
service makes: an operator inspecting network traffic (or the receiving
end) can distinguish "the same project across multiple events" from "a
different project," but cannot recover the project's name or URL from the
identifier alone.

---

## 4. Disclosure: exactly what shape of data a transmitted event carries

This section is a **disclosure of contract, not an implementation
description** — precisely which pieces of information leave the process
when the gates in §1–§2 are cleared, stated at the level a deployer needs
to make an informed opt-in decision.

**Ensures:** every event of the initialization kind carries, at most, the
following classes of information, and nothing else:

1. **Configuration shape, never configuration values.** For every
   deployer-configurable area of the auth instance (email verification,
   password policy, session behavior, account-linking behavior, rate
   limiting, cookie behavior, database hooks, and each installed social
   provider's *non-secret* option surface), the event reports **whether a
   given option was set and to what class of value** (a boolean presence
   flag, a numeric duration, an enum choice, a count) — never a secret,
   never a callback's implementation, never a literal string a deployer
   configured that could itself be sensitive (for example, a configured
   cookie name prefix is disclosed only as "was a custom value supplied?",
   a boolean, never the value itself).
2. **Which plugins are installed, by their public identifier only** — the
   list of installed plugin identifiers, not any plugin-specific
   configuration value beyond what plugin ships its own instrumentation
   for.
3. **Runtime environment facts, not user or tenant data:** the detected
   JavaScript runtime and its version; the detected database driver family
   and its version (name and version only — never a connection string,
   host, or credential); the detected web framework and its version; the
   detected package manager; whether the process is running in a test,
   CI, development, or production posture; coarse system facts (operating
   system platform/release/architecture, CPU count/model/speed, total
   memory, whether the process appears to run inside a container or a
   Windows-Linux-subsystem environment, whether output is attached to an
   interactive terminal); and, where recognizable from well-known hosting
   platform environment signals, which hosting vendor the process appears
   to run on.
4. **The anonymous project identifier from §3, and nothing that could
   reverse it.**

**Invariant:** at no point does an initialization event contain any
end-user data, any record from any application entity (no user, session,
account, or verification row), any secret (hashing/signing/encryption
keys, API keys, OAuth client secrets, database credentials), or any raw
configured string value that is not itself drawn from the fixed, small
enumeration of "structural fact about how the instance is configured"
described above. A configuration field whose *content itself* would be
sensitive if disclosed (for example, a configured cookie name) is
represented in the payload only as a presence boolean, by explicit
design — this is called out because it is the one place in the schema
where "did the deployer customize this?" is disclosed even though "to
what?" deliberately is not.

**Ensures (CLI events, in addition to the above):** the CLI's own telemetry
events (see `04-cli.md`) carry the same configuration-shape payload plus
one additional fact: the outcome of the CLI command that produced the
event (for example, "schema generation produced no changes," "migration
was aborted by the operator," "migration completed") — never the generated
schema's or migration's actual file contents.

**On violation:** if any event payload were ever found to include a value
outside this disclosed shape (a secret, an end-user record, a raw
configured string that is not a structural fact), that is a
**SUPPLIER**-blamed defect in the telemetry disclosure contract itself —
this document is the specification such an event would be judged against.
