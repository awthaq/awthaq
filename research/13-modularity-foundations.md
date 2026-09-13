# Modularity & Extensibility Foundations — Scientific Literature

Domain: foundational software-engineering and operating-systems science of modularity, information hiding, contracts, architectural styles, modularity economics, and extensible OS kernels. This is the scientific layer beneath the practitioner baseline in `research/09-plugin-architecture.md` — that file owns Nuxt/Vite/Fastify/Chrome prior art; this file owns the papers those tools unknowingly implement. It feeds plugin-compiler design questions Q8–Q31 of `research/00-questions.md`.

Verification method: every entry checked against a primary source (ACM DL / IEEE Xplore / USENIX / MIT Press / HBR / Springer / publisher page) via web search and, where ambiguous, a direct read of the landing page or PDF, 2026-09. Free-access mirrors are given alongside paywalled canonical DOIs. Gray-literature engineering canon (one thesis) is explicitly labeled.

## TL;DR

- **Parnas (1972, 1976, 1979)** is the theoretical program of awthaq in three papers: modules hide *likely-change decisions*; systems come in *program families* defined by shared design rules; and a well-designed system stays valid under *extension and contraction* — every subset of installed plugins must compile to a valid program.
- **Dijkstra's THE system (1968)** proves-by-construction that strict layering works at scale: each layer uses only lower layers. The Effect Layer graph is this discipline made a runtime object; acyclicity is a proof obligation, not bureaucracy.
- **Simon (1962)** supplies the general science: complex systems that evolve are hierarchic and **near-decomposable** — interactions within modules are strong, between modules weak. The plugin contract is the near-decomposability claim made machine-checkable.
- **Contracts and behavioral subtyping (Meyer 1992; Liskov & Wing 1994)** define what "swappable capability" must mean: type equality is not substitutability; preconditions may not strengthen, postconditions may not weaken. The plugin contract-test suite (Q31) is the runtime face of these two papers.
- **The architecture canon (Perry & Wolf 1992; Shaw & Garlan 1996; POSA 1996; Bass et al.)** supplies the vocabulary: components + **connectors** + constraints; styles; and the **Microkernel pattern** — minimal core, plug-ins, adaptors — which is literally PRD §1.2.
- **Baldwin & Clark (1997, 2000)** explain why the plugin compiler is the strategic product: design rules (contract, namespaces, `apiVersion`) must be frozen *first*; then hidden modules (plugins) become independently improvable **options** whose value grows with ecosystem volatility.
- **MacCormack/Rusnak/Baldwin (2006)** make design structure *measurable*: propagation cost on a DSM separated Linux from Mozilla-1.0 (5.2% vs 17.4%) and showed purposeful re-modularization works — "architecture for participation" is the ecosystem requirement on the compiler.
- **Extensible OS kernels (SPIN, Exokernel, Liedtke — all SOSP 1995)** converged from three directions: a minimal core; safe, cheap in-process extension; and a minimality principle — "a concept is tolerated inside the core only if moving it outside would prevent implementing required functionality."
- **Small & Seltzer (1996)** compared extension technologies and found no dominant one: performance, protection, and recoverability trade off. awthaq's compile-time-only choice must be defended as a deliberate point in this design space (Q30), not a default.
- **VINO and KaffeOS** are the complement to compile-time guarantees: untrusted extensions still misbehave, so runtime containment (transactions, rollback, resource rations) is needed for hooks (Q27) and migrations (Q26).

## Annotated bibliography

Entry format: **Authors (Year). Title.** *Venue.* link — then core claim and implication for awthaq's plugin compiler.

### 1. The Parnas lineage: information hiding, module specification, program families, design for change

The four Parnas papers below are the intellectual foundation of the whole plugin concept: what a module is (a hidden decision), how its contract is specified (access functions to a secret), how a family of products shares a design, and how validity must survive adding and removing members.

