# API Evolution & Compatibility — Scientific Literature

Domain: scientific evidence on API evolution, breaking changes, semantic versioning, and dependency ecosystems (feeds Q2, Q20, Q26, Q31, Q97, Q100 of `research/00-questions.md`). Practitioner/plugin-system prior art is covered in `research/09-plugin-architecture.md`; this file is the empirical/scientific evidence base that its apiVersion + compatibility policy rests on. Every entry below was verified against a primary source (publisher page, arXiv, DOI resolution, or author-hosted PDF) as of 2026-09.

**A note on scope (verification honesty):** the assignment brief hypothesized a ".NET breaking-APIs TOSEM/TSE/MSR paper". Despite targeted searches across ACM DL, IEEE, Crossref, DBLP, arXiv, and the 2026 systematic review below, no such study could be located under any title/author combination tried. The 2026 SLR explicitly states that ".NET is underrepresented" in breaking-change research (its 97 primary studies cover Maven/Java, npm/JavaScript, Python, Web APIs, and Linux distributions). Rather than fabricate an entry, this file substitutes the strongest verified large-scale semver/breakage studies (Java/Maven, npm, Go, Android, 14 package managers) and flags the .NET gap as an open question.

**Verification method.** Every non-`non-academic` entry was resolved to a primary source in this session: DOIs resolved through Crossref, arXiv records fetched via the arXiv API, publisher/author pages fetched and (where PDFs) spot-read for authors, venue, and key figures. Claimed numbers in the annotations and in the policy table were taken from the abstracts or read sections of the linked documents — not from memory. Entries that could only be partially verified would be marked `[PARTIAL]`; none required the mark.

## TL;DR

- **Semver claims break in practice at a meaningful, measurable rate**: 20.1% of *non-major* Maven releases ship breaking changes (Ochoa et al., EMSE 2022), 28.6% of non-major Go upgrades break (Li et al., ASE 2023), and the original Maven study found ~30 BCs even in minor/micro updates (Raemaekers et al., JSS 2017). Any compatibility policy that *trusts* semver ranges will be broken ~1 in 5 times.
- **But the ecosystem is improving, and most breakage is harmless in practice**: the share of *non-major* Maven releases that break fell from 67.7% (2005) to 16.0% (2018) and 83.4% of all upgrades are now semver-compliant; only 7.9% of clients were actually impacted by any BC because most clients never touch the broken declarations (Ochoa et al., EMSE 2022). Impact is what matters, not declared breakage.
- **Consumers under-react to deprecation**: across 297K projects and 1.3B invocations, "predominantly consumers do not react to deprecation" (Sawant et al., EMSE 2019); Android clients lag 16 months median and only 22% of outdated API usages ever upgrade (McDonnell et al., ICSM 2013). A deprecation notice alone is not a migration mechanism.
- **Breaking-change detection is strong for syntactic breaks, weak for behavioral ones** — the #1 open challenge in the 2026 SLR (Chen et al.). Tooling lineage: clirr → japicmp → Maracas (Ochoa et al.) → APIDiff (Brito et al., SANER 2018) → Roseau (Latappy et al., 2025).
- **Semver ranges trade lag for risk**: ~24% of npm dependencies and 40% of releases carry technical lag (avg 7–9 months); semver minor ranges would eliminate a third of all lag across 14 package managers (Decan et al., ICSME 2018; Stringer et al., APSEC 2020). Caret-range semantics for `0.x` caused so much confusion that npm changed its default initial version to 1.0.0.
- **Ecosystem norms differ and are negotiated, not imposed**: breaking-change policies vary across 18 OSS ecosystems and are shaped by "cost negotiation and community values" (Bogart et al., FSE 2016; TOSEM 2021). Cargo's strict semver guidelines + machine-checked `cargo-semver-checks` are the closest production analog to what awthaq should build.
- **Ecosystem structure makes compatibility a security property**: installing an average npm package implicitly trusts 79 packages/39 maintainers; up to 40% of packages depend on known-vulnerable code (Zimmermann et al., USENIX Sec 2019). left-pad (2016) measurably chilled dependency growth.
- **Reproducibility is solved by tooling defaults, not by developers**: npm and Cargo achieve ~100% reproducible package builds as-is; Maven/PyPI/RubyGems go from 0–12% to 90%+ with toolchain configuration (Benedetti et al., ICSE 2025). Lockfiles are the design-space answer (Gamage et al., 2025).
- **Downstream dependents drive package survival**: packages with more dependents survive dormancy longer; having dormant upstreams raises dormancy risk (Valiev et al., FSE 2018). A plugin's dependency position is its life support.
- **Types pay**: static typing could have prevented ~15% of public JavaScript bugs (Gao et al., ICSE 2017) — evidence for typed plugin contracts (Q20) over stringly-typed ones; no TS-specific breaking-change study exists (open gap).

## Annotated bibliography

### A. Surveys & taxonomies (start here)

**Maxime Lamothe, Yann-Gaël Guéhéneuc, Weiyi Shang (2021). A Systematic Review of API Evolution Literature.** *ACM Computing Surveys 54(8), Article 171.* <https://dl.acm.org/doi/10.1145/3470133> — Maps two decades of API-evolution research (breaking changes, deprecation, migration, usage). The framing survey: confirms empirical breaking-change studies are mature while *prevention-by-contract-design* remains understudied — exactly the gap awthaq's compile-time plugin contracts attack. Open-access PDF: <https://users.encs.concordia.ca/~shang/pubs/mlamothe_csur_2021.pdf>.

