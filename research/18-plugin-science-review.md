# Plugin Systems — A Scientific Literature Review for Effect Native Auth

Version 1.0 — 2026-09-12. This article synthesizes the scientific corpus built in `research/13..17-*.md` into design evidence for the awthaq plugin compiler (PRD.md §9, §12, §34–36). Practitioner prior art lives in `research/09-plugin-architecture.md`; this document is the peer-reviewed counterpart.

**Method.** Five literature sweeps ran in parallel (foundations/OS kernels; platform case studies; extensibility theory; API evolution; capability security). Every entry in every file was verified against a primary source this session (ACM DL, IEEE Xplore, USENIX, Crossref DOI resolution, arXiv API, publisher/author pages, MIT Press, HBR). Papers recalled but not verifiable were dropped or flagged; wrong citations surfaced during verification were corrected in-file (e.g., SLIC is USENIX ATC 1998, not 1996; Jangda et al. is ATC 2019, not PLDI; the hypothesized ".NET breaking-APIs" study does not exist and is flagged as such in 16). Gray-literature canon (OSGi spec, semver.org, Cargo rules, Fowler) is explicitly labeled `non-academic`.

---

## 1. The corpus at a glance

| File | Domain | Entries | Verified sources | Anchor studies |
|---|---|---|---|---|
| `13-modularity-foundations.md` | Modularity & OS extensibility classics | 28 | 48 | Parnas 1972; Baldwin & Clark 2000; SPIN & Exokernel (SOSP 1995); Small & Seltzer 1996/1998; SFI 1993 |
| `14-plugin-platforms.md` | Eclipse/OSGi/Firefox/Chrome/VS Code/WordPress empirical studies | ~50 | primary-linked | Gruber+ IBM SJ 2005; Bogart FSE 2016; Businge SCAM 2012; Dig & Johnson 2006; Hsu 2024 |
| `15-extensibility-theory.md` | CBSE, contracts, pub/sub, reflection, product lines, feature interaction | 38 | 50 | Beugnard+ 1999; Keck & Kuehn 1998; Zave & Jackson; Czarnecki & Eisenecker 2000; Eugster+ CSUR 2003 |
| `16-api-evolution.md` | API evolution, semver, dependency ecosystems | 30 | 61 | Ochoa EMSE 2022; Sawant EMSE 2019; McDonnell ICSM 2013; Decan & Mens; Pinckney MSR 2023; Zimmermann USENIX Sec 2019 |
| `17-capability-security.md` | Capability security, isolation, marketplace supply chain | 39 | 47 | Dennis & Van Horn 1966; Miller 2006; Birgisson NDSS 2014; Jangda ATC 2019; UntrustIDE NDSS 2024 |

Total: ~185 annotated entries, ~250 verified primary links.

## 2. Foundations: extensibility has a 50-year-old design manual (13)

The deepest finding: **every load-bearing decision in the awthaq PRD already has a canonical scientific treatment**, and they all point the same way.

- **Parnas (1972) information hiding + Baldwin & Clark (2000) design rules:** the plugin contract is the "design rules" document of the ecosystem. Required fields must be minimal (`id`, `apiVersion`); everything else optional and declarative; freezing the contract early is the highest-leverage act in the project. Plugins are options priced against stable rules.
- **Microkernel pattern (POSA 1996) + Liedtke (1995) + SPIN/Exokernel (SOSP 1995):** minimal core, policies in extensions. The kernel papers also validate the PRD's compile-time choice — SPIN proved language-level (type-safe) extension safe *without* hardware isolation; the 1996 extension-technology comparison (Small & Seltzer) prices exactly the axis PRD ADR-005 sits on.
- **J-Kernel capability discipline:** namespaced capability strings + `Context.Tag` requirements reproduce the object-capability property — plugins hold references to providers, never global mutable registries; `provides`/`conflicts` is the compiler checking one authority isn't held twice (→ Q21/Q23).
- **SFI (1993):** safe code execution without hardware support is the ancestor of every future plugin-sandbox story (see §6).

## 3. Platform case studies: what ecosystems actually measured (14)

Empirical SE studied the big plugin ecosystems; the numbers are a warning label for ours.

