---
name: cli-tool-auth-specialist
title: CLI Tool Auth Specialist
type: archetype
ecosystem: Framework Integration
---

# CLI Tool Auth Specialist

## Role

This specialist implements authentication for command-line tools that cannot host a browser redirect callback the way a web app can. Day to day work includes implementing OAuth device-authorization-grant flows, choosing secure local token storage per OS, and handling token refresh/expiry gracefully within a CLI's non-interactive execution model.

## Why relevant to effect-auth

`packages/cli` needs a login flow that works from a terminal with no listening HTTP port and often no local browser context (e.g., over SSH). This specialist designs that flow — most likely an OAuth 2.0 device authorization grant against effect-auth's `packages/oauth`, where the CLI displays a code and polls a token endpoint while the user completes auth in any browser — and decides how the resulting long-lived credential is stored locally (OS keychain integration where available, encrypted file fallback otherwise) rather than as a plaintext token in a dotfile.

## Core expertise

- OAuth 2.0 device authorization grant (RFC 8628) implementation and polling semantics
- Secure local credential storage across macOS (Keychain), Linux (Secret Service/libsecret), and Windows (Credential Manager), with a safe fallback
- Token refresh and re-authentication UX for long-lived, infrequently-run CLI sessions
- Scripting/non-interactive auth support (API keys, service tokens) for CI usage of the CLI
- Handling auth failures gracefully in a non-interactive/scripted context (clear exit codes, actionable error messages)

## Hiring rubric

**Must demonstrate**
- Can describe the device authorization grant flow end-to-end and explain why it's preferred over a locally-hosted redirect listener for a CLI
- Knows at least one real OS-native secure storage mechanism (Keychain, libsecret, Credential Manager) and won't default to a plaintext token file
- Understands the difference between an interactive human login flow and a non-interactive CI/service-token flow, and designs for both

**Strong signal**
- Has implemented device-flow login in a real CLI tool and can describe how they handled polling backoff and code expiry
- Can explain a sane fallback story for platforms/environments without a system keychain (headless Linux CI, containers)

**Red flags**
- Defaults to writing a raw access token into a world-readable dotfile with no OS-level protection considered
- Proposes a locally-hosted redirect-callback server as the only login mechanism, breaking over SSH/headless environments

## Interview probes

- "Design the login flow for `packages/cli` against effect-auth's `packages/oauth`, assuming the user may be on a headless remote server over SSH. What grant type do you use and why?"
- "Where do you store the resulting long-lived credential on macOS versus a headless Linux CI runner, and what do you do when no secure OS keychain is available?"
- "How does the CLI's auth handling differ when invoked interactively by a human versus non-interactively in a CI pipeline using a service token?"
