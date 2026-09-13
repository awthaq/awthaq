# Extensibility Theory (CBSE, Contracts, DI, Pub/Sub, Reflection, Product Lines, Feature Interaction) — Scientific Literature

Domain: the scientific canon behind component-based software engineering, contracts, dependency injection, publish/subscribe, reflection, software product lines, and the telecom feature-interaction problem. All entries verified against primary sources (Crossref, arXiv, publisher pages) on 2026-09-12. Practitioner prior art (Fastify, Nuxt, VS Code, …) lives in `research/09-plugin-architecture.md` — this file cites the research literature instead of duplicating it.

## TL;DR

- **Components are defined by contracts, not classes**: Szyperski's definition (independent deployment, third-party composition, no hidden external state) is the exact spec for a plugin record (`definePlugin()` → frozen declarative artifact, Q20).
- **Beugnard et al.'s four contract levels** (syntactic, behavioral, synchronization, quality-of-service) give awthaq a design ladder: the plugin compiler should say *which level each check runs at* (Q20/Q31).
- **Meyer's Design by Contract** makes obligation/benefit symmetric and explicit; Helm et al. anticipated "what you may touch" (frame) — the theory behind capability scoping and conflict errors (Q21–Q26).
- **DI is an empirically testable claim, not a virtue**: Yang/Tempero/Melton operationalized and measured it (34 Java apps); Laigner et al. cataloged its anti-patterns — awthaq should turn DI discipline into compiler checks and contract tests (Q21/Q31).
- **Pub/sub is a taxonomy, not a mechanism** (Eugster et al.): topic/content/type-based subscription, time/space coupling, delivery guarantees — the vocabulary for the awthaq event bus (Q13).
- **Event logs evolve poorly by default**: Overeem et al.'s five tactics (versioned events, weak schema, upcasting, in-place transformation, copy-and-transform) are the policy menu for plugin schema/event evolution (Q25/Q100).
- **Reflection research separates the meta-level from the base level** (Smith, Maes, Kiczales et al.): plugin *declarations* must be inspectable without executing plugin code — the compiler is the causally-connected meta-object (Q9/Q10/Q95).
- **Software product lines treat a feature set as a formal configuration space** (FODA, Czarnecki, Batory, Apel/Kästner, Thüm et al.): `Auth.make({ plugins })` instantiates a product from a family; the compiler's checks are feature-model analyses (Q5/Q23/Q30).
- **Feature interaction is 40 years old and unsolved in general**: the telecom literature (Keck & Kuehn; Zave & Jackson) classifies detection vs resolution and shows explicit interfaces make interactions enumerable — the direct theory base for route/schema/hook conflict detection (Q24–Q27).
- **Hooks are a studied construct**: framework hook methods (Johnson & Foote), Extension Interfaces (POSA2), and before/after metaclasses (Forman & Danforth) all argue for *small, typed, order-explicit* extension points (Q27/Q28).

## Annotated bibliography

### Components & component-based software engineering

*Cluster question: what must be true for third-party code to be composed safely at all.*