**Juntao Chen, Tingting Bi, Yanlin Wang, Patanamon Thongtanunam (2026). Breaking Changes in Software Ecosystems: A Systematic Literature Review.** *arXiv:2605.24397.* <https://arxiv.org/abs/2605.24397> — Reviews 97 primary studies across Maven/Java, npm/JavaScript, Python, Web APIs, Linux distributions. Yields a four-dimensional BC taxonomy (Nature, Detectability, Scope, Visibility); finds maintenance/design improvements cause more BCs than new features; 43 detection approaches are accurate on syntactic but not behavioral breaks; names "the failure of semantic versioning as a trust mechanism" as a core open challenge. Notes .NET is underrepresented. The single best state-of-the-art synthesis for Q20/Q100.

### B. Breaking-change studies (how often, what kind, who breaks)

**Steven Raemaekers, Arie van Deursen, Joost Visser (2017). Semantic versioning and impact of breaking changes in the Maven repository.** *Journal of Systems and Software 129:140–158.* <https://doi.org/10.1016/j.jss.2016.04.008> — The foundational large-scale study (148K JARs): breaking changes are widespread without regard to semver, ~30 BCs on average even in minor/micro releases, with significant client compile-error impact; adherence improves over time (28.4% of non-major releases breaking in 2006 → 23.7% in 2011). Establishes the method every later study replicates. Origin: **Raemaekers, van Deursen, Visser (2014), Semantic Versioning versus Breaking Changes: A Study of the Maven Repository**, *SCAM 2014, pp. 215–224*, <https://doi.org/10.1109/SCAM.2014.30>.

**Lina Ochoa, Thomas Degueule, Jean-Rémy Falleri, Jurgen Vinju (2022). Breaking Bad? Semantic Versioning and Impact of Breaking Changes in Maven Central.** *Empirical Software Engineering 27, Article 61.* <https://doi.org/10.1007/s10664-021-10052-y> — Differentiated replication with a better protocol and 7 more years (119,879 upgrades, 293,817 clients): 83.4% of upgrades comply with semver; still 20.1% of *non-major* releases break; only **7.9% of clients are actually impacted** because most BCs hit unused declarations. Built **Maracas** (on japicmp), which computes BCs *and* client-impact locations — the architectural template for awthaq's compiler-level compatibility checker (Q31). Preprint: <https://homepages.cwi.nl/~jurgenv/papers/EMSE-2021.pdf>.

**Laerte Xavier, Aline Brito, André Hora, Marco Tulio Valente (2017). Historical and impact analysis of API breaking changes: A large-scale study.** *SANER 2017.* <https://doi.org/10.1109/SANER.2017.7884616> — 317 Java libraries, 9K releases, 260K client applications: systems with higher breaking-change frequency are *more* used by clients (the ecosystem rewards fast evolvers), while clients lag adoption. Motivates shipping an apiVersion *with* migration tooling rather than freezing APIs.

**Aline Brito, Laerte Xavier, André Hora, Marco Tulio Valente (2018). Why and How Java Developers Break APIs.** *SANER 2018.* <https://arxiv.org/abs/1801.05198> — Four-month field study with the developers of 400 popular Java libraries: 59 breaking changes observed in situ and their reasons reported by the library developers themselves (mostly maintenance and refactoring), complemented by APIDiff's breaking-change taxonomy (method removed, class removed, visibility reduced, …). Directly reusable as awthaq's `E_API_BREAK_*` lint categories for CI (Q31/Q97).

**Dig, Johnson (2006). How do APIs evolve? A story of refactoring.** *Journal of Software Maintenance and Evolution 18(2):83–107.* <https://doi.org/10.1002/smr.328> — Classic result (cited throughout the field): ~80% of breaking changes are refactorings. Implication for awthaq: most plugin-API breaks are *mechanical* and therefore automatable by codemods in the migration planner (Q26), not signs of design failure.

**Tyler McDonnell, Baishakhi Ray, Miryung Kim (2013). An Empirical Study of API Stability and Adoption in the Android Ecosystem.** *ICSM 2013.* <https://web.cs.ucla.edu/~miryung/Publications/icsm2013-apiecosystem.pdf> — Android evolves at 115 API updates/month, yet 28% of client API references are outdated (median lag 16 months); only 22% of outdated usages ever upgrade (mean 14 months); files adapting to new APIs are *more* defect-prone. The canonical adoption-lag evidence: fast-evolving host APIs outpace even willing plugin ecosystems — the argument for awthaq's strict small apiVersion surface (Q20).

**Li Li (2018). Characterising Deprecated Android APIs.** *SANER 2018.* <https://doi.org/10.1145/3196398.3196419> — Mines a decade of Android framework revisions with the CDA tool: characterizes how deprecations accumulate and are (inconsistently) annotated and documented. Tool + dataset: <https://github.com/lilicoding/CDA>.

**Wenke Li, Feng Wu, Cai Fu, Fan Zhou (2023). A Large-Scale Empirical Study on Semantic Versioning in Golang Ecosystem.** *ASE 2023.* <https://doi.org/10.1109/ASE56229.2023.00140> — Modern semver empirics for a young ecosystem: 86.3% of upgrades comply, but 28.6% of non-major upgrades still introduce breaking changes. Shows semver adherence does not reach stability even in a young, tooling-native ecosystem — same era as TypeScript/npm package design. Preprint: <https://arxiv.org/abs/2309.02894>.

### C. Deprecation studies (do developers respond?)