- **Declared ≠ real.** Eclipse shipped documented breaking changes without bumping majors (Bogart FSE 2016); compatibility outcomes varied 96.7% vs 50.2% by *what plugins actually import* (Businge ICSM/SCAM 2012). → Integer `apiVersion` stays the cheap structural gate, but the registry must *measure* compatibility by compiling plugins against supported generations (`@awthaq/test` harness, Q31) — never trust declarations alone.
- **Best practices violated everywhere.** Even well-documented modularity rules (OSGi/Eclipse) were violated at scale (Ochoa MSR 2018); dependency depth converts small failures into ecosystem events (Zimmermann NDSS 2019). → Enforce `requiresPlugins`/`requiresCapabilities` as **compile errors**, not docs.
- **Deprecation is a compiler feature.** Firefox 57's hard cut vs MV3's slipping deadlines show the two failure modes of deprecation UX; >80% of Java API breaks are codemodable refactorings (Dig & Johnson 2006). → Every deprecation ships with a codemod in the same release (→ Q100).
- **Registries are attack surface.** 60% of Chrome Web Store items never updated; half of vulnerable extensions persisted 2 years (Hsu 2024); 21 malicious VS Code extensions totaled >6M installs (UntrustIDE NDSS 2024). → Update-delta review, mechanical registry gates, and "official plugin" curation are evidence-backed requirements, not marketing (→ Q7).
- **Correction of record:** the initially hypothesized O'Connell Eclipse paper could not be verified and is omitted; the canonical verified architecture paper is Gruber/Hargrave/McAffer/Rapicault/Watson, IBM Systems Journal 44(2), 2005.

## 4. Theory: contracts, feature interaction, product lines (15)

- **Contracts are a ladder, not a boolean (Beugnard et al. 1999):** level 1 syntax (enforced in `definePlugin()`), level 2 behavior (compiler), level 3 synchronization/ordering (declared + validated), level 4 QoS (metadata). The plugin contract-test harness asserts conformance at every level (→ Q20/Q23/Q31).
- **Plugin conflicts = the feature-interaction problem** (Keck & Kuehn 1998; Zave & Jackson): split *detection* from *resolution*. Offline detection for route keys (Q24), schema columns (Q25), migration ordering (Q26), hook-veto legality (Q27); resolution policies (priority, topo order, fail-isolation) only where detection would reject valid ecosystems. Fixed composition rules + typed interfaces make interactions enumerable — which is precisely the PRD's "plugin compiler" section restated in 1990s telecom vocabulary.
- **A plugin set is a product-line configuration** (Czarnecki & Eisenecker 2000; FOSD): `Auth.make({plugins})` is feature-model configuration; the compiler is the configurator; the capability registry is the feature diagram (→ Q5/Q23/Q30).
- **Pub/sub taxonomy (Eugster et al., CSUR 2003):** the event system (Q13) inherits 20 years of decided tradeoffs — typing, filtering, delivery semantics; event-schema evolution tactics apply to event payloads (Q49/Q100).

## 5. API evolution: the numbers behind `apiVersion` (16)

Verified policy table (see 16 for full citations):

| Question | Number |
|---|---|
| Semver claims that break | **20.1%** of non-major Maven releases ship ≥1 breaking change (Ochoa EMSE 2022); **28.6%** in Go (Li ASE 2023) |
| Declared break = actual break? | Only **7.9% of clients** impacted (most BCs hit unused API) — impact analysis, not surface diff, is the planner's job |
| Deprecation reaction | Consumers predominantly **do not react** (Sawant EMSE 2019; 297K projects) — doc-only deprecation is ignored |
| Adoption lag vs cadence | Android: 3-month cadence vs **16-month median** client lag (McDonnell ICSM 2013) — keep deprecated surface ≥2 minor cycles |
| Security flow | **90.09%** of security updates flow rapidly when semver is used correctly (Pinckney MSR 2023) — automate correct bumps |
| Ecosystem trust | Avg npm install trusts **79 packages / 39 maintainers** (Zimmermann USENIX Sec 2019) — keep official-plugin dependency fan-in small |

Derived policy: integer `apiVersion` is the **load-bearing** compatibility contract (compile-time exact match); semver ranges are advisory metadata only; Plugin API ships 1.0.0 — never 0.x (0.y.z conventions are measured chaos, Decan & Mens); deprecate in minor + codemod, remove only in major; migration outputs hash-stamped and byte-deterministic (Benedetti ICSE 2025); Cargo's `cargo-semver-checks` is the aspiration grade: *checked*, not documented.