**Clemens Szyperski (1998; 2nd ed. 2002). Component Software: Beyond Object-Oriented Programming.** *Addison-Wesley / ACM Press.* [InformIT](https://www.informit.com/store/component-software-beyond-object-oriented-programming-9780201745726) — Defines the component as a unit of independent deployment, independent composition by third parties, and no (externally) observable state; taxonomy of binding times (compile/link/load/run). For awthaq: the plugin record is a *component* in exactly this sense — third-party composed, separately versioned (`apiVersion`), assembled statically into a Layer graph (Q20, Q4).

**George T. Heineman & William T. Councill, eds. (2001). Component-Based Software Engineering: Putting the Pieces Together.** *Addison-Wesley.* [Google Books](https://books.google.com/books?vid=ISBN0201704854) — The CBSE textbook canon; source of the working definition ("a software element that conforms to a component model and can be independently deployed and composed subject to the composition model"). Awthaq's plugin contract *is* the component model: conformance is machine-checkable, which is what the contract-test harness must assert (Q20/Q31).

### Contracts & design by contract

*Cluster question: what parties can rely on — and who is to blame when it breaks.*

**Bertrand Meyer (1992). Applying "Design by Contract".** *IEEE Computer 25(10):40–51.* [doi:10.1109/2.161279](https://doi.org/10.1109/2.161279) — Contracts make obligations and benefits symmetric and documentable (preconditions, postconditions, invariants) between suppliers and clients. The plugin contract's `provides`/`requires`/`conflicts` declarations are precisely such a bilateral contract; every compile diagnostic should state *which* clause was violated (Q21, Q23).

**Richard Helm, Ian M. Holland, Dipok Gangopadhyay (1990). Contracts: Specifying Behavioral Compositions in Object-Oriented Systems.** *OOPSLA/ECOOP '90, ACM SIGPLAN Notices 25(10):169–180.* [doi:10.1145/97946.97967](https://doi.org/10.1145/97946.97967) — Extends contracts beyond pre/post to *modification specifications* — what each collaborating party may read/write. This is the academic ancestor of "middleware must declare what it reads" and of scoped side effects on shared tables (Q25, Q28).

**Antoine Beugnard, Jean-Marc Jézéquel, Noël Plouzeau, Damien Watkins (1999). Making Components Contract Aware.** *IEEE Computer 32(7):38–45.* [doi:10.1109/2.774917](https://doi.org/10.1109/2.774917) (open access: [HAL](https://inria.hal.science/hal-01794333)) — The four contract levels: (1) syntactic, (2) behavioral, (3) synchronization, (4) quality of service — arguing components whose contracts stop at level 1 cannot be safely composed. Awthaq should locate each compiler check on this ladder: `definePlugin()` shape checks are level 1; route/schema/hook conflict validation is level 2; ordering/phase rules (middleware phases, hook ordering) are level 3; rate limits and latency budgets are level 4 (Q20, Q27, Q28, Q31).

**Antoine Beugnard, Jean-Marc Jézéquel, Noël Plouzeau (2010). Contract Aware Components, 10 years after.** *arXiv:1010.2822.* [arXiv](https://arxiv.org/abs/1010.2822) — Retrospective survey of where contract-aware components landed (embedded systems, SOA) and what remained unsolved; useful calibration for what awthaq can realistically enforce at compile time in a TS ecosystem (Q20).

**Jean-Marc Jézéquel, Bertrand Meyer (1997). Design by Contract: The Lessons of Ariane.** *IEEE Computer 30(1):129–130.* [doi:10.1109/2.562936](https://doi.org/10.1109/2.562936) — Post-mortem of Ariane 5: reused code whose *operational environment* changed, with the contract violation surfacing as an exception the system didn't survive. Warning for plugin ecosystems: a plugin is reused code in a new environment; contract violations must fail loudly at compile/startup, never silently at first request (Q30).

**Bertrand Meyer (1997). Object-Oriented Software Construction, 2nd ed.** *Prentice Hall.* [Google Books](https://books.google.com/books?vid=ISBN9780136291558) — The full-length treatment of design by contract in context (inheritance contracts, exception handling, openness). The reference to hand to plugin authors when the question is "who is to blame when a precondition fails?" (Q20, Q31).

### Dependency injection & wiring

*Cluster question: whether indirection-for-substitution actually pays its costs.*

**Martin Fowler (2004). Inversion of Control Containers and the Dependency Injection pattern.** *martinfowler.com.* [article](https://martinfowler.com/articles/injection.html) — `non-academic` but the canonical definition of DI vs service locator vs constructor injection, and of the plugin/registry relationship ("the plugin approach is more flexible but harder to debug"). Awthaq's `Context.Tag`/Layer composition is constructor injection with a type-indexed registry — the variant Fowler and the empirical studies below favor (Q21).

**Hong Yul Yang, Ewan Tempero, Hayden Melton (2008). An Empirical Study into Use of Dependency Injection in Java.** *19th Australian Conference on Software Engineering (ASWEC 2008):239–247.* [doi:10.1109/ASWEC.2008.4483212](https://doi.org/10.1109/ASWEC.2008.4483212) — Turns "DI improves extensibility, modifiability, testability, reusability" into operational definitions with detection techniques, applied to 34 open-source Java applications. Lesson: awthaq should *measure* whether its capability/Layer pattern delivers the claimed substitutability (e.g., in contract tests swapping `PasswordHasher`), rather than assume it (Q11, Q18, Q31).

**Rodrigo Laigner, Marcos Kalinowski, Luiz Carvalho, Diogo Mendonça, Alessandro Garcia (2019). Towards a Catalog of Java Dependency Injection Anti-Patterns.** *SBES 2019:104–113.* [doi:10.1145/3350768.3350771](https://doi.org/10.1145/3350768.3350771) — Mines open-source Java systems and developer discussions to catalog how DI is *misused* (hidden dependencies, god-injectors, runtime-only wiring surprises). Direct input for `@awthaq/test`: each anti-pattern should have a contract test or compile check (Q21, Q31).

### Events & publish/subscribe

*Cluster question: choosing and operating the extension's asynchronous surface.*

**Patrick Th. Eugster, Pascal A. Felber, Rachid Guerraoui, Anne-Marie Kermarrec (2003). The Many Faces of Publish/Subscribe.** *ACM Computing Surveys 35(2):114–131.* [doi:10.1145/857076.857078](https://doi.org/10.1145/857076.857078) — The standard taxonomy: topic-, content-, and type-based subscription; decoupling in space, time, and synchronization; and the quality dimensions (delivery guarantees, ordering, scalability) each scheme trades off. Awthaq's event bus (Q13) should pick its point in this space explicitly — typed (schema-checked) subscriptions with delivery classification and observer fail-isolation — instead of an ad-hoc EventEmitter.

**Jay Kreps (2013). The Log: What every software engineer should know about real-time data's unifying abstraction.** *LinkedIn Engineering.* [article](https://www.linkedin.com/blog/engineering/distributed-systems/log-what-every-software-engineer-should-know-about-real-time-datas-unifying) — `non-academic` canonical text on the append-only log as the unifying abstraction for streams, audit, and state-machine replication. Frames why audit events (Q49) and session revocation (Q45) want an ordered, durable event substrate rather than in-process callbacks.

**Martin Fowler (2005). Event Sourcing.** *martinfowler.com (bliki).* [article](https://martinfowler.com/eaaDev/EventSourcing.html) — `non-academic` definition of event sourcing (state = fold of events). Awthaq should not be event-sourced by default, but the pattern is the correct backbone for audit trails and for replaying tenant configuration changes (Q49, Q30).

**Michiel Overeem, Marten Spoor, Slinger Jansen, Sjaak Brinkkemper (2021). An Empirical Characterization of Event Sourced Systems and Their Schema Evolution — Lessons from Industry.** *Journal of Systems and Software 178:110970.* [doi:10.1016/j.jss.2021.110970](https://doi.org/10.1016/j.jss.2021.110970) (open access preprint: [arXiv:2104.01146](https://arxiv.org/abs/2104.01146)) — Grounded-theory study of 19 event-sourced systems; identifies schema evolution as *the* pain point and catalogs five tactics: versioned events, weak schema, upcasting, in-place transformation, copy-and-transform. These are exactly the allowed tactics for evolving plugin-contributed schemas/events across `apiVersion` majors (Q25, Q100).

**Martin Kleppmann, Adam Wiggins, Peter van Hardenberg, Mark McGranaghan (2019). Local-first software: you own your data, in spite of the cloud.** *Onward! 2019:154–178.* [doi:10.1145/3359591.3359737](https://doi.org/10.1145/3359591.3359737) — Academic anchor for sync-over-events architectures and the "server as a dumb pipe" stance; informs the client/SSR story (auth client works against a local session cache; sync is additive) (Q82–Q84).

### Reflection, metaclasses & metaobject protocols

*Cluster question: how a system can reason about its own structure safely.*

**Brian Cantwell Smith (1982). Procedural Reflection in Programming Languages.** *PhD thesis, MIT Laboratory for Computer Science (MIT-LCS-TR-272).* [DSpace@MIT](https://dspace.mit.edu/entities/publication/471a211a-d317-46da-89e4-6a0d9d10488b) — Introduces procedural reflection and the tower of meta-circular interpreters (3-Lisp): a system that reasons effectively about its own structure because the meta-level is *causally connected* to the base level. For awthaq: the plugin compiler is that meta-level — plugin declarations are data the compiler can reason about because they are explicitly reified, never hidden inside functions (Q10, Q95).

**Brian Cantwell Smith (1984). Reflection and Semantics in Lisp.** *POPL '84:23–35.* [doi:10.1145/800017.800513](https://doi.org/10.1145/800017.800513) (open access PDF on the author's site: [ageofsignificance.org](http://www.ageofsignificance.org/documents/Reflection%20and%20Semantics%20in%20Lisp.pdf)) — The compact version of the thesis: reflection primitives must preserve the semantics they expose. Warning against "reflection holes" where introspection lies — plugin metadata (`auth plugin list`) must be derived from the same artifact the compiler validated, not recomputed (Q95).

**Pattie Maes (1987). Concepts and Experiments in Computational Reflection.** *OOPSLA '87, ACM SIGPLAN Notices 22(12):147–155.* [doi:10.1145/38807.38821](https://doi.org/10.1145/38807.38821) — Defines computational reflection: making the language's implicit structures explicit as *meta-objects*, so a program can inspect and adjust its own behavior. The design pattern to copy: raise plugin contributions (routes, schemas, hooks, capabilities) to first-class, queryable meta-objects in the compiled artifact (Q10, Q14).

**Pierre Cointe (1987). Metaclasses are first class: The ObjVlisp Model.** *OOPSLA '87, ACM SIGPLAN Notices, pp.156–162.* [doi:10.1145/38807.38822](https://doi.org/10.1145/38807.38822) — Shows metaclasses themselves can be ordinary objects, so the extension mechanism needs no privileged machinery. For awthaq: hook points and contribution kinds should be data-driven registry entries — no compiler magic per kind (Q10, Q27).

**Gregor Kiczales, Jim des Rivières, Daniel G. Bobrow (1991). The Art of the Metaobject Protocol.** *MIT Press.* [Google Books](https://books.google.com/books?vid=ISBN9780262610742) — The design discipline for exposing an implementation's choices through a *minimal*, well-specified meta-interface instead of ad-hoc hooks. The plugin compiler's extension surface (hook points, contribution kinds, diagnostic codes) should be designed as a MOP: small, versioned, and specified (Q20, Q27).

**Ira R. Forman, Scott H. Danforth (1999). Putting Metaclasses to Work: A New Dimension in Object-Oriented Programming.** *Addison-Wesley.* [Google Books](https://books.google.com/books?vid=ISBN0201433052) — The metaclass model (developed for IBM's SOM) as the composition mechanism for class behavior — including composing *before/after* behavior around existing methods. The direct ancestor of typed before/after hook composition (Q27).
**Ira R. Forman, Scott H. Danforth, Hari Madduri (1994). Composition of Before/After Metaclasses in SOM.** *OOPSLA '94, ACM SIGPLAN Notices 29(10):427–439.* [doi:10.1145/191081.191148](https://doi.org/10.1145/191081.191148) — Formalizes the composition of multiple before/after behaviors around the same method — the exact problem of several plugins tapping one hook point — and shows the ordering/combination rules must be part of the composition system, not left to registration luck (Q27).


### Software product lines & feature-oriented software development

*Cluster question: a plugin set as a formal configuration space.*

**Kyo C. Kang, Sholom G. Cohen, James A. Hess, William E. Novak, A. Spencer Peterson (1990). Feature-Oriented Domain Analysis (FODA) Feasibility Study.** *CMU/SEI-90-TR-21, Software Engineering Institute.* [full text](https://www.researchgate.net/publication/215588323_Feature-Oriented_Domain_Analysis_FODA_feasibility_study) — Origin of the *feature model*: commonality/variability analysis with AND/OR/XOR feature diagrams, mandatory/alternative/optional features. `Auth.make({ plugins })` is a feature-model instantiation; multi-tenancy (Q5) is several instantiations of one family.

**Christian Prehofer (1997). Feature-Oriented Programming: A Fresh Look at Objects.** *ECOOP '97, LNCS 1241:419–443.* [doi:10.1007/bfb0053389](https://doi.org/10.1007/bfb0053389) — Features as units of increment that refine a base object; formalizes "feature = the smallest composable increment of functionality". Awthaq plugins are exactly such increments over core auth (Q20).

**Krzysztof Czarnecki, Ulrich W. Eisenecker (2000). Generative Programming: Methods, Tools, and Applications.** *Addison-Wesley.* [Google Books](https://books.google.com/books/about/Generative_Programming.html?id=4CPmr3qcVvYC) — Puts feature models + configuration knowledge + generators into one engineering discipline: the program family is designed around variability, and the generator emits the concrete product. The blueprint for the awthaq plugin compiler: contributions + config knowledge in, compiled Effect app out (Q30, Q95).

**Krzysztof Czarnecki, Ulrich W. Eisenecker, Robert Glück, David Vandevoorde, Todd Veldhuizen (2000). Generative Programming and Active Libraries.** *Seminar on Generic Programming, LNCS 1944:25–39.* [doi:10.1007/3-540-39953-4_3](https://doi.org/10.1007/3-540-39953-4_3) — The compact programmatic statement of generative programming: configuration knowledge drives the generator; libraries become active participants in construction. Frames the awthaq compiler as an "active library" for auth (Q95).


**Don Batory, Jacob Neal Sarvela, Axel Rauschmayer (2004). Scaling Step-Wise Refinement.** *IEEE Transactions on Software Engineering 30(6):355–371.* [doi:10.1109/TSE.2004.23](https://doi.org/10.1109/TSE.2004.23) (open access PDF: [UT Austin](https://www.cs.utexas.edu/~schwartz/ATS/fopdocs/AHEAD-Theory.pdf)) — AHEAD: features as algebraic refinements (add/extend/replace) whose composition is an expression; product lines as sets of expressions over a feature algebra. Motivates awthaq's rule that plugin composition must be *closed and validated* — arbitrary expression orders are type-error territory (Q22, Q27).

**Krzysztof Czarnecki, Andrzej Waśowski (2007). Feature Diagrams and Logics: There and Back Again.** *SPLC 2007:23–34.* [doi:10.1109/SPLINE.2007.24](https://doi.org/10.1109/SPLINE.2007.24) — Formal semantics of feature diagrams and their translations to propositional/predicate logics. Gives the compiler a sound vocabulary for `requires`/`conflicts`/exclusivity over capabilities — a feature model with constraints is exactly a capability graph (Q23, Q30).

**David Benavides, Sergio Segura, Antonio Ruiz-Cortés (2010). Automated Analysis of Feature Models 20 Years Later: A Literature Review.** *Information Systems 35(6):615–636.* [doi:10.1016/j.is.2010.01.001](https://doi.org/10.1016/j.is.2010.01.001) — Systematic review of every known feature-model analysis (validity, dead features, explanations) and the reasoning engines behind them (SAT, BDD, CSP). Awthaq's conflict diagnostics (why is this combination invalid?) should adopt the *explanation* output style this literature matured (Q22–Q24, Q27).

**Sven Apel, Christian Kästner (2009). An Overview of Feature-Oriented Software Development.** *Journal of Object Technology 8(5).* [doi:10.5381/jot.2009.8.5.c5](https://doi.org/10.5381/jot.2009.8.5.c5) (open access PDF: [CMU](https://www.cs.cmu.edu/~ckaestne/pdf/JOT09_OverviewFOSD.pdf)) — The modern survey tying FODA/FOP/FOSD together; emphasizes decomposition into features and analysis *of compositions*. Good single citation for "a plugin set is a software product line" (Q5, Q30).

**Thomas Thüm, Sven Apel, Christian Kästner, Ina Schaefer, Gunter Saake (2014). A Classification and Survey of Analysis Strategies for Software Product Lines.** *ACM Computing Surveys 47(1):1–45.* [doi:10.1145/2580950](https://doi.org/10.1145/2580950) — Classifies analysis strategies: feature-model, family-based, module-based, recomposition-based — and states what each proves about a *whole plugin ecosystem* vs a single configuration. Decides a real compiler-scope question: do we check only the user's configuration, or offer family-based guarantees for the plugin registry (Q22, Q31)?

**Kyo C. Kang, Jaejoon Lee, Patrick Donohoe (2002). Feature-Oriented Product Line Engineering.** *IEEE Software 19(4):58–65.* [doi:10.1109/MS.2002.1020288](https://doi.org/10.1109/MS.2002.1020288) — Industrial PLE practice: engineering vs production phases, scoping, asset reuse economics. Maps to the ecosystem side of awthaq: plugin authors are the asset engineers; the compiler is the production line (Q4, Q98).

**Paul Clements, Linda Northrop (2002). Software Product Lines: Practices and Patterns.** *Addison-Wesley.* [Google Books](https://books.google.com/books?vid=ISBN9780201703320) — The SEI practice book for product lines: core asset development, scoping, and the organizational split between domain engineering and application engineering. The ecosystem-operating manual for running official plugins as reusable core assets (Q4, Q98).

### Feature interaction (telecom → general extensibility)

*Cluster question: what happens when individually-correct extensions compose badly.*

**Dirk O. Keck, Paul J. Kuehn (1998). The Feature and Service Interaction Problem in Telecommunications Systems: A Survey.** *IEEE Transactions on Software Engineering 24(10):779–796.* [doi:10.1109/32.729680](https://doi.org/10.1109/32.729680) — The canonical survey: defines feature interaction (two individually correct features composing into unexpected/undesired behavior), separates *detection* from *resolution*, and catalogs online vs offline approaches. Awthaq's route/schema/hook conflict checks are offline detection; priority orders and abort semantics are resolution policies (Q24–Q27).

**Pamela Zave, Michael Jackson (1998). Distributed Feature Composition: A Virtual Architecture for Telecommunications Services.** *IEEE Transactions on Software Engineering 24(10):831–847.* [doi:10.1109/32.729683](https://doi.org/10.1109/32.729683) — DFC: features compose over a shared virtual architecture with explicit interfaces; most interactions become *local and analyzable* because composition rules are fixed and interfaces are typed. The core lesson for the plugin compiler: make the composition graph a first-class virtual architecture (named phases, typed hook contexts) and interactions stop being emergent surprises (Q27, Q28).

**Pamela Zave. About Feature Interaction (FAQ sheet).** *pamelazave.com.* [page](https://www.pamelazave.com/fi.html) — `non-academic` but the field's standard short reference (widely cited): the problem definition plus a worked example bank (call waiting × call forwarding, etc.). Good seed material for awthaq's own interaction test matrix: each plugin pair × shared hook point is a row (Q31).

**Pamela Zave, Eric Cheung, Svetlana Yarosh (2015). Toward User-Centric Feature Composition for the Internet of Things.** *arXiv:1510.06714.* [arXiv](https://arxiv.org/abs/1510.06714) — Resolves feature interactions at *runtime* by priority, studied for comprehension by real users; surveys the design space (detection vs resolution, modularity). Directly informs the static-vs-runtime seam: conflicts are rejected at compile time, but priority-based *last-mile* resolution may belong to runtime configuration within the frozen graph (Q30).

**Svetlana Yarosh, Pamela Zave (2017). Locked or Not? Mental Models of IoT Feature Interaction.** *CHI 2017.* [doi:10.1145/3025453.3025617](https://doi.org/10.1145/3025453.3025617) — HCI-side evidence: users misunderstand interacting features (smart locks) even when composition is technically correct. For awthaq: interaction detection is not enough — docs and error surfaces must *explain* resolved interactions, e.g. why a rate-limit plugin aborted a sign-in (Q96, Q17).


### Hooks, extension points & extension interfaces

*Cluster question: the anatomy of a single extension point.*

**Ralph E. Johnson, Brian Foote (1988). Designing Reusable Classes.** *Journal of Object-Oriented Programming 1(2):22–35.* [laputan.org](https://www.laputan.org/drc.html) — The framework paper: a framework inverts control ("your code gets called"), and reusable design lives in abstract classes whose *hook methods* subclasses fill. Root concept for every hook system since; also the origin of the "white-box vs black-box framework" distinction that maps onto raw Layers vs declarative contributions (Q10, Q27).

**Frank Buschmann, Régine Meunier, Hans Rohnert, Peter Sommerlad, Michael Stal (1996). Pattern-Oriented Software Architecture, Volume 1 (Microkernel pattern).** *Wiley.* [author's POSA page](https://www.dre.vanderbilt.edu/~schmidt/POSA/) — Microkernel: a mandatory core system with functionality added by pluggable internal/external servers, core stays minimal and policy-free. The reference architecture for the `core vs plugin boundary` audit (Q51): if core knows about a specific plugin, the kernel is impure.

**Douglas C. Schmidt, Michael Stal, Hans Rohnert, Frank Buschmann (2000). Pattern-Oriented Software Architecture, Volume 2 (Extension Interface pattern).** *Wiley.* [OpenLibrary record](https://openlibrary.org/isbn/9780471606956) (author's POSA page: [Vanderbilt](https://www.dre.vanderbilt.edu/~schmidt/POSA/)) — Extension Interface: a component exposes its functionality through multiple named extension interfaces instead of one fat interface, letting clients discover and use only what they need. Model for the typed facade (`auth.password.signIn`, Q14): keys derived from installed plugins are extension interfaces over the compiled artifact.

**Gregor Kiczales, John Lamping, Anurag Mendhekar, Chris Maeda, Cristina Lopes, Jean-Marc Loingtier, John Irwin (1997). Aspect-Oriented Programming.** *ECOOP '97, LNCS 1241:220–242.* [doi:10.1007/bfb0053381](https://doi.org/10.1007/bfb0053381) — Names the problem hooks hack around: crosscutting concerns that no single module boundary captures; proposes systematic interception/weaving. Cautionary as well as useful: free-form pointcuts at runtime are the failure mode awthaq's *fixed, named* hook points exist to avoid (Q27, Q28).

**Erich Gamma, Richard Helm, Ralph Johnson, John Vlissides (1994). Design Patterns: Elements of Reusable Object-Oriented Software.** *Addison-Wesley.* [InformIT](https://www.informit.com/store/design-patterns-elements-of-reusable-object-oriented-software-9780201633610) — The concrete OOP toolkit behind extension points: Template Method (inverted control via hook operations), Observer (event subscription), Strategy (interchangeable capability implementations). Each capability slot (`PasswordHasher`, `RateLimiter`) is a Strategy under an interface — with the added compile-time registry Discipline GoF never had (Q11).

## Cross-cutting themes for awthaq

1. **Contracts are a ladder, not a boolean (→ Q20, Q23, Q31).** Beugnard et al.'s four levels give the plugin contract its structure: level 1 (syntactic shape) enforced inside `definePlugin()`, level 2 (behavioral interactions: routes, schemas, hooks) enforced by the compiler, level 3 (synchronization/ordering: middleware phases, hook order) declared and validated, level 4 (QoS: rate limits, budgets) declared as metadata. The contract-test harness (Q31) asserts conformance at every level.
2. **Conflict detection is the feature-interaction problem (→ Q24, Q25, Q26, Q27).** Keck & Kuehn's detection/resolution split is the compiler's design brief: *offline detection* for route keys (Q24), schema columns (Q25), migration ordering (Q26), hook-veto legality (Q27); *resolution policies* (priority, topo order, fail-isolation) only where detection would reject valid ecosystems. Zave & Jackson's DFC shows the enabling trick: fixed composition rules + typed interfaces make interactions enumerable instead of emergent.
3. **A plugin set is a feature-model configuration (→ Q5, Q23, Q30).** FODA/FPLE: the installed plugin list instantiates a product from a family; `provides`/`requires`/`conflicts` is a constraint system (Czarnecki & Waśowski), and exclusivity is an alternative-feature group. Multi-tenancy (Q5) = several family members sharing assets; "installation is code, configuration is data" (Q30) = the PLE engineering/production split.
4. **Compiler-scope decision has a published answer menu (→ Q22, Q31).** Thüm et al.'s strategies force an explicit choice: module-based checks per plugin (contract tests), configuration checks at `Auth.make`, and optionally family-based guarantees for the official registry. Benavides et al. supply the analysis types (validity, dead capabilities) and explanation style for diagnostics.
5. **DI discipline must be checked, not assumed (→ Q11, Q21, Q18).** Yang et al. operationalized DI's promised benefits; Laigner et al. cataloged its failure modes. Awthaq's capability slots are Strategies (GoF) wired by Layers — the contract tests should *demonstrate* substitutability (swap hashers, in-memory mailers) and each anti-pattern should map to a diagnostic or harness check.
6. **The event bus needs its point in the pub/sub taxonomy (→ Q13, Q49).** Eugster et al.'s axes (topic/content/type subscription; time/space/synchronization decoupling; delivery guarantees) turn "add a PubSub" into a design decision: typed subscriptions (Schema-validated payloads), explicit delivery classification, observers fail-isolated — with Kreps' log as the substrate for audit events.
7. **Schema/event evolution has five tested tactics (→ Q25, Q100).** Overeem et al.'s tactics (versioned events, weak schema, upcasting, in-place transformation, copy-and-transform) are the policy menu for `apiVersion` bumps; event schemas are the most brittle asset because they outlive the process — version them from v1.
8. **Introspection requires reification, not reflection (→ Q9, Q10, Q14, Q95).** Smith/Maes/MOP: to reason about plugins, raise their contributions to causally-connected meta-objects — frozen declarative records the compiler and CLI query (`auth plugin list`, `doctor`) without executing plugin code. Extension Interfaces (POSA2) shape the typed facade derived from the compiled artifact.
9. **Hooks are before/after metaclasses with a type (→ Q27, Q28).** Johnson & Foote define the hook; Forman & Danforth show before/after composition; AOP warns against untyped crosscutting; DFC/Tapable (see 09) supply ordering and failure semantics. The synthesis: fixed, named hook points with typed contexts; veto only in `before*`; observers compile-wrapped for fail-isolation.
10. **Reuse across changed environments is the Ariane lesson (→ Q4, Q30).** Jézéquel & Meyer: contract violations in reused code kill at runtime. Plugins are reused components in arbitrary app environments — the compiler must fail closed at boot (`CapabilityNotInstalled`), never lazily at first request.
11. **White-box vs black-box extension (→ Q10, Q31).** Johnson & Foote's framework dichotomy and Heineman & Councill's "conformance to a component model" converge on the same rule: third-party extension should be declarative (black-box) and machine-checkable, not subclass-your-internals. Declarative contributions wrapped by the compiler are the black-box pole; raw Layers are the white-box pole — pick deliberately per contribution kind.

Taken together, the literature implies a **compiler-check ledger** — every check has a named source and contract level:

| Compiler check | Literature basis | Beugnard level / analysis strategy | Q |
|---|---|---|---|
| Plugin shape, namespaces, `apiVersion` | Beugnard et al. 1999 (L1); Szyperski's component model | syntactic / module-based | Q9, Q20, Q23 |
| `requires`/`conflicts` satisfiability, cycles | FODA + Czarnecki & Waśowski constraint semantics | feature-model / configuration-based | Q21–Q23 |
| Route, schema, capability conflicts | Keck & Kuehn offline detection; DFC typed interfaces | behavioral / configuration-based | Q23–Q25 |
| Hook & middleware ordering, migration order | Forman et al. before/after composition; DFC rules | synchronization / configuration-based | Q26–Q28 |
| QoS declarations (rate limits, budgets) | Beugnard et al. 1999 (L4) | quality-of-service / declared metadata | Q37, Q91 |
| Registry-wide family guarantees (official plugins) | Thüm et al. family-based strategy; Clements & Northrop | family-based, opt-in | Q31, Q98 |
| Interaction *explanations* in diagnostics/docs | Benavides et al. explanation outputs; Yarosh & Zave | UX of analysis | Q17, Q96 |

## People & research groups

- **Clemens Szyperski** (Microsoft Research → QUT) — component software, binding times.
- **Bertrand Meyer** (ETH Zürich / Eiffel) — design by contract. [ETH page](https://se.inf.ethz.ch/people/meyer/)
- **Jean-Marc Jézéquel** (Univ. Rennes / IRISA) — contracts, components, MDE.
- **Christian Kästner** (CMU) — variability, feature-oriented analysis, ecosystem security. [site](https://www.cs.cmu.edu/~ckaestne/)
- **Sven Apel** (Univ. Magdeburg) — FOSD, product-line analysis. [site](https://www.sven-apel.de/)
- **Krzysztof Czarnecki** (Univ. of Waterloo) — feature models, generative programming. [UWaterloo page](https://uwaterloo.ca/scholar/kczarnec)
- **Don Batory** (UT Austin) — AHEAD, step-wise refinement. [UTCS page](https://www.cs.utexas.edu/~batory/)
- **Pamela Zave** (AT&T Labs – Research) — feature interaction, DFC, network architecture. [site](https://www.pamelazave.com/)
- **Rachid Guerraoui** (EPFL) — distributed objects, pub/sub.
- **Patrick Eugster** (Purdue / Boston College) — publish/subscribe, event systems.
- **Gregor Kiczales** (UBC) — metaobject protocols, aspect-oriented programming. [UBC page](https://www.cs.ubc.ca/~gregor/)
- **Brian Cantwell Smith** (Toronto, emeritus) — reflection, procedural reflection. [writings](http://www.ageofsignificance.org/documents/Reflection%20and%20Semantics%20in%20Lisp.pdf)
- **Pattie Maes** (MIT Media Lab) — computational reflection. [Media Lab page](https://www.media.mit.edu/people/pattie/)
- **Michiel Overeem, Slinger Jansen** (Utrecht Univ.) — event-sourcing in industry.
- **David Benavides** (Univ. Seville) — feature-model analysis; **Thomas Thüm** (Ulm/Magdeburg) — SPL analysis strategies.
- **Ralph E. Johnson** (UIUC) — frameworks, design patterns. [UIUC page](https://cs.illinois.edu/about/people/faculty/johnson)

## Suggested reading order

1. **Heineman & Councill (2001)** — the component model vocabulary; what "conforms to a component model" means for `definePlugin()`.
2. **Meyer (1992)** — design by contract; obligations/benefits framing for plugin `provides`/`requires`.
3. **Beugnard et al. (1999)** — the four contract levels; the compiler's check ladder (Q20/Q31).
4. **Szyperski (1998/2002)** — components, third-party composition, binding times (skim ch. 1–4 + 10).
5. **Eugster et al. (2003)** — pick the event bus's coordinates in the pub/sub taxonomy (Q13).
6. **Overeem et al. (2021)** — schema evolution tactics before you design plugin schema merging (Q25/Q100).
7. **Kang et al. (1990) FODA + Czarnecki & Waśowski (2007)** — feature models and their logic; capability graphs as constraint systems (Q23/Q30).
8. **Batory et al. (2004)** — features as algebraic increments; composition as a validated expression (Q22/Q27).
9. **Keck & Kuehn (1998) + Zave & Jackson (1998)** — the interaction problem, detection vs resolution, DFC's typed composition (Q24–Q27).
10. **Thüm et al. (2014)** — which analysis strategy the compiler promises: per-plugin, per-configuration, or family-based (Q31).

## Open questions

1. **How many Beugnard levels does v1 enforce?** Levels 1–2 are clearly compiler work; level 3 (ordering/phase constraints) is declared metadata — do we *validate* it at compile time or only at contract-test time? (Q20/Q28/Q31)
2. **Configuration checks only, or family-based promises?** Thüm et al. offer strategies with very different costs; does the awthaq compiler guarantee anything about *arbitrary* third-party plugin pairs, or strictly about the installed configuration? (Q22/Q31)
3. **Priority-based runtime resolution vs compile-time rejection?** Zave et al.'s IoT work shows runtime priority resolution is comprehensible for users; awthaq rejects conflicts at compile — is there a sanctioned, bounded "priority" resolution within the frozen graph, or is priority compile-only? (Q30/Q27)
4. **Type-based subscription with content constraints?** Eugster's taxonomy suggests typed pub/sub plus optional content filtering; does the event bus need content-based selectors at v1, or is type+payload-schema enough? (Q13)
5. **Which evolution tactic is canonical for cross-`apiVersion` schemas?** Upcasting (lazy, read-time) vs copy-and-transform (migration-time) both appear in Overeem's field data; awthaq has a compiler at hand, so generate-time transform looks natural — but replay/audit events may need read-time upcasting. One policy or two? (Q25/Q26/Q49/Q100)
6. **Who owns interaction explanations?** Yarosh & Zave show users misread interacting features; Benavides et al. show analyzers can emit explanations. Do compiled diagnostics carry "plugin X conflicts with plugin Y because …" strings, or does the docs site own them keyed by diagnostic code? (Q17/Q22/Q96)

## Sources

- https://www.informit.com/store/component-software-beyond-object-oriented-programming-9780201745726
- https://books.google.com/books?vid=ISBN0201704854
- https://doi.org/10.1109/2.161279
- https://doi.org/10.1145/97946.97967
- https://doi.org/10.1109/2.774917
- https://inria.hal.science/hal-01794333
- https://arxiv.org/abs/1010.2822
- https://doi.org/10.1109/2.562936
- https://martinfowler.com/articles/injection.html
- https://doi.org/10.1109/ASWEC.2008.4483212
- https://doi.org/10.1145/3350768.3350771
- https://doi.org/10.1145/857076.857078
- https://www.linkedin.com/blog/engineering/distributed-systems/log-what-every-software-engineer-should-know-about-real-time-datas-unifying
- https://martinfowler.com/eaaDev/EventSourcing.html
- https://doi.org/10.1016/j.jss.2021.110970
- https://arxiv.org/abs/2104.01146
- https://doi.org/10.1145/3359591.3359737
- https://www.dataintensive.net/
- https://dspace.mit.edu/entities/publication/471a211a-d317-46da-89e4-6a0d9d10488b
- https://doi.org/10.1145/800017.800513
- http://www.ageofsignificance.org/documents/Reflection%20and%20Semantics%20in%20Lisp.pdf
- https://doi.org/10.1145/38807.38821
- https://books.google.com/books?vid=ISBN9780262610742
- https://books.google.com/books?vid=ISBN0201433052
- https://doi.org/10.1145/191081.191148
- https://www.researchgate.net/publication/215588323_Feature-Oriented_Domain_Analysis_FODA_feasibility_study
- https://books.google.com/books/about/Generative_Programming.html?id=4CPmr3qcVvYC
- https://doi.org/10.1007/bfb0053389
- https://doi.org/10.1109/TSE.2004.23
- https://www.cs.utexas.edu/~schwartz/ATS/fopdocs/AHEAD-Theory.pdf
- https://doi.org/10.1109/SPLINE.2007.24
- https://doi.org/10.1016/j.is.2010.01.001
- https://doi.org/10.1145/2580950
- https://doi.org/10.5381/jot.2009.8.5.c5
- https://www.cs.cmu.edu/~ckaestne/pdf/JOT09_OverviewFOSD.pdf
- https://doi.org/10.1109/MS.2002.1020288
- https://doi.org/10.1109/32.729680
- https://doi.org/10.1109/32.729683
- https://www.pamelazave.com/fi.html
- https://arxiv.org/abs/1510.06714
- https://www.laputan.org/drc.html
- https://www.dre.vanderbilt.edu/~schmidt/POSA/
- https://openlibrary.org/isbn/9780471606956
- https://doi.org/10.1007/bfb0053381
- https://www.informit.com/store/design-patterns-elements-of-reusable-object-oriented-software-9780201633610
- https://doi.org/10.1145/38807.38822
- https://books.google.com/books?vid=ISBN9780201703320
- https://books.google.com/books?vid=ISBN9780136291558
- https://doi.org/10.1007/3-540-39953-4_3
- https://doi.org/10.1145/3025453.3025617