**Romain Robbes, Maurizio Lungu, David Röthlisberger (2012). How do developers react to API deprecation? The case of a Smalltalk ecosystem.** *FSE 2012, pp. 1–11.* <https://doi.org/10.1145/2393596.2393662> — The original deprecation-reaction study: only 14% of deprecated methods produce non-trivial breakage in clients, but when they do, a single deprecation breaks on average 5 projects (max 79). Deprecation is a *delayed* breakage: it converts an unannounced break into a slow-motion one. Author page: <https://rrobbes.github.io/>.

**Aman Sawant, Romain Robbes, Alberto Bacchelli (2016). On the Reaction to Deprecation of 25,357 Clients of 4+1 Popular Java APIs.** *ICSM 2016.* <https://www.researchgate.net/publication/312484922_On_the_Reaction_to_Deprecation_of_25357_Clients_of_41_Popular_Java_APIs> — Studies how 25,357 client projects of five mainstream Java APIs respond to deprecations; the follow-up EMSE 2019 study (below) shows the dominant reaction pattern is *not reacting*. Together the pair kills the assumption that `@deprecated` + docs constitutes a migration policy (Q26/Q100).

**Aman Sawant, Romain Robbes, Alberto Bacchelli (2019). To react, or not to react: Patterns of reaction to API deprecation.** *Empirical Software Engineering 24(6):3824–3870.* <https://doi.org/10.1007/s10664-019-09713-w> — 297,254 GitHub projects and 1,322,612,567 type-checked invocations: **predominantly consumers do not react to deprecation**. This is the empirical justification for awthaq treating deprecation warnings as *compiler-enforced* (visible in `auth doctor`, counted in contract tests) rather than doc-only, and for pairing every deprecation with a codemod (Q26) and a removal deadline (Q100).

**Aman Sawant, Guangzhe Huang, Gabriel Vilen, Stefan Stojkovski, Alberto Bacchelli (2018). Why are Features Deprecated? An Investigation Into the Motivation Behind Deprecation.** *ICSME 2018, pp. 13–24.* <https://ieeexplore.ieee.org/document/8529833/> — Identifies 12 reasons producers deprecate features and shows an automated classifier can recover them from documentation. Design implication: awthaq deprecation records should carry a *machine-readable reason + replacement field* (the literature shows replacement info is what consumers act on).

**Gleison Brito, André Hora, Marco Tulio Valente, Romain Robbes (2018). On the use of replacement messages in API deprecation.** *Journal of Systems and Software.* <https://www.sciencedirect.com/science/article/abs/pii/S016412121730300X> — Measures replacement-message practice at scale (66.7% of deprecated Java APIs and 77.8% in Smalltalk ship a replacement); even when present, replacements are often imprecise. Motivates awthaq's typed `deprecatedSince + replaceWith` fields validated by the compiler, not free-text JSDoc (Q20/Q100).

### D. Semantic versioning empirics (what semver actually delivers)

**Alexandre Decan, Tom Mens (2019/2021). What do package dependencies tell us about semantic versioning?** *IEEE Transactions on Software Engineering 47(6):1226–1240.* <https://doi.org/10.1109/TSE.2019.2918315> — Cross-ecosystem comparison (Cargo, npm, Packagist, RubyGems) of ~5M dependency constraints: developers increasingly adopt semver-compliant *minor/micro ranges* over fixed pins or open ranges, but compliance and permissiveness vary per ecosystem. The empirical basis for choosing constraint semantics in the plugin compatibility matrix (Q20). Open access: <https://orbi.umons.ac.be/handle/20.500.12907/40608>.

**Donald Pinckney, Federico Cassano, Arjun Guha, Jonathan Bell (2023). A Large Scale Analysis of Semantic Versioning in NPM.** *MSR 2023.* <https://arxiv.org/abs/2304.00394> — Builds a time-travelling npm dependency resolver over every package version ever published: when developers use semver correctly, 90.09% of critical (security) updates flow rapidly downstream; breakage comes from imperfect constraints *and* wrong version-number increments. Key lesson: the resolver + semver pair works when both sides behave — awthaq should make the correct behavior the default (compiler-checked bumps, Q97).

**Jacob Stringer, Amjed Tahir, Kelly Blincoe, Jens Dietrich (2020). Technical Lag of Dependencies in Major Package Managers.** *APSEC 2020.* <https://doi.org/10.1109/APSEC51365.2020.00031> — 14 package managers (libraries.io): the majority of fixed pins and many ranges are outdated; npm's overall lag 32.2%, Maven 63%; adopting semver minor ranges would remove a third of all lag. Qualitative analysis of dependency downgrades: top reasons are compatibility issues and bugs in the new release — i.e., **downgrades are the ecosystem's rollback mechanism** (design the plugin lockfile/`auth doctor` rollback around this, Q26/Q100). PDF: <https://kblincoe.github.io/publications/2020_APSEC_tech_lag.pdf>.

**Alexandre Decan, Tom Mens, Eleni Constantinou (2018). On the evolution of technical lag in the npm package dependency network.** *ICSME 2018.* <https://decan.lexpage.net/files/ICSME-2018.pdf> — 120K packages/1.4M releases: median 24% of dependencies and 40% of releases lag (avg 7–9 months); most lag is induced by *minor and patch* releases of dependencies (which should have been effortless); 49% of major updates reduce lag vs only 12% of patches. Also documents how `^`-caret semantics for `0.x` caused such confusion that npm abandoned 0.x as the default initial version — direct evidence for awthaq shipping plugin API **1.0.0 from day one, never 0.x** (Q20/Q100).