**D.L. Parnas (1972). On the Criteria To Be Used in Decomposing Systems into Modules.** *Communications of the ACM 15(12):1053–1058.*
[https://dl.acm.org/doi/10.1145/361598.361623](https://dl.acm.org/doi/10.1145/361598.361623) — free PDF: [TU Eindhoven mirror](https://wstomv.win.tue.nl/edu/2ip30/references/criteria_for_modularization.pdf)
Claim: decompose modules around **design decisions likely to change** (information hiding), not around steps of processing; the KWIC example shows flowchart-style decomposition fails exactly where requirements shift.
Implication: awthaq's capability interfaces (`PasswordHasher`, `Mailer`, `RateLimiter`, Q11) are module seams cut along the auth system's likely-change axes — algorithm swaps, storage backends, provider policies.

**D.L. Parnas (1972). A Technique for Software Module Specification with Examples.** *Communications of the ACM 15(5):330–336.*
[https://dl.acm.org/doi/10.1145/355602.361309](https://dl.acm.org/doi/10.1145/355602.361309) — free text: [CACM research page](https://cacm.acm.org/research/a-technique-for-software-module-specification-with-examples/)
Claim: specify a module by the **access programs it offers and the secret it hides**, not by its internal control flow — the specification technique that makes information hiding operational.
Implication: the plugin contract (Q20) and its machine-readable registry entry (Q23) should describe *contributions and obligations*, never plugin internals — `definePlugin()` is an access-function specification.

**D.L. Parnas (1976). On the Design and Development of Program Families.** *IEEE Transactions on Software Engineering SE-2(1):1–9.*
[https://dl.acm.org/doi/10.1109/TSE.1976.233797](https://dl.acm.org/doi/10.1109/TSE.1976.233797) — also [IEEE Xplore](https://ieeexplore.ieee.org/document/1702332/)
Claim: a program family is "a set of programs whose common properties are so extensive that it is profitable to study the common properties *before* the differing ones"; families fail when the common part is extracted too late or too early.
Implication: an auth framework with N plugins is a family; the plugin contract + `apiVersion` (Q20) *is* the family's common-property specification, and choosing when to freeze it is the Q20 decision.

**D.L. Parnas (1979). Designing Software for Ease of Extension and Contraction.** *IEEE Transactions on Software Engineering SE-5(2):128–138.*
[https://dl.acm.org/doi/10.1109/TSE.1979.234169](https://dl.acm.org/doi/10.1109/TSE.1979.234169) — free PDF: [Vanderbilt mirror](https://www.dre.vanderbilt.edu/~schmidt/PDF/family.pdf); presented at ICSE '78, pp. 264–277
Claim: design so that **every subset of the system is a valid program** ("contraction") and new modules can be added without disturbance ("extension"); identifies as-built vs as-intended divergence as the family killer.
Implication: the plugin compiler's deepest obligation (Q20/Q31): `Auth.make({ plugins })` must compile-validly for *any* subset of the ecosystem — the contract-test harness should include plugin-withdrawal tests.

### 2. Layered structure

**E.W. Dijkstra (1968). The Structure of the "THE"-Multiprogramming System.** *Communications of the ACM 11(5):341–346.*
[https://dl.acm.org/doi/10.1145/363095.363143](https://dl.acm.org/doi/10.1145/363095.363143)
Claim: a working multiprogramming system decomposed into a strict hierarchy of levels, each providing abstractions used only by higher layers, with correctness argued level by level — layering as a proof technique.
Implication: awthaq's single typed Layer graph (Q8) inherits this obligation — core → plugin layers → application, no upward edges; cycle detection (Q22) is the compiler enforcing THE's layer discipline.

### 3. Complexity science and modularity economics

**Herbert A. Simon (1962). The Architecture of Complexity: Hierarchic Systems.** *Proceedings of the American Philosophical Society 106(6):467–482.*
reprinted as ch. 8 of *The Sciences of the Artificial*, MIT Press: [https://direct.mit.edu/books/monograph/4551/The-Sciences-of-the-Artificial](https://direct.mit.edu/books/monograph/4551/The-Sciences-of-the-Artificial)
Claim: complex systems that evolve are hierarchic and **near-decomposable** — intra-module interactions are strong, inter-module ones weak; modular (stable intermediate) forms are the ones complex evolution can build on.
Implication: the plugin contract is the near-decomposability claim made machine-checkable: strong coupling *inside* a plugin is fine; every plugin↔plugin or plugin↔core edge must pass through a declared, validated interface (Q21, Q23).

**Carliss Y. Baldwin & Kim B. Clark (2000). Design Rules, Volume 1: The Power of Modularity.** *MIT Press.*
[https://direct.mit.edu/books/monograph/1856/Design-Rules-Volume-1The-Power-of-Modularity](https://direct.mit.edu/books/monograph/1856/Design-Rules-Volume-1The-Power-of-Modularity)
Claim: modularity = design rules (visible, frozen information) plus hidden modules (encapsulated design); modular operators (split, substitute, augment, exclude, invert, port) create **options** whose economic value grows with volatility — the theory of the computer industry's modularity boom.
Implication: the plugin compiler is awthaq's design-rule engine; its output (contract, namespaces, `apiVersion`) must be frozen early and defended, because third-party option value exists only if the rules stay stable (Q20).

**Carliss Y. Baldwin & Kim B. Clark (1997). Managing in an Age of Modularity.** *Harvard Business Review 75(5):84–93 (Sept–Oct).*
[https://hbr.org/1997/09/managing-in-an-age-of-modularity](https://hbr.org/1997/09/managing-in-an-age-of-modularity)
Claim: the managerial companion — modular designs beget modular organizations and **competition among module designers**; architects who own the design rules capture ecosystem value while module markets fragment and recombine.
Implication: Q7 governance and Q23 registry policy are not engineering details — who may provide `auth.*` capabilities is exactly the "design-rule ownership" question this paper formalizes.

**Alan MacCormack, John Rusnak, Carliss Baldwin (2006). Exploring the Structure of Complex Software Designs: An Empirical Study of Open Source and Proprietary Code.** *Management Science 52(7):1015–1030.*
[https://ideas.repec.org/a/inm/ormnsc/v52y2006i7p1015-1030.html](https://ideas.repec.org/a/inm/ormnsc/v52y2006i7p1015-1030.html) — free working paper: [HBS 05-016](https://www.hbs.edu/ris/Publication%20Files/05-016.pdf)
Claim: Design Structure Matrices with propagation-cost and clustered-cost metrics show Linux far more modular than Mozilla 1.0 (propagation cost 5.2% vs 17.4%; 14 vs 2 "vertical buses"), and Mozilla's deliberate 1998 re-design became *more* modular than both — purposeful re-architecture works, and ecosystems need an "architecture for participation."
Implication: the compiled Layer/contribution graph can be DSM-measured in CI; the compiler should emit and trend a coupling metric so Plugin API growth is bounded by evidence (Q8, Q19, Q31).

### 4. Contracts and behavioral substitution

**Bertrand Meyer (1988). Object-Oriented Software Construction.** *Prentice Hall.*
[https://en.wikipedia.org/wiki/Object-Oriented_Software_Construction](https://en.wikipedia.org/wiki/Object-Oriented_Software_Construction) — author's own statement of provenance: [Meyer 2021](https://bertrandmeyer.com/2021/02/26/some-contributions/)
Claim: §2.3 of the 1988 first edition states the **Open-Closed Principle** — "software entities should be open for extension, but closed for modification." (Verification note: often mis-cited as a standalone 1988 article; the canonical statement is the book section, popularized by R. Martin's 1996 essay.)
Implication: the plugin thesis — third parties extend core without modifying it — is OCP realized structurally: `Auth.make` closes the system at compile time; each plugin factory is the open axis (G2/G3).

**Bertrand Meyer (1992). Applying "Design by Contract".** *IEEE Computer 25(10):40–51.*
[https://se.inf.ethz.ch/~meyer/publications/computer/contract.pdf](https://se.inf.ethz.ch/~meyer/publications/computer/contract.pdf) — IEEE DOI: 10.1109/2.161180
Claim: preconditions, postconditions, and invariants are the *contract* between client and supplier — documented, checkable obligations whose violation is a bug on one specific side.
Implication: the plugin definition contract (Q20) should carry its obligations explicitly — Schema-validated contributions as preconditions, compiled-artifact guarantees as postconditions — and every compile diagnostic (Q22) should name the contracting party who broke it.

**Barbara Liskov & Jeannette M. Wing (1994). A Behavioral Notion of Subtyping.** *ACM Transactions on Programming Languages and Systems 16(6):1811–1841.*
[https://dl.acm.org/doi/10.1145/197320.197383](https://dl.acm.org/doi/10.1145/197320.197383) (open access) — free PDF: [CMU](https://www.cs.cmu.edu/~wing/publications/LiskovWing94.pdf)
Claim: substitutability is behavioral — subtype methods may not strengthen preconditions, weaken postconditions, or violate supertype invariants and history constraints; type-system compatibility alone proves nothing about behavior.
Implication: any `PasswordHasher` implementation type-checks, but only behavior makes it swappable (Q11) — hash strength, timing uniformity, and idempotence live in `@awthaq/test` contract assertions (Q31), which is Liskov–Wing operationalized.

### 5. The software architecture canon

**Dewayne E. Perry & Alexander L. Wolf (1992). Foundations for the Study of Software Architecture.** *ACM SIGSOFT Software Engineering Notes 17(4):40–52.*
[https://dl.acm.org/doi/10.1145/141874.141884](https://dl.acm.org/doi/10.1145/141874.141884) — free PDF: [Univ. of Bologna mirror](http://www.cs.unibo.it/~paolo.ciancarini/wwwpages/readings/perrywolf)
Claim: architecture = **components** (processing/data), **connectors** (interaction), and **constraints** (properties of the whole), organized into styles; connectors are first-class design objects with their own types.
Implication: awthaq's connectors are Effect objects — `Layer` composition, `HttpApi`, the event bus (Q13) — and the compiler must treat them as typed, validated citizens, not incidental wiring (Q10).

**Mary Shaw & David Garlan (1996). Software Architecture: Perspectives on an Emerging Discipline.** *Prentice Hall.*
[https://dl.acm.org/doi/book/10.5555/231003](https://dl.acm.org/doi/book/10.5555/231003) — companion paper "An Introduction to Software Architecture": [PDF](https://www.cimat.mx/~fory/ingsoft/9.pdf)
Claim: catalogs architectural **styles** (layers, pipes-and-filters, repository, event-based, client-server…) with explicit properties, and gives connectors (procedure call, event, pipe, shared data) explicit semantics.
Implication: awthaq is a named style — plugin-plus-compiler — and style consistency is what makes `auth plugin list`/`doctor` introspection possible (Q10, Q31); mixing styles (mutable registries inside a declarative system) is where prior frameworks decay.

**Frank Buschmann, Regine Meunier, Hans Rohnert, Peter Sommerlad, Michael Stal (1996). Pattern-Oriented Software Architecture, Volume 1: A System of Patterns.** *Wiley.*
[https://www.wiley.com/en-ca/pattern-oriented-software-architecture-volume-1-a-system-of-patterns-p-9781118725269](https://www.wiley.com/en-ca/pattern-oriented-software-architecture-volume-1-a-system-of-patterns-p-9781118725269) — ACM: [10.5555/249013](https://dl.acm.org/doi/10.5555/249013)
Claim: codifies the **Microkernel** pattern (minimal functional core + plug-ins + internal servers + adaptors), plus **Layers**, **Pipes and Filters**, and **Reflection** (self-inspection of the running structure).
Implication: POSA is the design-vocabulary checklist for the compiler: Microkernel → core/plugin split (Q20, Q51); Pipes-and-Filters → middleware phases (Q28); Reflection → `auth plugin list --graph` (Q10).

**Len Bass, Paul Clements, Rick Kazman. Software Architecture in Practice (4th ed.).** *Addison-Wesley (SEI Series), 2021.*
[https://www.sei.cmu.edu/library/software-architecture-in-practice-fourth-edition/](https://www.sei.cmu.edu/library/software-architecture-in-practice-fourth-edition/) — 3rd ed. on ACM: [10.5555/2392670](https://dl.acm.org/doi/book/10.5555/2392670)
Claim: quality-attribute scenarios and **modifiability tactics** — increase cohesion, reduce coupling, encapsulate, restrict dependencies, and *defer binding time* (illustrated in the book with plugins and configuration).
Implication: the tactics list is a design-review rubric for every plugin-contract decision (Q20–Q29); ATAM-style scenarios ("add an SMS-OTP plugin without touching core") should drive the Q31 harness.

**Erich Gamma, Richard Helm, Ralph Johnson, John Vlissides (1994). Design Patterns: Elements of Reusable Object-Oriented Software.** *Addison-Wesley.*
[https://www.oreilly.com/library/view/design-patterns-elements/0201633612/](https://www.oreilly.com/library/view/design-patterns-elements/0201633612/)
Claim (kept brief, as scoped): the composition patterns underpinning plugin composition — **Bridge** (capability interface ↔ implementations), **Strategy** (authentication strategies), **Decorator** (middleware around handlers), **Observer** (events/hooks) — and the book's thesis "favor object composition over class inheritance" is why plugin ecosystems can grow at all.
Implication: awthaq's plugin surface is these four patterns under a compiler: capabilities are Bridges, strategies are Strategies, middleware is Decorator, hooks/events are Observer (Q11, Q13, Q27, Q28).

### 6. Extensible operating-system kernels

The SOSP '95 trio attacked kernel extensibility from three directions — safe language (SPIN), minimal core with secure bindings (exokernel), and microkernel minimality (Liedtke) — and together they fixed the terms of the compile-time-vs-runtime tradeoff that awthaq inherits.

**Brian N. Bershad, Stefan Savage, Przemysław Pardyak, Emin Gün Sirer, Marc E. Fiuczynski, David Becker, Craig Chambers, Susan Eggers (1995). Extensibility, Safety and Performance in the SPIN Operating System.** *Proceedings of SOSP '95, pp. 267–284.*
[https://dl.acm.org/doi/10.1145/224056.224077](https://dl.acm.org/doi/10.1145/224056.224077) — free PDF: [Cornell mirror](https://www.cs.cornell.edu/people/egs/papers/spin-sosp95.pdf); project: [SPIN papers](https://www-spin.cs.washington.edu/papers/index.html)
Claim: kernel extensions written in a type-safe language (Modula-3) are dynamically linked into the running kernel; type safety plus link-time interposition replaces address-space protection, making extension calls as cheap as local procedure calls — no IPC boundary.
Implication: the strongest systems-science precedent for awthaq's thesis: when the extension language already guarantees safety, in-process composition needs no runtime enforcement layer. TypeScript + Effect types are our Modula-3; the plugin compiler is our dynamic linker (Q8, Q10).

**Dawson R. Engler, M. Frans Kaashoek, James O'Toole Jr. (1995). Exokernel: An Operating System Architecture for Application-Level Resource Management.** *Proceedings of SOSP '95, pp. 251–266.*
[https://dl.acm.org/doi/10.1145/224057.224076](https://dl.acm.org/doi/10.1145/224057.224076) — free PDF: [Wisconsin mirror](https://pages.cs.wisc.edu/~bart/736/papers/exo-sosp95.pdf)
Claim: a minimal kernel provides only **secure bindings** (safe grants and revocation of resources); all abstractions (file systems, networks, scheduling) move to untrusted library operating systems, letting applications pick or build their own.
Implication: the core/adapter split (G5, Q72–Q75): core grants and validates; repositories, mailers, hashers are "libauth" libraries an application swaps without core knowledge — the exokernel argument for capability-over-implementation (PRD §5.1).

**Jochen Liedtke (1995). On Micro-Kernel Construction.** *Proceedings of SOSP '95, pp. 237–250.*
[https://dl.acm.org/doi/10.1145/224056.224075](https://dl.acm.org/doi/10.1145/224056.224075)
Claim: derives which concepts *must* stay in a microkernel from functionality, IPC, and hardware constraints; states the **minimality principle** — "a concept is tolerated inside the µ-kernel only if moving it outside … would prevent the implementation of the system's required functionality."
Implication: the audit test for PRD §1.2's contribution list (Q20, Q51): for each core-owned contribution (events? audit? verification tokens?), ask whether plugins could implement it if the core exposed the right primitive — if yes, it moves out.

**Jochen Liedtke (1996). Toward Real Microkernels.** *Communications of the ACM 39(9):70–77.*
[https://dl.acm.org/doi/10.1145/234215.234473](https://dl.acm.org/doi/10.1145/234215.234473) (free access)
Claim: the retrospective on first-generation microkernels (Mach): performance came only after moving policy out of the kernel and minimizing IPC — the empirical cost of getting the core/extension boundary wrong.
Implication: the warning for the compiler: if core contributions start accumulating policy (default mailer, default roles), awthaq re-enacts Mach; keep policy in plugins, mechanism in core (Q51).

### 7. Isolation mechanisms and extension-technology tradeoffs

**Robert Wahbe, Steven Lucco, Thomas E. Anderson, Susan L. Graham (1993). Efficient Software-Based Fault Isolation.** *Proceedings of SOSP '93, pp. 203–216; also ACM SIGOPS Operating Systems Review 27(5).*
[https://dl.acm.org/doi/10.1145/168619.168635](https://dl.acm.org/doi/10.1145/168619.168635) — free PDF: [Stanford mirror](http://web.stanford.edu/class/archive/cs/cs295/cs295.1086/papers/wahbe93efficient.pdf)
Claim: untrusted binaries can run inside the host address space by rewriting code to check every memory access, at a few-percent cost — isolation *without* type safety or separate address spaces.
Implication: the quantified cost of the alternative world where plugins are untyped payloads needing runtime sandboxing; compile-time type checking is the cheap end of this spectrum — a *measured* argument for the compiler (Q10, Q30).

**Christopher Small & Margo Seltzer (1996). A Comparison of OS Extension Technologies.** *Proceedings of the 1996 USENIX Annual Technical Conference, San Diego, pp. 41–54.*
[https://www.usenix.org/conference/usenix-1996-annual-technical-conference/comparison-os-extension-technologies](https://www.usenix.org/conference/usenix-1996-annual-technical-conference/comparison-os-extension-technologies) — free PDF: [seltzer.com](https://www.seltzer.com/assets/publications/Comparison-of-OS-Extension-Technologies.pdf); ACM: [10.5555/1268299.1268303](https://dl.acm.org/doi/10.5555/1268299.1268303)
Claim: a taxonomy and head-to-head evaluation of extension technologies (kernel modules, user-level servers, safe-language extensions à la SPIN, VINO's SFI-plus-transactions) across performance, protection, and recoverability — **no single technology dominates**.
Implication: direct scientific validation that "compile-time vs runtime extension" is a choice with a price list: static compilation buys type-checked integration and zero sandbox overhead and gives up runtime installation — name the tradeoff in the docs (Q30) and don't pretend config alone replaces install.

**Margo I. Seltzer, Yasuhiro Endo, Christopher Small, Keith A. Smith (1996). Dealing With Disaster: Surviving Misbehaved Kernel Extensions.** *Proceedings of OSDI '96, pp. 213–227.*
[https://www.usenix.org/conference/osdi-96/dealing-disaster-surviving-misbehaved-kernel-extensions](https://www.usenix.org/conference/osdi-96/dealing-disaster-surviving-misbehaved-kernel-extensions) — ACM: [10.1145/238721.238779](https://dl.acm.org/doi/10.1145/238721.238779)
Claim: even recompilation-checked extensions misbehave (hang, corrupt, crash); VINO wraps each extension in a lightweight **transaction** with rollback, so the kernel survives the extension's failure.
Implication: compile-time validation is necessary, not sufficient — hooks need per-class failure semantics (Q27), and migration aggregation (Q26) needs transactional/rollback properties with a reviewable ledger, not just a topo sort.

**Douglas P. Ghormley, David Petrou, Steven H. Rodrigues, Thomas E. Anderson (1998). SLIC: An Extensibility System for Commodity Operating Systems.** *Proceedings of the 1998 USENIX Annual Technical Conference, New Orleans.*
[https://www.usenix.org/conference/1998-usenix-annual-technical-conference/slic-extensibility-system-commodity-operating](https://www.usenix.org/conference/1998-usenix-annual-technical-conference/slic-extensibility-system-commodity-operating) — free PDF: [usenix.org](http://usenix.org/publications/library/proceedings/usenix98/full_papers/ghormley/ghormley.pdf)
Claim: instead of a new kernel architecture, SLIC **interposes trusted extensions on existing kernel interfaces**, composable across multiple third parties with enforced order, requiring only trivial kernel changes — extensions protected from apps, enforced on uncooperative apps, composed from different vendors.
Implication: the third-party extension point is a real, named design object: awthaq's named middleware phases and hook points (Q27, Q28) with compiler-enforced ordering are SLIC's interposition model at application scale.

### 8. Language-based extension systems (processes inside a safe language)

**Thorsten von Eicken, Chi-Chao Chang, Grzegorz Czajkowski, Chris Hawblitzel, Deyu Hu, Dan Spoonhower (1999). J-Kernel: A Capability-Based Operating System for Java.** *Secure Internet Programming (LNCS 1603), pp. 369–393, Springer.*
[https://link.springer.com/chapter/10.1007/3-540-48749-2_17](https://link.springer.com/chapter/10.1007/3-540-48749-2_17)
Conference precursor: Chris Hawblitzel, Chi-Chao Chang, Grzegorz Czajkowski, Deyu Hu, Thorsten von Eicken, **Implementing Multiple Protection Domains in Java**, *1998 USENIX Annual Technical Conference*, [PDF](https://www.usenix.org/publications/library/proceedings/usenix98/full_papers/hawblitzel/hawblitzel.pdf).
Claim: protection domains ("tasks") inside a JVM communicate only via **capabilities** (unforgeable object references) transferred by deep copy or controlled sharing — no ambient authority, no global namespace.
Implication: the vocabulary source for capability strings as *authority* rather than labels (Q21, Q23): a plugin holding `auth.hasher` holds a reference to *some* provider, substitutable and revocable — never a direct grab of another plugin's internals (PRD §5.1).

**Godmar Back, Wilson C. Hsieh, Jay Lepreau (2000). Processes in KaffeOS: Isolation, Resource Management, and Sharing in Java.** *Proceedings of OSDI 2000.*
[https://www.usenix.org/conference/osdi-2000/processes-kaffeos-isolation-resource-management-and-sharing-java](https://www.usenix.org/conference/osdi-2000/processes-kaffeos-isolation-resource-management-and-sharing-java) — project HTML: [Utah Flux](https://www-old.cs.utah.edu/flux/papers/kaffeos-osdi00/main.html); journal version: Back & Hsieh, *ACM TOPLAS* 27:583–630, 2005
Claim: the OS process model brought into a JVM — kernel/user heaps with write barriers, per-process collectable heaps, and **rations** (preemptible resource accounting) so no task can exhaust the runtime.
Implication: two lessons for the core: core-owned data (users/sessions, Q25) is "kernel heap" — plugins never get direct references; and plugins consuming resources (hash cost, rate-limit quota, migration time) should declare budgets the compiler or startup can check (Q26, Q37).

**Patrick Tullmann (1999). The Alta Operating System.** *Master's thesis, University of Utah (Flux group).* `[thesis — non-academic engineering canon]`
[https://www-old.cs.utah.edu/flux/papers/tullmann-thesis.pdf](https://www-old.cs.utah.edu/flux/papers/tullmann-thesis.pdf)
Claim: implements the Fluke **nested process model** inside a Java VM, showing a full process hierarchy (isolation, IPC, parent/child resource semantics) can be layered in a type-safe runtime; cited throughout the Java-OS literature (KaffeOS, J-Kernel comparisons).
Implication: when the runtime already provides fibers, scopes, and context, process-model semantics (per-tenant isolation, parent-scoped teardown) should compose from those primitives (Effect `Scope`/`FiberRef`/`LayerMap`, Q30) rather than be reinvented as plugin-level features.

### Verification notes & corrections to the assignment brief

- **Meyer OCP (1988):** the principle is §2.3 of *Object-Oriented Software Construction* (book), confirmed by Meyer's own blog; no standalone 1988 article exists — cite the book.
- **SLIC:** USENIX **1998** (Ghormley, Petrou, Rodrigues, Anderson), not VINO-related and not 1996; the "~1996" extension-technology comparison is Small & Seltzer, a separate paper (verified above).
- **Alta:** a University of Utah (Flux) project by Patrick Tullmann — canonical citable form is his **1999 Master's thesis** (labeled non-academic); it is *not* a Sirer/Washington paper as occasionally mis-cited.
- **J-Kernel:** canonical forms are USENIX ATC **1998** ("Implementing Multiple Protection Domains in Java") and the LNCS **1999** chapter; no verified 1996 version — do not cite 1996.
- **Parnas 1972b:** *A Technique for Software Module Specification…* is CACM **15(5), May 1972** (pp. 330–336) — a different issue from the December decomposition paper.

## Cross-cutting themes for awthaq

- **Q20 plugin contract — design rules first (Baldwin & Clark; Parnas 1976).** The contract is the family definition: required fields minimal (`id`, `apiVersion`), everything else optional and declarative. Freezing this early and visibly is the highest-leverage act in the project; plugins are options priced against stable rules.
- **Q21/Q23 capability strings — unforgeable authority (J-Kernel).** Namespaced capability strings plus `Context.Tag` requirements give the object-capability property: plugins hold references to providers, not global mutable registries; exclusivity (`provides`/`conflicts`) is the compiler checking one authority is not held twice.
- **Q8/Q22 Layer graph & cycles — Dijkstra's discipline.** Strict layering makes the compile proof tractable; Kahn's algorithm enforces THE's layer hierarchy so the *type system never does graph reasoning* (09 owns the TS-cliff evidence; this file supplies the principle).
- **Q27/Q28 hooks & middleware — interposition with semantics (SLIC; POSA; VINO).** Hook points are interposition interfaces: named, ordered, composable across third parties; failure semantics belong in the interface type, and runtime containment must cover what compile time cannot rule out.
- **Q26 migrations — transactions and survival (VINO; KaffeOS).** Aggregated migrations are a multi-author transaction: deterministic topo order, a ledger, destructive-op guards, and a rollback story — OS extension systems are judged by whether the system survives the extension.
- **Q30 static install vs runtime config — a priced choice (Small & Seltzer; SFI).** Compile-time-only installation is one point in a 30-year-old design space; state what it buys (type-checked integration, no sandbox, no IPC) and what it costs (no runtime install); configuration-as-data validated at boot is the bounded-runtime half.
- **Q31 contract tests — contracts and behavioral subtyping made executable (Meyer; Liskov & Wing).** The RuleTester-style harness is where behavior-level obligations live: hash-algorithm swap tests, timing-uniformity invariants, subset-withdrawal validity (Parnas 1979's contraction test), and DSM-style coupling metrics (MacCormack) trended in CI.
- **Q51 core minimality — the Liedtke audit.** "A concept is tolerated inside the core only if moving it outside prevents implementing required functionality": run this over the PRD §1.2 contribution list; organizations, api-keys, passkeys should pass *out* of core with zero core knowledge — and even audit/events should have to justify residency.
- **Q10/Q29 connectors — first-class typed things (Perry & Wolf; Shaw & Garlan).** `Layer`, `HttpApi`, and the event bus are the system's connectors; the compiler validates connectors and derives clients from them, which makes one-contract client derivation (Q29) an architectural-style property, not a codegen trick.
- **Q11 capability interfaces — information hiding (Parnas 1972; Bridge).** Every capability interface hides a *secret* (which algorithm, which provider); the interface is the hiding boundary — keep interfaces small and few, because each one is a frozen design rule.

## People & research groups

- **David L. Parnas** (McMaster → U. Limerick) — information hiding, module specification, program families. Collected in *Software Fundamentals* (Hoffman & Weiss, eds., Addison-Wesley 2001).
- **Herbert A. Simon** (Carnegie Mellon; 1916–2001) — near-decomposability, sciences of the artificial. Nobel laureate; *The Sciences of the Artificial*, MIT Press.
- **Edsger W. Dijkstra** (Eindhoven; 1930–2002) — THE system, layered construction. EWD archive: [UT Austin](https://www.cs.utexas.edu/~EWD/).
- **Barbara Liskov** (MIT CSAIL, Programming Methodology Group) — behavioral subtyping, CLU, abstraction.
- **Jeannette M. Wing** (Columbia; formerly CMU) — behavioral subtyping, computational thinking. [Publications](https://www.cs.cmu.edu/~wing/publications/).
- **Bertrand Meyer** (ETH Zurich; Eiffel) — design by contract, OCP. [technology+ blog](https://bertrandmeyer.com/).
- **Mary Shaw & David Garlan** (CMU) — founded software architecture as a discipline; styles and connectors.
- **Frank Buschmann, Peter Sommerlad, Michael Stal** (Siemens / POSA) — the pattern system including Microkernel and Reflection.
- **Len Bass, Paul Clements, Rick Kazman** (SEI, CMU) — architecture in practice, quality attributes, ATAM. [SEI](https://www.sei.cmu.edu/).
- **Carliss Y. Baldwin & Kim B. Clark** (Harvard Business School) — design rules, modularity economics, option theory of design.
- **Alan MacCormack** (HBS) — empirical DSM studies of software architecture and evolution.
- **Brian Bershad, Przemysław Pardyak, Emin Gün Sirer** (U. Washington; Sirer now Cornell) — SPIN, safe-language extension. [SPIN project](https://www-spin.cs.washington.edu/).
- **M. Frans Kaashoek** (MIT PDOS) & **Dawson Engler** (then MIT, now Stanford) — exokernel, secure bindings. [PDOS](https://pdos.csail.mit.edu/).
- **Jochen Liedtke** (GMD → IBM Zürich → U. Karlsruhe; 1953–2001) — L4 microkernels, minimality principle. [Wikipedia](https://en.wikipedia.org/wiki/Jochen_Liedtke).
- **Margo Seltzer** (Harvard → UBC) — VINO, extension technologies; hosts the classic PDFs at [seltzer.com](https://www.seltzer.com/margo/).
- **Christopher Small** (Harvard, VINO) — extension-technology comparison, misbehaved-extension survival.
- **Doug Ghormley & Thomas E. Anderson** (U. Washington) — SLIC interposition.
- **Thorsten von Eicken & Chris Hawblitzel** (Cornell; Hawblitzel later Microsoft Research) — J-Kernel, language-based protection. [Hawblitzel](https://chrishawblitzel.net/).
- **Godmar Back, Wilson C. Hsieh, Jay Lepreau** (U. Utah Flux group) — KaffeOS, Java OS processes. [Flux](https://www.flux.utah.edu/).
- **Patrick Tullmann** (U. Utah Flux) — Alta, nested processes in Java.

## Suggested reading order

One paper per week; the order is thesis → theory → vocabulary → economics → systems evidence.

1. **Parnas 1972** — the definition of a module: hide the decisions that will change; capability interfaces fall out of this immediately.
2. **Parnas 1976** — program families: the plugin contract is a family specification, not an interface collection.
3. **Dijkstra 1968** — layers as proof-by-construction: why the Layer graph and its acyclicity are the product's backbone.
4. **Meyer 1992 (Applying DbC)** — obligations, contracts, and blame assignment: the grammar for compile diagnostics and the Q31 harness.
5. **Liskov & Wing 1994** — what swappable *really* requires behaviorally: the theory behind contract tests for capability implementations.
6. **Perry & Wolf 1992** — components/connectors/constraints: vocabulary for treating HttpApi/Layer/events as first-class validated connectors.
7. **Baldwin & Clark 1997 (HBR)** — the economics: freeze design rules, sell options; why the plugin registry and governance (Q7, Q23) are load-bearing.
8. **Liedtke 1995** — the minimality principle: the audit test for what stays in core (Q20, Q51).
9. **Bershad 1995 (SPIN)** — safe-language extensions make in-process composition cheap: the systems argument for the compile-time bet.
10. **Small & Seltzer 1996** — the honest price list of extension technologies: how to state what static compilation buys and gives up (Q30).

## Open questions

1. **Freeze timing for the design rules (Q20).** Baldwin & Clark argue option value appears only after rules are frozen — but Parnas's families warn the family definition itself evolves. What is the *minimal* v1 plugin contract that can survive Plugin API 2 without a codemod cliff (09's Gatsby lesson)? User decision, with a scientific deadline: every ecosystem plugin added before the freeze makes the freeze harder.
2. **How much VINO in the runtime? (Q26, Q27)** Compile-time validation cannot rule out hangs, resource exhaustion, or behavioral violations (Liskov–Wing). Should hooks carry per-plugin budgets (KaffeOS rations) and migrations be strictly transactional with rollback, or is ledger-plus-guardrails enough at v1?
3. **Is there ever a sanctioned dynamic path? (Q30)** SPIN loads extensions at runtime; awthaq compiles statically. Is recompile-and-redeploy the only install path (pure static), or is `LayerMap`-keyed per-tenant plugin *selection* among installed plugins the bounded runtime analog of SPIN's linker — and where exactly is that line in the docs?
4. **Substitutability conformance — who checks behavior? (Q11, Q31)** Liskov–Wing says the type system cannot; the contract suite must. Should `@awthaq/test` ship reference behavioral suites per core capability (`PasswordHasher`, `RateLimiter`), or only compiler-facing checks, leaving behavioral conformance to each implementation's own tests?
5. **Coupling budget (Q8, Q19).** MacCormack makes design structure measurable. Should CI track propagation cost of the compiled graph (contributions × plugins) with a budget that blocks Plugin API growth — and what threshold is defensible before v1 data exists?
6. **Contraction guarantee (Q20, Q31).** Parnas 1979 requires every subset to be valid. Should the compiler reject *accidental dependencies* — configurations valid only because two plugins happen to coexist (a plugin consuming another's capability without declaring it) — even when the graph happens to work?

## Sources

- https://dl.acm.org/doi/10.1145/361598.361623
- https://wstomv.win.tue.nl/edu/2ip30/references/criteria_for_modularization.pdf
- https://dl.acm.org/doi/10.1145/355602.361309
- https://cacm.acm.org/research/a-technique-for-software-module-specification-with-examples/
- https://dl.acm.org/doi/10.1109/TSE.1976.233797
- https://ieeexplore.ieee.org/document/1702332/
- https://dl.acm.org/doi/10.1109/TSE.1979.234169
- https://www.dre.vanderbilt.edu/~schmidt/PDF/family.pdf
- https://dl.acm.org/doi/10.1145/363095.363143
- https://direct.mit.edu/books/monograph/4551/The-Sciences-of-the-Artificial
- https://dl.acm.org/doi/10.1145/197320.197383
- https://www.cs.cmu.edu/~wing/publications/LiskovWing94.pdf
- https://dl.acm.org/doi/10.1145/141874.141884
- http://www.cs.unibo.it/~paolo.ciancarini/wwwpages/readings/perrywolf
- https://dl.acm.org/doi/book/10.5555/231003
- https://www.cimat.mx/~fory/ingsoft/9.pdf
- https://www.wiley.com/en-ca/pattern-oriented-software-architecture-volume-1-a-system-of-patterns-p-9781118725269
- https://dl.acm.org/doi/10.5555/249013
- https://www.sei.cmu.edu/library/software-architecture-in-practice-fourth-edition/
- https://dl.acm.org/doi/book/10.5555/2392670
- https://www.oreilly.com/library/view/design-patterns-elements/0201633612/
- https://en.wikipedia.org/wiki/Object-Oriented_Software_Construction
- https://bertrandmeyer.com/2021/02/26/some-contributions/
- https://se.inf.ethz.ch/~meyer/publications/computer/contract.pdf
- https://direct.mit.edu/books/monograph/1856/Design-Rules-Volume-1The-Power-of-Modularity
- https://hbr.org/1997/09/managing-in-an-age-of-modularity
- https://ideas.repec.org/a/inm/ormnsc/v52y2006i7p1015-1030.html
- https://www.hbs.edu/ris/Publication%20Files/05-016.pdf
- https://dl.acm.org/doi/10.1145/224056.224077
- https://www.cs.cornell.edu/people/egs/papers/spin-sosp95.pdf
- https://www-spin.cs.washington.edu/papers/index.html
- https://dl.acm.org/doi/10.1145/224057.224076
- https://pages.cs.wisc.edu/~bart/736/papers/exo-sosp95.pdf
- https://dl.acm.org/doi/10.1145/224056.224075
- https://dl.acm.org/doi/10.1145/234215.234473
- https://dl.acm.org/doi/10.1145/168619.168635
- http://web.stanford.edu/class/archive/cs/cs295/cs295.1086/papers/wahbe93efficient.pdf
- https://www.usenix.org/conference/usenix-1996-annual-technical-conference/comparison-os-extension-technologies
- https://www.seltzer.com/assets/publications/Comparison-of-OS-Extension-Technologies.pdf
- https://dl.acm.org/doi/10.5555/1268299.1268303
- https://www.usenix.org/conference/osdi-96/dealing-disaster-surviving-misbehaved-kernel-extensions
- https://dl.acm.org/doi/10.1145/238721.238779
- https://www.usenix.org/conference/1998-usenix-annual-technical-conference/slic-extensibility-system-commodity-operating
- http://usenix.org/publications/library/proceedings/usenix98/full_papers/ghormley/ghormley.pdf
- https://link.springer.com/chapter/10.1007/3-540-48749-2_17
- https://www.usenix.org/publications/library/proceedings/usenix98/full_papers/hawblitzel/hawblitzel.pdf
- https://www.usenix.org/conference/osdi-2000/processes-kaffeos-isolation-resource-management-and-sharing-java
- https://www-old.cs.utah.edu/flux/papers/kaffeos-osdi00/main.html
- https://www-old.cs.utah.edu/flux/papers/tullmann-thesis.pdf
- https://en.wikipedia.org/wiki/Jochen_Liedtke
- https://www.cs.utexas.edu/~EWD/
