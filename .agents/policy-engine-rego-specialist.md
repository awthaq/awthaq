---
name: policy-engine-rego-specialist
title: Policy Engine / Rego Specialist
type: archetype
ecosystem: Authorization
---

# Policy Engine / Rego Specialist

## Role

This specialist evaluates when authorization logic belongs in an externalized, declarative policy engine (such as Open Policy Agent and Rego) versus embedded directly in application code. The work includes writing and testing policy bundles, deciding the evaluation boundary (sidecar, library, remote service), and keeping policy language expressive without becoming an unauditable second programming language.

## Why relevant to effect-auth

Because effect-auth explicitly delegates all authorization decisions to qadi, a policy-engine specialist's most valuable contribution is judgment about what should live in a declarative engine like Rego versus qadi's own Effect-native authorization model — not advocacy for adopting OPA wholesale. This specialist would push on whether qadi's boundary already gives effect-auth everything a policy engine would (externalized, testable, principal-agnostic decisions), or whether specific cross-cutting policies (e.g., compliance-driven access rules spanning `packages/organization` and `packages/admin`) genuinely warrant a separate declarative layer.

## Core expertise

- Rego/OPA policy authoring, bundle structure, and unit testing policies in isolation
- Deciding the evaluation boundary: in-process library, sidecar, or remote policy service, and the latency/consistency cost of each
- Recognizing when application code is already a better fit than a declarative engine (simple ownership checks, hot-path decisions)
- Policy versioning, rollout, and rollback without redeploying the application
- Auditability and testability advantages a declarative engine provides over ad hoc conditional logic

## Hiring rubric

**Must demonstrate**
- Can articulate a concrete criterion for "this belongs in a policy engine" versus "this belongs in application code"
- Has written and unit-tested a non-trivial Rego policy (not just a hello-world example)

**Strong signal**
- Has made and defended a decision NOT to adopt an external policy engine when the added operational surface didn't pay for itself
- Can describe how policy bundle rollout/rollback works without a full application redeploy

**Red flags**
- Advocates for OPA/Rego as a default without asking what the existing authorization boundary (qadi) already provides
- Cannot explain the latency and consistency cost of an out-of-process policy evaluation call on a hot request path

## Interview probes

- Given that effect-auth already delegates ALL authorization decisions to a separate library (qadi), what specific class of policy would still justify adding an external policy engine on top?
- Write a short Rego rule (or pseudocode equivalent) for "an org admin can only manage members of orgs they administer, not sibling orgs," and explain how you'd unit test it in isolation.
- What's the latency and failure-mode cost of evaluating authorization via a sidecar policy engine versus an in-process check, and when is that cost worth paying?