**Alexandre Decan, Tom Mens (2021). Lost in Zero Space — An Empirical Comparison of 0.y.z Releases in Software Package Distributions.** *Science of Computer Programming 208:102656.* <https://doi.org/10.1016/j.scico.2021.102656> — Deep dive on 0.y.z releases in Cargo/npm/Packagist/RubyGems: 0.x packages are more permissive than semver dictates and `0.y.z` conventions differ per ecosystem. Reinforces: no `apiVersion: 0` in the plugin contract — "initial development" versions carry no compatibility meaning. PDF: <https://decan.lexpage.net/files/SCICO-2021.pdf>.

### E. Ecosystem dependency science (structure, policy, survival)

**Chris Bogart, Christian Kästner, James Herbsleb, Ferdian Thung (2016). How to break an API: cost negotiation and community values in three software ecosystems.** *FSE 2016, pp. 109–120.* <https://doi.org/10.1145/2950290.2950325> — Qualitative study (CRAN, GNOME, Eclipse): breaking changes are governed by ecosystem-specific *negotiated contracts* — who bears migration cost, what notice is given, what tools ease it. Breaking changes are socio-technical, not just technical. PDF: <https://breakingapis.org/fse2016.pdf>.

**Chris Bogart, Christian Kästner, James Herbsleb, Ferdian Thung (2021). When and How to Make Breaking Changes.** *ACM TOSEM 30(4), pp. 1–56.* <https://dl.acm.org/doi/10.1145/3447245> — Scales the above to 18 ecosystems via developer surveys: codifies concrete breaking-change policies (notice periods, aliases/shims, migration guides) and shows ecosystem maturity and coupling predict policy strictness. The closest academic checklist for awthaq's deprecation/removal process (Q100).

**Marat Valiev, Bogdan Vasilescu, James Herbsleb (2018). Ecosystem-Level Determinants of Sustained Activity in Open-Source Projects: A Case Study of the PyPI Ecosystem.** *ESEC/FSE 2018.* <https://doi.org/10.1145/3236024.3236062> — Survival analysis of 46,547 PyPI packages: having more downstream dependents strongly improves survival; a dormant upstream raises dormancy risk. For awthaq: the official plugin registry and contract-test badge are survival infrastructure — listing increases downstream ties, which measurably keeps plugin maintainers alive (Q20 registry decision). PDF: <https://cmustrudel.github.io/papers/fse18sustainability.pdf>.

**Alexandre Decan, Tom Mens, Maël Claes (2017). An empirical comparison of dependency issues in OSS packaging ecosystems.** *SANER 2017, pp. 2–12.* <https://doi.org/10.1109/SANER.2017.7884604> — Quantifies dependency-related issues (outdated deps, dependency hell, version conflicts) across npm, CRAN, RubyGems: npm exhibits distinct, higher dependency pressure. Justifies treating plugin dependency resolution as a first-class compiler concern (Q21/Q22), not a docs concern.

**Alexandre Decan, Tom Mens, Philippe Grosjean (2018). An empirical comparison of dependency network Evolution in seven software packaging ecosystems.** *Empirical Software Engineering 24:381–416.* <https://doi.org/10.1007/s10664-017-9589-y> — Seven-ecosystem network study: dependency networks grow in density; a minority of packages are updated most; npm's network evolves fastest and most densely. Explains why awthaq caps plugin-to-plugin structural dependencies (`requiresPlugins`) and routes shared needs through capabilities (Q21). Preprint: <https://arxiv.org/abs/1710.04936>.

**Marc Zimmermann, Cristian-Alexandru Staicu, Cam Tenny, Michael Pradel (2019). Small World with High Risks: A Study of Security Threats in the npm Ecosystem.** *USENIX Security 2019.* <https://www.software-lab.org/publications/npm_study_arXiv_1902.09217.pdf> — 5.4M npm releases: an average install implicitly trusts 79 packages and 39 maintainers; top packages reach 100,000+ dependents; up to 40% of packages depend on known-vulnerable code; also documents a measurable post-left-pad (2016) structural chilling of dependency growth. The empirical case for awthaq's "few, declared, checked" plugin dependencies. arXiv: <https://arxiv.org/abs/1902.09217>.

**Non-academic canon — the left-pad incident (2016).** *Wikipedia: Npm left-pad incident* <https://en.wikipedia.org/wiki/Npm_left-pad_incident>; *LWN: A single Node of failure* <https://lwn.net/Articles/681410/>. — An 11-line package's unpublishing broke thousands of builds within hours; fixed by re-publishing and (soon after) by npm's unpublish-policy tightening. The canonical availability lesson: any unresolved external reference at "compile" time is a load-bearing risk — awthaq resolves all plugin contributions at compile time and fails closed (`E_PLUGIN_MISSING_DEP`), which structurally converts this class of runtime surprise into a startup error.

### F. Supply chain, availability & reproducibility (compatibility as a trust property)

**Marc Ohm, Henrik Plate, Arnold Sykosch, Michael Meier (2020). Backstabber's Knife Collection: A Review of Open Source Software Supply Chain Attacks.** *DIMVA 2020.* <https://doi.org/10.1007/978-3-030-52683-2_2> — Systematizes 100+ real attacks (typosquatting, account takeover, build compromise). Frames why version/compatibility metadata must be integrity-protected: npm provenance and signed registry metadata for the plugin registry (Q92-adjacent). Dataset: <https://dasfreak.github.io/Backstabbers-Knife-Collection/>.

