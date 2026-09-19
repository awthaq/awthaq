---
name: mobile-native-auth-specialist
title: Mobile/Native Auth Specialist
type: archetype
ecosystem: Framework Integration
---

# Mobile/Native Auth Specialist

## Role

This specialist implements authentication for native mobile applications, covering secure on-device token storage, OAuth redirect flows without a browser-address-bar context, and platform-native biometric/passkey APIs. Day to day work includes integrating iOS Keychain and Android Keystore, handling deep-link-based OAuth callbacks, and bridging platform passkey/WebAuthn APIs to a backend auth service.

## Why relevant to effect-auth

effect-auth's `packages/oauth` and `packages/passkey` implement the server-side halves of OAuth and WebAuthn/passkey flows, but a native mobile client consuming those APIs needs platform-specific handling this specialist owns: OAuth authorization-code flows must complete via a deep link or universal link back into the app rather than a same-tab browser redirect, and passkey creation/assertion must go through the OS-native WebAuthn API (not a browser) before the resulting attestation is sent to effect-auth's `packages/passkey` verification endpoint. This specialist also decides how session tokens issued by effect-auth are stored on-device (Keychain/Keystore) rather than in less secure storage.

## Core expertise

- iOS Keychain and Android Keystore APIs for secure credential/token storage
- OAuth 2.0 / PKCE flows adapted for native apps (deep links, universal links, custom URL schemes, `ASWebAuthenticationSession`/Chrome Custom Tabs)
- Native WebAuthn/passkey APIs (iOS Associated Domains, Android Digital Asset Links) and how their attestation payloads map to a server-side verification contract
- Token refresh strategy on mobile (background refresh, handling app backgrounding/foregrounding)
- Threat modeling for on-device secret storage (jailbreak/root detection considerations, biometric-gated access)

## Hiring rubric

**Must demonstrate**
- Can explain why a mobile OAuth flow needs PKCE and a deep-link callback instead of a simple redirect, and how that differs from a web OAuth flow
- Knows the platform APIs (Keychain, Keystore) for secure token storage and why storing tokens in plain `UserDefaults`/`SharedPreferences` is a real vulnerability, not a style nit
- Understands the domain association requirements (Associated Domains / Digital Asset Links) that native passkey support depends on

**Strong signal**
- Has integrated native passkey creation/assertion end-to-end against a server-side WebAuthn verification endpoint like `packages/passkey`
- Can describe handling token refresh correctly across app backgrounding/termination without forcing a re-login

**Red flags**
- Proposes storing effect-auth session tokens in plain app storage "since the app is sandboxed anyway"
- No familiarity with PKCE or proposes implicit-grant-style flows for a native app

## Interview probes

- "Walk me through the full OAuth flow from a native iOS app hitting effect-auth's `packages/oauth`, including how the redirect gets back into the app and how PKCE prevents interception."
- "How would you wire native passkey creation on Android to effect-auth's `packages/passkey` verification endpoint, including the Digital Asset Links setup it depends on?"
- "Where exactly do you store the session token effect-auth issues, and what's your threat model for a compromised or jailbroken device?"