## 6. Security: capabilities before sandboxing (17)

Five decades of security science compress into an ordered playbook for running third-party plugin code *without* a sandbox — the evidence-backed version of PRD §48:

1. Static declarative plugin surface, inspectable without execution (Chrome MV3 lesson).
2. Mechanically enforced least-privilege capability contracts — computed from use, never self-declared (POLA measurement studies: Picazo-Sanchez 2022, Eriksson 2022).
3. Compiler as unforgeability mechanism: capability strings + exclusive `provides`/`conflicts` give object-capability discipline at build time (capability canon: Dennis & Van Horn 1966 → Levy 1984 → Miller 2006).
4. Registry gates: provenance/attestation + contract tests + malware-class detection (marketplace studies: UntrustIDE NDSS 2024; Ohm DIMVA 2020; Ladisa S&P 2023 taxonomy).
5. Secrets-leakage assumption: prefix-visible + hashed API keys (macaroons lineage, Birgisson NDSS 2014 — also feeds Q46/Q59 token design: attenuation-only, purpose-bound).
6. Sandbox is a **v2 seam, not a v1 need**: SFI 1993 → CFI 2009 → XFI 2006 → Wasm (Haas PLDI 2017) → Swivel/ATC-2019-lineage, with a measured price (Jangda et al.: 45–56% perf overhead). Document the seam (Wasm plugin target + capability-strings-as-imports), ship the playbook.

## 7. Synthesis — seven design laws for the awthaq plugin compiler

1. **Freeze the design rules early** (Parnas/Baldwin): minimal required contract, declarative everything else, visible deprecation rules.
2. **Compile, don't document** (Ochoa 2018/Zimmermann 2019): dependency, capability, conflict, and ordering rules are compile errors.
3. **Detect interactions offline; resolve by declared policy** (Keck & Kuehn/Zave): the compiler owns Q24–Q27.
4. **Treat the plugin set as a product line** (FOSD): `Auth.make` is a configurator; capabilities are the feature diagram.
5. **Trust measurements, not declarations** (Bogart/Businge): apiVersion gate + registry that recompiles plugins per supported generation.
6. **Deprecate = minor + codemod; remove = major + apiVersion bump** (Sawant/McDonnell/Dig & Johnson).
7. **Least privilege before isolation** (capability canon + marketplace studies): capability contracts, provenance, contract tests now; Wasm sandbox as a priced v2 seam.

## 8. What the literature does NOT cover (gaps to manage)

- No verified large-scale ".NET breaking-APIs" study exists (16 flags it; the 2026 SLR notes .NET underrepresentation).
- No academic study of the JetBrains plugin ecosystem as of 2026 (14 documents the gap + the 2026 malicious-plugin incident).
- TypeScript release-evolution/breaking-change science is essentially absent; the Effect-version CI matrix (Q2) manages an unstudied risk.
- No science specifically on *auth-framework* plugin ecosystems — better-auth is too young and unstudied academically; 02/03's source-verified practitioner analysis is the current best evidence.
- 0.x chaos is measured (Decan), but "integer apiVersion + semver advisory" hybrid has no empirical precedent to copy — it is a designed experiment; instrument it.

## 9. Master reading list (cross-file top 10)

1. Parnas (1972) — decomposition criteria (13)
2. Baldwin & Clark, *Design Rules* (2000) + "Managing in an Age of Modularity" (1997) (13)
3. Gruber et al., IBM SJ 44(2) 2005 — Eclipse architecture as built (14)
4. Beugnard et al. (1999) — contract levels (15)
5. Keck & Kuehn (1998) — feature interaction detection vs resolution (15)
6. Eugster et al., CSUR 2003 — publish/subscribe (15)
7. Ochoa et al., EMSE 2022 — breaking changes at scale (16)
8. Sawant et al., EMSE 2019 — deprecation inaction (16)
9. Miller (2006), *Robust Composition* + "Capability Myths Demolished" (17)
10. Birgisson et al., NDSS 2014 — Macaroons (17)

Per-file 10-paper syllabi (ordered, with one-line rationales) are in each bibliography's "Suggested reading order" section.

## Sources

All primary links live in the five bibliography files (48 + primary-linked + 50 + 61 + 47 URLs respectively); this review cites their verified numbers only.