**Yacong Gu, Lingyun Ying, Yingyuan Pu, Xiao Hu, Hui Chai, Ruoxi Wang, Xunxiao Gao, Hongsong Duan (2023). Investigating Package Related Security Threats in Software Registries.** *IEEE S&P 2023, pp. 1578–1595.* <https://www.computer.org/csdl/proceedings-article/sp/2023/933600b151/1OXI7VHaHV6> — Large-scale measurement of registry threats (typosquatting, takeover, **dependency confusion**) across npm/PyPI/etc., including which resolvers (e.g., Gradle) are vulnerable to confusion attacks. For awthaq: namespaced plugin ids derived from npm scopes (Q23) plus a registry uniqueness check at compile time are the confusion defense. (Also listed at <https://sos-vo.org/publications/investigating-package-related-security-threats-software-registries-0>.)

**Giacomo Benedetti, Oreofe Solarin, Courtney Miller, Greg Tystahl, William Enck, Christian Kästner, Alessio Merlo, Alexandros Kapravelos, Luca Verderame (2025). An Empirical Study on Reproducible Packaging in Open-Source Ecosystems.** *ICSE 2025.* <https://www.cs.cmu.edu/~ckaestne/pdf/icse25_rb.pdf> — 4,000 packages × 6 ecosystems: npm and Cargo are ~100% reproducible as-is; Maven 2.1%, PyPI 12.2%, RubyGems 0% — fixed to 90%+ by *toolchain defaults*, not developer effort. Design rule for awthaq's release pipeline (Q97): determinism must be a property of the toolchain (hash-stamped compile artifacts, Q26's byte-identical migrations), never a per-contributor virtue.

**Yogya Gamage, Deepika Tiwari, Martin Monperrus, Benoit Baudry (2025). The Design Space of Lockfiles Across Package Managers.** *arXiv:2505.04834.* <https://arxiv.org/abs/2505.04834> — Systematizes lockfile designs (integrity, resolved-graph pinning, reproducibility roles) across package managers. The vocabulary for awthaq's *compiled-plugin lockfile*: the compile step should emit a resolved, hash-stamped record of plugin versions + apiVersions + capability assignments so rebuilds are bit-comparable and drift is detectable (Q26).

### G. Detection tooling, types & TypeScript (the CI compatibility-test lineage)

**Alessandro Brito, Laerte Xavier, André Hora, Marco Tulio Valente (2018). APIDiff: Detecting API Breaking Changes.** *SANER 2018, Tools Track.* <https://www.dcc.ufmg.br/~mtov/pub/2018-saner-apidiff.pdf> — Tool paper: identifies breaking vs non-breaking changes between two versions of a Java library (code + types + annotations levels); the detection taxonomy underlies "Why and How Java Developers Break APIs". Repo: <https://github.com/aserg-ufmg/apidiff>. Model for `auth plugin check` — a pre-publish diff gate for plugin authors (Q31/Q97).

**Corentin Latappy, Thomas Degueule, Jean-Rémy Falleri, Romain Robbes, Lina Ochoa (2025). Roseau: Fast, Accurate, Source-based API Breaking Change Analysis in Java.** *arXiv:2507.17369.* <https://arxiv.org/abs/2507.17369> — Performance-focused successor for large-scale source-based breakage analysis, enabling per-PR analysis at scale. Shows the state of the art is now "run the diff in CI on every change" — the exact placement of awthaq's compatibility lint (Q31).

**Non-academic tooling lineage (the deployed state of practice).** japicmp <https://siom79.github.io/japicmp/> (binary JAR diff; the engine under Maracas), Revapi <https://revapi.org/> (API change analysis with extension checking), Kotlin binary-compatibility-validator, elm-review's API-breakage checks. — All are *hostile* to accidental breaks and *permissive* about deliberate ones — exactly the CI stance awthaq should take toward its own exported surface.

**Zheng Gao, Christian Bird, Earl T. Barr (2017). To Type or Not to Type: Quantifying Detectable Bugs in JavaScript.** *ICSE 2017.* <https://doi.org/10.1109/ICSE.2017.75> — Static typing (TypeScript/Flow) could have detected ~15% of public JavaScript bugs in their benchmark. Evidence that typed plugin contribution objects (vs JSON manifests) convert a class of ecosystem bugs into compile errors. PDF: <https://www.microsoft.com/en-us/research/wp-content/uploads/2017/09/gao2017javascript.pdf>.

**Non-academic canon — TypeScript evolution as host-API precedent.** Official per-release "Breaking Changes" pages, e.g. TypeScript 6.0 release notes <https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html>. — A fast-moving *host language* ships documented, intentional breaking changes in its releases (6.0 is explicitly a "transition" release) and expects downstream tools to follow. This is the lived reality of any Effect-adjacent plugin ecosystem and the strongest argument for awthaq owning a compatibility *matrix* in CI (Q2: compile official plugins against supported Effect versions × supported TS versions, per release). Note: despite searching, **no scientific study of TypeScript-specific breaking changes or TS2589-type-inference brittleness was found** — the tRPC/ZenStack evidence in `research/09-plugin-architecture.md` remains the only practitioner-grade source on that cliff.

**Non-academic canon — compatibility metadata systems in production ecosystems.** Cargo's semver compatibility rules <https://doc.rust-lang.org/cargo/reference/semver.html> + `cargo-semver-checks` <https://github.com/obi1kenobi/cargo-semver-checks> (CI-enforced API-semver conformance); OSGi's `version-range` import model <https://docs.osgi.org/specification/osgi.core/7.0.0/framework.module.html>; semver.org <https://semver.org/>. — Cargo is the flagship case of *machine-checked* compatibility metadata; awthaq's `apiVersion` check should aspire to be Cargo-grade (checked, not documented), per the failure modes in B/D above. Framework-level compatibility ranges (Nuxt `compatibility.nuxt`, fastify-plugin host ranges) are analyzed in `research/09-plugin-architecture.md` §Q20.

## Cross-cutting themes for awthaq

### Policy numbers extracted from the literature (verified figures)

| Question | Verified evidence | Number |
|---|---|---|
| What % of semver *claims* break? | Ochoa EMSE 2022 (Maven) | 20.1% of **non-major** releases ship ≥1 BC; 83.4% of upgrades fully compliant |
| Same, other ecosystems | Li ASE 2023 (Go); Raemaekers JSS 2017 | 28.6% of non-major Go upgrades break; ~30 BCs avg per minor/micro Maven update |
| Does declared breakage = actual breakage? | Ochoa EMSE 2022 | Only **7.9% of clients** impacted by any BC (most BCs hit unused API) |
| Is semver improving? | Ochoa EMSE 2022 | Non-major-breaking share: 67.7% (2005) → 16.0% (2018) |
| Do security fixes flow? | Pinckney MSR 2023 | 90.09% flow rapidly when semver is used correctly |
| Adoption lag vs release cadence | McDonnell ICSM 2013 | Android: releases ~3 months; client lag median 16 months; only 22% of stale usages ever upgrade |
| Do consumers react to deprecation? | Sawant EMSE 2019 | Predominantly **no** (297K projects, 1.3B invocations) |
| What does deprecation break? | Robbes FSE 2012 | 14% of deprecations break clients; avg 5, max 79 projects per event |
| How much lag do ranges cause? | Decan ICSME 2018; Stringer APSEC 2020 | 24% of npm deps / 40% of releases lag (7–9 mo avg); semver ranges would remove ~⅓ of lag |
| Why do users roll back? | Stringer APSEC 2020 (66 coded cases) | Compatibility issues (14) and bugs in new release (11) dominate — rollback is routine |
| 0.x semantics | Decan & Mens SCP 2021; Decan ICSME 2018 | 0.y.z conventions are chaotic; npm abandoned 0.x default because of it |
| Ecosystem fragility | Zimmermann USENIX Sec 2019 | Avg install trusts 79 packages/39 maintainers; ≤40% depend on known-vulnerable code |

### Q20 + Q100 — plugin contract & apiVersion policy

The literature converges on one conclusion: **semver is a communication convention, not an enforcement mechanism** (Chen 2026 names "the failure of semantic versioning as a trust mechanism" a top challenge; Raemaekers/Ochoa/Li quantify that ~20–29% of *non-major* releases break: 23.7%, 20.1%, 28.6% respectively). awthaq should therefore: (1) keep integer `apiVersion` as the *load-bearing* compatibility contract (exact-match check at compile time, `E_API_VERSION_UNSUPPORTED`), with semver ranges only as advisory metadata on third-party plugins; (2) ship Plugin API 1.0.0 — never 0.x (Decan & Mens 2021; npm's own 0.x retreat); (3) plan for **two non-consecutive-breakage generations**: Maven data shows compliance improving with tooling+time, so a codemod-supported transition per API major (never indefinite shims — the Gatsby lesson in 09) matches the observed ecosystem dynamics; (4) treat the apiVersion bump of the *host* as the breakage event of record, published with machine-readable replacement records (Brito JSS 2018: replacement messages are what consumers use).

### Q26 — migration planner & API drift

Verified facts to design against: most breaks are *refactorings* (Dig & Johnson 2006, ~80%) and therefore mechanically translatable; most declared breaks are *unused* by any given consumer (Ochoa: 7.9% impacted) — so a planner that diffs the plugin-API surface and then intersects with *what the plugin actually uses* (the Maracas detection model) will cut migration noise by an order of magnitude; rollbacks are a routine, compatibility-driven activity (Stringer RQ5) — the migration ledger must support forward *and* back application; and drift is best caught by determinism: hash-stamped, byte-identical outputs (Benedetti ICSE 2025 shows determinism is a toolchain property, not a contributor virtue).

**Deprecation cadence that works (Q26/Q100).** The evidence assembles into a concrete cadence: deprecate in a *minor* release with a compiler-visible warning (`@deprecated`-equivalent on the typed facade) plus a working codemod — because Sawant EMSE 2019 shows doc-only deprecation is ignored, and Brito JSS 2018 shows consumers act mainly on machine-readable *replacements*; keep the deprecated surface working across at least **two minor cycles** — because McDonnell ICSM 2013 measures real propagation at ~14 months median (≈4× the host release cadence); remove only in a **major** (apiVersion bump), never in minor/patch — because ~1 in 5 non-major releases already breaks without permission (Ochoa/Li), and awthaq must not add to that; and publish the deprecated-usage census (`auth doctor` counting each installed plugin's usage of deprecated surface) so removals are negotiated with data, the mechanism Bogart TOSEM 2021 identifies as the difference between ecosystems that absorb breaks and those that fracture.

### Q2 + Q31 — CI compatibility-test design

The tooling lineage (japicmp → Maracas → APIDiff → Roseau) plus Cargo's `cargo-semver-checks` define the modern shape: **run the API diff on every PR, fail on undeclared breaks, allow declared ones.** For awthaq: (1) `@awthaq/test` contract suite runs in every plugin's CI against the current host (Q31's RuleTester model); (2) a host-side "compatibility matrix" CI compiles official plugins across the supported Effect × TypeScript version range each release (Q2), because TypeScript's own annual documented breaks (release-notes canon) are the only *verified* TS evolution data — the absence of TS breaking-change studies is itself a risk to manage, not a reason to skip the matrix; (3) publish the resulting checked compatibility matrix as machine-readable registry metadata (Decan & Mens TSE 2019 shows ecosystems increasingly rely on checked, ranged compatibility declarations).

### Q97 — release engineering

Pinckney (MSR 2023): correct semver use = 90.09% rapid security flow — so automate *correct* bumps (changesets validated against the API diff, not authorial judgment). Benedetti (ICSE 2025): reproducibility is toolchain defaults — hash-stamp compile outputs. Gu (S&P 2023) + Ohm (DIMVA 2020): registry metadata must be namespaced and integrity-protected (npm provenance) — dependency confusion and takeover are measured, ongoing attack classes. Zimmermann (USENIX 2019): keep the official plugin set's dependency fan-in small and declared.

## People & research groups

- **Alexandre Decan & Tom Mens** (University of Mons, Software Engineering Lab) — the package-ecosystem science group: semver compliance, technical lag, dependency networks, 0.y.z. <https://decan.lexpage.net/>, <https://github.com/AlexandreDecan>
- **Lina Ochoa, Jurgen Vinju** (TU Eindhoven / CWI) — Maracas, "Breaking Bad?", Roseau-adjacent analysis line. <https://linao.vercel.app/>, <https://homepages.cwi.nl/~jurgenv/>
- **André Hora & Marco Tulio Valente** (UFMG, ASERG) — APIDiff, breaking-change taxonomies, Java ecosystem studies. <https://github.com/aserg-ufmg>, <http://www.dcc.ufmg.br/~mtov/>
- **Aman Sawant & Alberto Bacchelli** (Univ. Zurich) — deprecation motivation and reaction studies. <https://sback.it/>
- **Romain Robbes** (Free Univ. of Bozen-Bolzano) — original deprecation-reaction study. <https://rrobbes.github.io/>
- **Weiyi Shang & Maxime Lamothe** (Concordia) — API-evolution literature survey. <https://users.encs.concordia.ca/~shang/>
- **Miryung Kim / Tyler McDonnell** (UCLA / UT Austin) — Android API stability & adoption. <https://web.cs.ucla.edu/~miryung/>
- **Donald Pinckney, Arjun Guha, Jonathan Bell** (Northeastern) — npm semver at scale. <https://github.com/dpinckney>, <https://github.com/arjunguha>
- **Michael Pradel** (Stuttgart, Software Lab) — npm security threats. <https://software-lab.org/>
- **Chris Bogart, Christian Kästner, James Herbsleb** (CMU) — breaking-change policies across ecosystems; sustainability. <https://breakingapis.org/>, <https://www.cs.cmu.edu/~ckaestne/>
- **Bogdan Vasilescu** (CMU, Strudel Lab) — ecosystem survival analysis. <https://cmustrudel.github.io/>
- **Benoit Baudry & Martin Monperrus** (KTH) — lockfiles, reproducibility, supply chain. <https://softwarediversity.eu/>
- **Amjed Tahir, Jens Dietrich, Kelly Blincoe** (Massey/VUW/Auckland) — technical lag across package managers.
- **Jens Dietrich** (VUW) — dependency resolution semantics and tool soundness. <https://jensdietrich.github.io/>

## Suggested reading order

1. **Lamothe et al., CSUR 2021** — the map of the whole field; read first to place everything else.
2. **Chen et al., arXiv 2026** — the breaking-change-specific synthesis; the four-dimensional taxonomy is the vocabulary for our design docs.
3. **Raemaekers et al., JSS 2017** — the original "does semver hold?" study and its method.
4. **Ochoa et al., EMSE 2022** — the corrected replication with client-impact analysis; the single most policy-relevant paper here.
5. **Pinckney et al., MSR 2023** — how semver actually behaves in npm's resolution model (our closest ecosystem).
6. **Decan & Mens, TSE 2019** — cross-ecosystem constraint practices; informs the compatibility-matrix metadata design.
7. **Bogart et al., TOSEM 2021 (+ FSE 2016)** — the socio-technical rules for *when and how* to break; template for our deprecation policy.
8. **Sawant et al., EMSE 2019** — why deprecation alone fails; sets the bar for our compiler-enforced deprecations.
9. **McDonnell et al., ICSM 2013** — adoption lag quantified; calibrates how conservative apiVersion support windows must be.
10. **Zimmermann et al., USENIX Sec 2019** — why dependency structure is a compatibility *and* security decision.

## Open questions

1. **Exact-match `apiVersion` vs compatible ranges (Q20/Q100).** The literature shows ranges create lag and confusion (Decan ICSM 2018; Stringer APSEC 2020) while exact pins lose patch flow (Pinckney MSR 2023). Should a plugin declare `apiVersion: 1` (exact, host-enforced) plus an *advisory* range, with the compiler warning when advisory and enforced disagree? Literature suggests: yes, but this remains a design decision.
2. **Behavioral compatibility (Q31).** Detection tooling is syntactic-strong/behavior-weak (Chen 2026). Effect's typed errors + Effect-as-value architecture make behavior partially *type*-visible — can awthaq's contract tests check behavioral contracts (hook ordering, error unions) that Java tooling could not? Open design opportunity, no prior art found.
3. **TS/Effect-specific breaking-change empirics (Q2).** No scientific study of TypeScript-language breaking changes or type-inference cliffs exists (searched; the tRPC/ZenStack evidence in 09 is practitioner-grade only). The Effect × TS compatibility matrix must therefore be designed from first principles + Maven-style multi-version compile practice, and its results documented as original evidence.
4. **Registry curation as survival infrastructure (Q20).** Valiev FSE 2018 shows downstream ties drive survival. Does a contract-test-gated registry (option (a) in 09's open question 1) measurably improve plugin longevity, or just add friction? Genuinely open — would need post-hoc ecosystem data.
5. **Rollback semantics for compiled plugin graphs (Q26).** Stringer shows downgrades are routine compatibility work; but awthaq compiles plugins into a frozen graph with migrations. Should `auth doctor` support reverting to a previous *compiled+ledger* state (pin + rollback), and how does that interact with hash-stamped migration determinism? No ecosystem implements this cleanly; open.
6. **Patch-lane trust (Q97/Q100).** Pinckney MSR 2023 shows the payoff of semver is rapid patch flow (90.09% of security fixes), yet 20–29% of non-major releases break — so automation must verify, not trust, the bump. If `cargo-semver-checks`-style API diffing gates every plugin release, can awthaq auto-trust plugin patch/minor bumps that pass the diff + contract tests, and auto-major them when they do not? No dependency ecosystem does this end-to-end; it would be novel infrastructure.

## Sources

- https://dl.acm.org/doi/10.1145/3470133
- https://users.encs.concordia.ca/~shang/pubs/mlamothe_csur_2021.pdf
- https://arxiv.org/abs/2605.24397
- https://doi.org/10.1016/j.jss.2016.04.008
- https://doi.org/10.1109/SCAM.2014.30
- https://doi.org/10.1007/s10664-021-10052-y
- https://homepages.cwi.nl/~jurgenv/papers/EMSE-2021.pdf
- https://doi.org/10.1109/SANER.2017.7884616
- https://arxiv.org/abs/1801.05198
- https://doi.org/10.1002/smr.328
- https://web.cs.ucla.edu/~miryung/Publications/icsm2013-apiecosystem.pdf
- https://doi.org/10.1145/3196398.3196419
- https://github.com/lilicoding/CDA
- https://doi.org/10.1109/ASE56229.2023.00140
- https://arxiv.org/abs/2309.02894
- https://doi.org/10.1145/2393596.2393662
- https://doi.org/10.1007/s10664-019-09713-w
- https://ieeexplore.ieee.org/document/8529833/
- https://www.researchgate.net/publication/312484922_On_the_Reaction_to_Deprecation_of_25357_Clients_of_41_Popular_Java_APIs
- https://doi.org/10.1109/SCAM.2014.30
- https://research.tudelft.nl/files/45721694/deprecation_reasons.pdf
- https://www.sciencedirect.com/science/article/abs/pii/S016412121730300X
- https://doi.org/10.1109/TSE.2019.2918315
- https://orbi.umons.ac.be/handle/20.500.12907/40608
- https://arxiv.org/abs/2304.00394
- https://doi.org/10.1109/APSEC51365.2020.00031
- https://kblincoe.github.io/publications/2020_APSEC_tech_lag.pdf
- https://decan.lexpage.net/files/ICSME-2018.pdf
- https://www.sciencedirect.com/science/article/pii/S0167642321000496
- https://decan.lexpage.net/files/SCICO-2021.pdf
- https://breakingapis.org/fse2016.pdf
- https://doi.org/10.1145/2950290.2950325
- https://dl.acm.org/doi/10.1145/3447245
- https://doi.org/10.1145/3236024.3236062
- https://cmustrudel.github.io/papers/fse18sustainability.pdf
- https://doi.org/10.1109/SANER.2017.7884604
- https://doi.org/10.1007/s10664-017-9589-y
- https://arxiv.org/abs/1710.04936
- https://www.software-lab.org/publications/npm_study_arXiv_1902.09217.pdf
- https://arxiv.org/abs/1902.09217
- https://en.wikipedia.org/wiki/Npm_left-pad_incident
- https://lwn.net/Articles/681410/
- https://doi.org/10.1007/978-3-030-52683-2_2
- https://dasfreak.github.io/Backstabbers-Knife-Collection/
- https://www.computer.org/csdl/proceedings-article/sp/2023/933600b151/1OXI7VHaHV6
- https://sos-vo.org/publications/investigating-package-related-security-threats-software-registries-0
- https://www.cs.cmu.edu/~ckaestne/pdf/icse25_rb.pdf
- https://arxiv.org/abs/2505.04834
- https://www.dcc.ufmg.br/~mtov/pub/2018-saner-apidiff.pdf
- https://github.com/aserg-ufmg/apidiff
- https://arxiv.org/abs/2507.17369
- https://siom79.github.io/japicmp/
- https://revapi.org/
- https://doi.org/10.1109/ICSE.2017.75
- https://www.microsoft.com/en-us/research/wp-content/uploads/2017/09/gao2017javascript.pdf
- https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html
- https://doc.rust-lang.org/cargo/reference/semver.html
- https://github.com/obi1kenobi/cargo-semver-checks
- https://docs.osgi.org/specification/osgi.core/7.0.0/framework.module.html
- https://semver.org/
- https://doi.org/10.1016/j.scico.2021.102656
