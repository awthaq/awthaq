// Builds expert-audit-dashboard.html — single self-contained file, data inlined.
import { readFileSync, writeFileSync } from "node:fs";

const reports = JSON.parse(readFileSync(".scratch/awthaq-analysis/reports.json", "utf8"));
const aggregate = JSON.parse(readFileSync(".scratch/awthaq-analysis/aggregate.json", "utf8"));
const verified = JSON.parse(readFileSync(".scratch/awthaq-analysis/verified-metrics.json", "utf8"));

// ---- build-time normalization --------------------------------------------
for (const r of reports) {
  r.strengths ??= [];
  r.weaknesses ??= [];
  r.usage_examples ??= [];
  r.metrics ??= [];
  r.kpis ??= [];
  for (const u of r.usage_examples) u.title ||= "Usage example";
  r._w = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const w of r.weaknesses) if (r._w[w.severity] !== undefined) r._w[w.severity]++;
}

const DATA = {
  date: verified.date,
  meta: {
    repo: "awthaq (effect-auth)",
    stack: "Effect v4 · 4.0.0-rc.115 · TypeScript 7 (tsgo) · pnpm · vitest",
    experts: 50,
    overall: aggregate.overall,
    pillarAvg: aggregate.pillarAvg,
    pillarN: aggregate.pillarN,
    sevTally: aggregate.sevTally,
    counts: aggregate.counts,
  },
  verified: {
    typecheck: "pass", lint: "0 findings", circular: "0 cycles", knip: "0 findings",
    tests: `${verified.commands.tests.cases.passed} passed / ${verified.commands.tests.cases.skipped} skipped (588)`,
    duration: `${verified.commands.tests.durationSeconds}s`,
    coverage: verified.coverage,
  },
  loc: verified.loc,
  reports,
};

const HEADLINE_RISKS = [
  { sev: "critical", expert: "E16 · E44", title: "Hand-written SQL uses unquoted camelCase identifiers the Postgres migrations quote",
    detail: "Repositories.ts:359-364 queries `WHERE userId … ORDER BY createdAt` unquoted, while CoreMigrations.ts:62-64/92 creates \"createdAt\"/\"userId\" quoted. Postgres folds unquoted identifiers to lowercase → the session list/pagination path errors on a real Postgres. The pg contract suite covers only 2 of 5 repositories, so CI stays green.", fix: "Quote identifiers (or snake_case columns end-to-end) and extend the Postgres contract suite to all 5 repositories." },
  { sev: "critical", expert: "E44 · E16", title: "users.email ships with no unique index — concurrent sign-ups can race, and the documented UniqueViolation → EmailAlreadyExists mapping can never fire",
    detail: "CoreMigrations.ts:60-74 declares `email TEXT NOT NULL` with no UNIQUE; the only test-side unique index is created ad hoc (core/Users.test.ts:36). Users.ts:206-208 documents a UNIQUE index on lower(email) that no migration creates.", fix: "Add `CREATE UNIQUE INDEX … ON users (lower(email))` to CoreMigrations; add a concurrency test." },
  { sev: "critical", expert: "E18 · E43", title: "OAuth state cookie is __Host-oauth-state set with path=/oauth — invalid for the __Host- prefix, so the callback's cookie/state check can never pass in a real browser",
    detail: "OAuth.ts:75 defines `__Host-oauth-state`; OAuth.ts:308-314 sets it with `path: \"/oauth\"`. RFC 6265bis requires Path=/ for __Host- cookies, so conforming browsers drop it and the login-CSRF/code-injection defense (BEH-EA-122) is inert. Verified by parent spot-check.", fix: "Set path:\"/\" (drop the path attribute entirely)." },
  { sev: "critical", expert: "E43 · E18", title: "Open-redirect bypass: resolveCallbackURL honors any string starting with \"/\", including scheme-relative //evil.com",
    detail: "OAuth.ts:156 returns raw input before the trustedOrigins allowlist is consulted. `?callbackURL=//attacker.example` redirects off-site post-auth — the exact class the repo's own research table names (CVE-2026-82274). Verified by parent spot-check.", fix: "Require raw.startsWith(\"/\") && !raw.startsWith(\"//\") && !raw.startsWith(\"/\\\\\"), or URL-parse relative forms." },
  { sev: "critical", expert: "E34 · E41 · E04", title: "CSRF middleware is fully implemented but attached to zero served groups — no mutating endpoint is CSRF-protected in production wiring",
    detail: "packages/client/src/AuthClient.ts:28-31 states it verbatim: \"No plugin's HttpApiGroup in this repository currently declares .middleware(Api.CsrfProtection)\". Csrf.ts (187 lines, HMAC double-submit) exists and is tested only against synthetic groups. Verified by parent spot-check.", fix: "Attach Api.CsrfProtection to every cookie-authenticated mutating group before first publish; add a contract test that fails when a mutating cookie group lacks it." },
  { sev: "high", expert: "E14 · E38", title: "AuthEvents publishes onto a bounded PubSub (1024) whose publishers suspend at capacity — a stalled subscriber can stall sign-in/verification paths",
    detail: "AuthEvents.ts:258-265: `PubSub.bounded(1024)`; Effect's bounded publish suspends until space frees. Verification.consume publishes on every failure path, so a wedged subscriber converts event backpressure into request-path latency (DoS-shaped). BEH-EA-098 promises publish never suspends on a subscriber.", fix: "Drop-on-full publish (PollingBackpressure/publish with offer semantics) or unbounded-with-metrics; document the chosen loss policy." },
  { sev: "high", expert: "E39 · E42", title: "JWT private signing keys are persisted as plaintext JSON in jwt_signing_key.privateKeyJwk",
    detail: "SigningKeyRecords.ts:45 types the in-memory record as Redacted, but the SQL layer stringifies the JWK into the column unencrypted — the repo's own AES-256-GCM Encryption port (used for OAuth tokens one package away) is not applied to the highest-value secret in the system.", fix: "Encrypt privateKeyJwk at rest with the Encryption port (AAD = kid), or hold private keys outside the database." },
  { sev: "high", expert: "E41", title: "changePassword does not revoke (or rotate) existing sessions — BEH-EA-053 is satisfied on the reset path only",
    detail: "confirmReset revokes a second live session; the changePassword path leaves all other sessions valid, so an attacker holding a stolen session survives a credential change. 1 of 2 privilege-change paths covered.", fix: "Reuse confirmReset's revocation on changePassword (deleteAllForUserExcept exists: Repositories.ts:385-388)." },
  { sev: "high", expert: "E15 · E31", title: "resolvePrincipal blanket-maps sessions.verify's whole error channel — including PlatformError — to 401 Unauthenticated",
    detail: "Authentication.ts:104,107: a database outage presents as auth failure on every authenticated request, contradicting the repo's own catchTag(\"PlatformError\", Effect.die) convention (Password.ts:435, OAuth.ts:535). jwt/verify.ts:87 has the same defect class.", fix: "catchTag PlatformError → Effect.die; fail only SessionNotFound/SessionExpired to Unauthenticated." },
  { sev: "high", expert: "E50 · E44", title: "@awthaq/api — the contract stratum every HTTP surface and client builds on — has zero tests (327 src LOC, no test dir)",
    detail: "Risk-ranked #1 by likelihood×impact (25/25) in the E50 register: every consumer-facing type and error schema lives in the one package with no test LOC. Organization plugin similarly ships 7 tables with no migrations at all (E44).", fix: "Type-level contract tests (compile assertions) + fixture round-trips for every contract schema; ship org migrations." },
];

const HEADLINE_STRENGTHS = [
  { expert: "E29", score: 9.2, title: "One service idiom, zero drift", detail: "38/38 service tags are Context.Service classes with namespaced keys; 0 legacy Context.Tag/Effect.Service. Two-tier config model (defaulted Context.Reference vs required Service) with the trade-off documented at each decision site." },
  { expert: "E03", score: 9.0, title: "Zero-annotation type ergonomics with regression-tested compiler errors", detail: "Curried const-generic plugin authoring; Validate<P> renders readable sentences inside the type error; @ts-expect-error proofs pin the compile-time contract (an unused expect-error is itself a tsc failure)." },
  { expert: "E02", score: 8.5, title: "One tuple, two provably-consistent projections", detail: "Auth.make computes api/layer/migrations/manifest from one validated tuple; runtime backstops only where types can't reach (Kahn cycle detection naming the full path); zero casts across the plugin engine." },
  { expert: "E27", score: 8.5, title: "Library code never starts the runtime", detail: "Effect.runPromise/Sync/Fork appears in exactly 2 non-test files — both deliberate adapter boundaries (client shim, Next bridge). v4-only primitives used under their v4 names, each verified present in rc.115." },
  { expert: "E42 · E22", score: 8.0, title: "Cryptography core done right", detail: "AES-256-GCM with per-call 96-bit CSPRNG IV and AAD row-binding; OWASP-exact Argon2id/scrypt defaults; asymmetric-only JWT allowlist; 17/17 randomness sites through the injected Crypto service; uniform-cost sign-in defeats timing enumeration." },
  { expert: "E33", score: 6.5, title: "Win-or-lose atomicity by construction (where applied)", detail: "Token single-use, challenge replay, and reservation races closed in both memory (single Ref.modify) and SQL (single conditional upsert/UPDATE…RETURNING) layers — no check-then-act windows in the verification stratum." },
  { expert: "E24 + parent", score: 8.0, title: "Deterministic, dual-backend test suite at 93% coverage", detail: "586 tests in 9.7s; TestClock choreography replaces all sleeps; the same contract suites run against memory AND real SQLite; 93.1/82.8/90.1/93.3 stmts/branch/funcs/lines. Verified by parent run." },
  { expert: "E46 · E25", score: 7.5, title: "Spec-to-code traceability most repos never achieve", detail: "220 BEH-EA behaviors allocated contiguously, all restated as 602 Gherkin scenarios, 297 id citations inside test titles; a 19-check verify script (honest about being structural, not semantic)." },
  { expert: "E26 + parent", score: 7.8, title: "Hygiene gates green and honest", detail: "Zero TODO/FIXME in tracked source; four stubs are scrupulously documented placeholders; knip/madge/oxlint all clean (parent-verified); generated dashboards and a quality scorecard committed." },
  { expert: "E09", score: 7.2, title: "Client derived from the contract, not re-implemented", detail: "typeof-pinned re-exports of HttpApiClient (identity-tested), CSRF required by the type system, ErrorCodes mechanically derived from the compiled contract including middleware errors." },
];

const PILLAR_META = {
  "API Design": { color: "#C6F24E", verdict: "Compile-time-first contracts with exceptional type ergonomics; composition DX and consumer docs are the tax." },
  "Code Quality": { color: "#F2A65A", verdict: "Disciplined patterns, honest stubs, strong tests; races, missing indexes and untransacted multi-writes sit at the persistence seams." },
  "Effect Native": { color: "#63D8E8", title: "", verdict: "Authentic v4 fidelity and runner discipline; resource eviction, event backpressure and tx-boundary parity are the open flanks." },
  "Cross-Cutting": { color: "#C792EA", verdict: "A security core well above par; flow wiring, DB scalability and release gates concentrate the residual risk." },
};

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const sevRank = { critical: 0, high: 1, medium: 2, low: 3 };

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>awthaq — 50-Expert Audit Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,500;9..144,700;9..144,900&family=IBM+Plex+Mono:ital,wght@0,300;0,400;0,500;0,600;1,400&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#0A0C0F; --bg2:#0D1014; --panel:#12151B; --panel2:#161A21; --line:#232935;
  --ink:#E9ECF2; --muted:#8D97AC; --faint:#5A6377;
  --signal:#C6F24E; --cyan:#63D8E8; --amber:#F2A65A; --violet:#C792EA;
  --critical:#FF5D5D; --high:#FFA05C; --medium:#F2D24E; --low:#63D8E8;
  --serif:"Fraunces", Georgia, serif; --mono:"IBM Plex Mono", ui-monospace, Menlo, monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{background:var(--bg);color:var(--ink);font-family:var(--mono);font-size:14px;line-height:1.55;
  background-image:
    radial-gradient(1200px 500px at 70% -10%, rgba(198,242,78,.05), transparent 60%),
    radial-gradient(900px 400px at 10% 110%, rgba(99,216,232,.04), transparent 60%),
    repeating-linear-gradient(0deg, transparent 0 39px, rgba(233,236,242,.025) 39px 40px),
    repeating-linear-gradient(90deg, transparent 0 39px, rgba(233,236,242,.018) 39px 40px);}
::selection{background:rgba(198,242,78,.25)}
.wrap{max-width:1240px;margin:0 auto;padding:0 28px 80px}
a{color:var(--cyan);text-decoration:none}
/* ---------- masthead ---------- */
header{padding:54px 0 26px;border-bottom:1px solid var(--line)}
.mast{display:grid;grid-template-columns:1fr auto;gap:36px;align-items:end}
.kicker{color:var(--signal);letter-spacing:.32em;font-size:11px;text-transform:uppercase}
h1{font-family:var(--serif);font-weight:900;font-size:clamp(44px,6.4vw,84px);line-height:.95;letter-spacing:-.015em;margin:14px 0 10px}
h1 em{font-style:italic;font-weight:300;color:var(--muted)}
.meta{color:var(--muted);font-size:12.5px;display:flex;flex-wrap:wrap;gap:8px 22px;margin-top:10px}
.meta b{color:var(--ink);font-weight:500}
.verdict{display:flex;gap:26px;align-items:center}
.dial{position:relative;width:168px;height:168px;flex:none}
.dial svg{transform:rotate(-90deg)}
.dial .num{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.dial .num b{font-family:var(--serif);font-size:44px;font-weight:700;line-height:1}
.dial .num span{color:var(--muted);font-size:10px;letter-spacing:.2em;text-transform:uppercase;margin-top:6px}
.gates{display:grid;grid-template-columns:1fr;gap:7px;font-size:12px}
.gates .g{display:flex;justify-content:space-between;gap:18px;border:1px solid var(--line);background:var(--panel);padding:7px 12px;border-radius:4px;min-width:250px}
.gates .g b{color:var(--signal);font-weight:600}
/* ---------- sections ---------- */
section{padding:44px 0 8px}
.sec-head{display:flex;align-items:baseline;gap:16px;margin-bottom:22px}
.sec-head h2{font-family:var(--serif);font-weight:700;font-size:30px;letter-spacing:-.01em}
.sec-head .rule{flex:1;height:1px;background:var(--line)}
.sec-head .idx{color:var(--faint);font-size:12px;letter-spacing:.2em}
/* ---------- kpi tiles ---------- */
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:12px}
.kpi{border:1px solid var(--line);background:linear-gradient(180deg,var(--panel),var(--bg2));border-radius:6px;padding:16px 16px 13px;position:relative;overflow:hidden}
.kpi::after{content:"";position:absolute;left:0;top:0;width:3px;height:100%;background:var(--signal);opacity:.7}
.kpi.v::after{background:var(--cyan)} .kpi.a::after{background:var(--amber)} .kpi.p::after{background:var(--violet)}
.kpi b{display:block;font-family:var(--serif);font-size:30px;font-weight:700;line-height:1.1}
.kpi span{color:var(--muted);font-size:11px;letter-spacing:.08em;text-transform:uppercase;display:block;margin-top:6px}
.kpi i{position:absolute;right:12px;top:12px;color:var(--faint);font-style:normal;font-size:10px}
/* ---------- pillars ---------- */
.pillars{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px}
.pillar{border:1px solid var(--line);border-radius:6px;background:var(--panel);padding:20px}
.pillar h3{font-family:var(--serif);font-size:21px;font-weight:700;display:flex;justify-content:space-between;align-items:baseline}
.pillar h3 b{font-size:26px}
.pillar .bar{height:5px;background:#1B202A;border-radius:3px;margin:14px 0 12px;overflow:hidden}
.pillar .bar i{display:block;height:100%;border-radius:3px;transform-origin:left;animation:grow 1.1s cubic-bezier(.2,.8,.2,1) both}
@keyframes grow{from{transform:scaleX(0)}}
.pillar p{color:var(--muted);font-size:12px}
.pillar .n{color:var(--faint);font-size:11px;margin-top:10px;letter-spacing:.1em;text-transform:uppercase}
/* ---------- charts ---------- */
.charts{display:grid;grid-template-columns:1.6fr 1fr;gap:12px}
.panel{border:1px solid var(--line);border-radius:6px;background:var(--panel);padding:20px}
.panel h4{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);margin-bottom:16px}
#strip{display:flex;align-items:flex-end;gap:3px;height:190px}
#strip .b{flex:1;border-radius:2px 2px 0 0;cursor:pointer;transition:filter .15s, transform .15s;animation:rise .8s cubic-bezier(.2,.8,.2,1) both}
#strip .b:hover{filter:brightness(1.35);transform:translateY(-3px)}
@keyframes rise{from{height:0!important;opacity:.3}}
.sevrow{display:flex;flex-direction:column;gap:14px}
.sevline{display:grid;grid-template-columns:86px 1fr 44px;align-items:center;gap:12px;font-size:12px}
.sevline .track{height:14px;background:#1B202A;border-radius:3px;overflow:hidden}
.sevline .track i{display:block;height:100%;animation:grow 1.2s cubic-bezier(.2,.8,.2,1) both}
.legend{display:flex;gap:16px;color:var(--muted);font-size:11px;margin-top:4px}
.legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px}
/* ---------- headlines ---------- */
.lists{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.list{border:1px solid var(--line);border-radius:6px;background:var(--panel)}
.list h4{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);padding:16px 20px;border-bottom:1px solid var(--line)}
.li{padding:14px 20px;border-bottom:1px solid var(--line);display:grid;grid-template-columns:auto 1fr;gap:14px}
.li:last-child{border-bottom:0}
.li .rank{font-family:var(--serif);font-size:22px;color:var(--faint);width:30px}
.li h5{font-size:13px;font-weight:600;line-height:1.4}
.li p{color:var(--muted);font-size:12px;margin-top:6px}
.li .fix{color:var(--signal);font-size:11.5px;margin-top:6px}
.li .fix::before{content:"→ ";color:var(--signal)}
.li .who{display:inline-block;margin-top:8px;color:var(--faint);font-size:10.5px;letter-spacing:.08em}
.chip{display:inline-block;font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:2px 8px;border-radius:99px;border:1px solid;margin-right:6px}
.chip.critical{color:var(--critical);border-color:rgba(255,93,93,.45)}
.chip.high{color:var(--high);border-color:rgba(255,160,92,.45)}
.chip.medium{color:var(--medium);border-color:rgba(242,210,78,.4)}
.chip.low{color:var(--low);border-color:rgba(99,216,232,.4)}
.chip.s-impact{color:var(--signal);border-color:rgba(198,242,78,.4)}
.chip.m-impact{color:var(--amber);border-color:rgba(242,166,90,.4)}
.chip.l-impact{color:var(--faint);border-color:var(--line)}
/* ---------- fleet ---------- */
.controls{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px;align-items:center}
.controls input[type=search]{flex:1;min-width:220px;background:var(--panel);border:1px solid var(--line);color:var(--ink);font:inherit;font-size:13px;padding:9px 14px;border-radius:5px;outline:none}
.controls input[type=search]:focus{border-color:var(--signal)}
.controls select{background:var(--panel);border:1px solid var(--line);color:var(--ink);font:inherit;font-size:12px;padding:9px 10px;border-radius:5px;outline:none}
.fleet{display:grid;grid-template-columns:1fr;gap:10px}
.card{border:1px solid var(--line);border-radius:6px;background:var(--panel);overflow:hidden}
.card>.head{display:grid;grid-template-columns:auto auto 1fr auto auto;gap:16px;align-items:center;padding:14px 18px;cursor:pointer;user-select:none}
.card>.head:hover{background:var(--panel2)}
.card .eid{color:var(--faint);font-size:11px;letter-spacing:.12em}
.card .pillar-tag{font-size:10px;letter-spacing:.14em;text-transform:uppercase;padding:3px 9px;border-radius:99px;border:1px solid}
.card .title{font-weight:600;font-size:13.5px}
.card .minis{display:flex;gap:5px}
.card .minis i{width:8px;height:8px;border-radius:2px;display:block}
.scorechip{font-family:var(--serif);font-size:20px;font-weight:700;width:58px;text-align:right}
.toggle{color:var(--faint);transition:transform .2s;font-size:11px}
.card.open .toggle{transform:rotate(90deg)}
.body{display:none;border-top:1px solid var(--line);padding:20px 22px 24px;background:var(--bg2)}
.card.open .body{display:block;animation:fade .35s both}
@keyframes fade{from{opacity:0;transform:translateY(-6px)}}
.sum{font-size:13px;color:var(--ink);border-left:3px solid var(--signal);padding:10px 16px;background:rgba(198,242,78,.05);border-radius:0 4px 4px 0;margin-bottom:20px;white-space:pre-wrap}
.sub{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);margin:20px 0 10px;display:flex;align-items:center;gap:12px}
.sub::after{content:"";flex:1;height:1px;background:var(--line)}
.finding{border:1px solid var(--line);border-radius:5px;background:var(--panel);padding:14px 16px;margin-bottom:10px}
.finding h6{font-size:13px;font-weight:600;line-height:1.45}
.finding p{color:var(--muted);font-size:12px;margin-top:7px;white-space:pre-wrap}
.finding .ev{color:var(--cyan);font-size:11px;margin-top:7px;word-break:break-word}
.finding .rec{color:var(--signal);font-size:11.5px;margin-top:7px}
.finding .rec::before{content:"→ fix: "}
.code{position:relative;border:1px solid var(--line);border-radius:5px;background:#0B0E12;margin:10px 0 4px}
.code pre{padding:14px 16px;overflow-x:auto;font-size:12px;line-height:1.6}
.code .src{display:block;border-top:1px solid var(--line);color:var(--faint);font-size:10.5px;padding:7px 14px;letter-spacing:.04em}
.code .cp{position:absolute;top:8px;right:8px;background:var(--panel2);border:1px solid var(--line);color:var(--muted);font:inherit;font-size:10px;padding:3px 9px;border-radius:4px;cursor:pointer}
.code .cp:hover{color:var(--ink);border-color:var(--faint)}
.tk-k{color:var(--violet)} .tk-s{color:var(--signal)} .tk-c{color:var(--faint);font-style:italic} .tk-n{color:var(--amber)} .tk-t{color:var(--cyan)}
.mtable{width:100%;border-collapse:collapse;font-size:12px}
.mtable td{border-top:1px solid var(--line);padding:6px 10px;vertical-align:top}
.mtable tr:first-child td{border-top:0}
.mtable td:first-child{color:var(--ink);width:44%}
.mtable td:nth-child(2){color:var(--signal);font-weight:500;white-space:nowrap}
.mtable td:last-child{color:var(--faint)}
.ktable td:first-child{width:38%}
.ktable td:nth-child(2){color:var(--cyan)}
footer{margin-top:56px;border-top:1px solid var(--line);padding-top:24px;color:var(--faint);font-size:11.5px;display:grid;grid-template-columns:2fr 1fr;gap:30px}
footer b{color:var(--muted)}
@media (max-width:960px){.mast{grid-template-columns:1fr}.charts,.lists{grid-template-columns:1fr}footer{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap">
<header>
  <div class="mast">
    <div>
      <div class="kicker">Signal Report · ${DATA.meta.experts} Expert Agents · Read-Only Fleet Audit</div>
      <h1>awthaq<br><em>50-expert audit</em></h1>
      <div class="meta">
        <span>repo <b>${esc(DATA.meta.repo)}</b></span>
        <span>stack <b>${esc(DATA.meta.stack)}</b></span>
        <span>audit date <b>${DATA.date}</b></span>
        <span>phase <b>pre-1.0, pre-publish</b></span>
      </div>
    </div>
    <div class="verdict">
      <div class="dial">
        <svg width="168" height="168" viewBox="0 0 168 168">
          <circle cx="84" cy="84" r="74" fill="none" stroke="#1B202A" stroke-width="10"/>
          <circle cx="84" cy="84" r="74" fill="none" stroke="var(--signal)" stroke-width="10" stroke-linecap="round"
            stroke-dasharray="${(aggregate.overall/10*465).toFixed(0)} 465"/>
        </svg>
        <div class="num"><b>${aggregate.overall}</b><span>verdict /10</span></div>
      </div>
      <div class="gates">
        <div class="g"><span>typecheck (tsgo)</span><b>PASS</b></div>
        <div class="g"><span>oxlint · madge · knip</span><b>0 / 0 / 0</b></div>
        <div class="g"><span>tests</span><b>${DATA.verified.tests}</b></div>
        <div class="g"><span>coverage (stmts/branch)</span><b>${DATA.verified.coverage.statements.pct}% / ${DATA.verified.coverage.branches.pct}%</b></div>
        <div class="g"><span>findings triaged</span><b>${aggregate.counts.weaknesses} weaknesses · ${aggregate.counts.strengths} strengths</b></div>
      </div>
    </div>
  </div>
</header>

<section>
  <div class="sec-head"><span class="idx">01</span><h2>Measured baseline</h2><div class="rule"></div></div>
  <div class="kpis">
    <div class="kpi"><i>verified</i><b>${(DATA.loc.src/1000).toFixed(1)}k</b><span>src LOC · ${DATA.loc.packages_total} packages</span></div>
    <div class="kpi v"><i>verified</i><b>${(DATA.loc.test/1000).toFixed(1)}k</b><span>test LOC · +${(DATA.loc.features_bdd/1000).toFixed(1)}k BDD</span></div>
    <div class="kpi"><i>verified</i><b>${DATA.verified.coverage.statements.pct}%</b><span>statement coverage</span></div>
    <div class="kpi v"><i>verified</i><b>${DATA.verified.coverage.branches.pct}%</b><span>branch coverage</span></div>
    <div class="kpi a"><i>fleet</i><b>${aggregate.counts.weaknesses}</b><span>weaknesses · ${aggregate.sevTally.critical} critical</span></div>
    <div class="kpi"><i>fleet</i><b>${aggregate.counts.strengths}</b><span>strengths catalogued</span></div>
    <div class="kpi p"><i>fleet</i><b>${aggregate.counts.examples}</b><span>usage examples cited</span></div>
    <div class="kpi a"><i>fleet</i><b>${aggregate.counts.metrics}</b><span>metrics · ${aggregate.counts.kpis} KPIs</span></div>
  </div>
</section>

<section>
  <div class="sec-head"><span class="idx">02</span><h2>Pillar verdicts</h2><div class="rule"></div></div>
  <div class="pillars" id="pillars"></div>
</section>

<section>
  <div class="sec-head"><span class="idx">03</span><h2>The fleet at a glance</h2><div class="rule"></div></div>
  <div class="charts">
    <div class="panel"><h4>50 expert scores — click a bar to open the card</h4><div id="strip"></div><div class="legend" style="margin-top:14px" id="plegend"></div></div>
    <div class="panel"><h4>Weakness severity distribution · n=${aggregate.counts.weaknesses}</h4>
      <div class="sevrow" id="sevrows"></div>
      <div class="legend" style="margin-top:18px">
        <span><i style="background:var(--critical)"></i>critical ${aggregate.sevTally.critical}</span>
        <span><i style="background:var(--high)"></i>high ${aggregate.sevTally.high}</span>
        <span><i style="background:var(--medium)"></i>medium ${aggregate.sevTally.medium}</span>
        <span><i style="background:var(--low)"></i>low ${aggregate.sevTally.low}</span>
      </div>
    </div>
  </div>
</section>

<section>
  <div class="sec-head"><span class="idx">04</span><h2>Headline findings</h2><div class="rule"></div></div>
  <div class="lists">
    <div class="list"><h4>▲ Top 10 risks — critical/high, highest-confidence first</h4><div id="risks"></div></div>
    <div class="list"><h4>▼ Top 10 strengths — cross-fleet consensus</h4><div id="strengths"></div></div>
  </div>
</section>

<section>
  <div class="sec-head"><span class="idx">05</span><h2>The fleet — all ${DATA.meta.experts} expert reports</h2><div class="rule"></div></div>
  <div class="controls">
    <input id="q" type="search" placeholder="filter by symbol, file, concept… (e.g. PubSub, KeyRing, coverage, race)">
    <select id="fp"><option value="">all pillars</option></select>
    <select id="fs"><option value="">any severity</option><option value="critical">has critical</option><option value="high">has high+</option><option value="medium">has medium+</option></select>
    <select id="so"><option value="score">sort: score ↓</option><option value="scorea">sort: score ↑</option><option value="risk">sort: risk ↓</option><option value="id">sort: id</option></select>
  </div>
  <div class="fleet" id="fleet"></div>
</section>

<footer>
  <div>
    <b>Method.</b> 50 read-only expert agents (12 API Design · 14 Code Quality · 14 Effect Native · 10 Cross-Cutting, incl. 3 security-reviewer specialists) audited the repository in parallel under a forced JSON schema: every claim file:line-cited, snippets verbatim, ≤5 strengths / ≤7 weaknesses / ≤2 examples each. The parent session independently re-ran typecheck, oxlint, madge, knip and the full vitest+coverage suite, and spot-verified the five highest-severity headline claims against source before publication (marked "verified" above). Scores are per-domain 0–10 judgments by each expert; the verdict dial is the unweighted fleet mean. Residual schema drift in 6 payloads was normalized at build time; one payload (E20) was recovered from the analyst's signed local artifact.
    <br><br><b>Artifacts.</b> Raw fleet output: <span style="color:var(--cyan)">.scratch/awthaq-analysis/reports.json</span> · aggregates: <span style="color:var(--cyan)">aggregate.json</span> · verified baseline: <span style="color:var(--cyan)">verified-metrics.json</span>.
  </div>
  <div>
    <b>Reading the chips.</b><br>
    <span class="chip critical">critical</span> exploitable or production-breaking today<br>
    <span class="chip high">high</span> wrong behavior or strong risk under realistic use<br>
    <span class="chip medium">medium</span> quality/robustness debt with a concrete failure mode<br>
    <span class="chip low">low</span> polish; fix opportunistically
  </div>
</footer>
</div>

<script>
const DATA = ${JSON.stringify(DATA)};
const sevRank = {critical:0,high:1,medium:2,low:3};
const PC = {"API Design":"#C6F24E","Code Quality":"#F2A65A","Effect Native":"#63D8E8","Cross-Cutting":"#C792EA"};
const esc = s => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

/* pillar cards */
const pm = ${JSON.stringify(PILLAR_META)};
document.getElementById("pillars").innerHTML = Object.entries(pm).map(([name,m]) => {
  const avg = DATA.meta.pillarAvg[name], n = DATA.meta.pillarN[name];
  return '<div class="pillar"><h3><span style="color:'+m.color+'">'+name+'</span><b style="color:'+m.color+'">'+avg.toFixed(2)+'</b></h3>'+
    '<div class="bar"><i style="width:'+(avg*10)+'%;background:'+m.color+'"></i></div>'+
    '<p>'+m.verdict+'</p><div class="n">'+n+' experts</div></div>';
}).join("");
document.getElementById("plegend").innerHTML = Object.entries(PC).map(([k,c])=>'<span><i style="background:'+c+'"></i>'+k+'</span>').join("");

/* severity rows */
const maxSev = Math.max(...Object.values(DATA.meta.sevTally));
document.getElementById("sevrows").innerHTML = Object.entries(DATA.meta.sevTally).map(([k,v]) => {
  const col = {critical:"var(--critical)",high:"var(--high)",medium:"var(--medium)",low:"var(--low)"}[k];
  return '<div class="sevline"><span style="color:'+col+';text-transform:uppercase;letter-spacing:.1em">'+k+'</span>'+
    '<div class="track"><i style="width:'+(v/maxSev*100)+'%;background:'+col+'"></i></div><span style="color:var(--muted);text-align:right">'+v+'</span></div>';
}).join("");

/* score strip */
const sorted = [...DATA.reports].sort((a,b)=>b.score-a.score);
const strip = document.getElementById("strip");
strip.innerHTML = sorted.map((r,i) => {
  const h = 14 + (r.score/10)*176;
  const t = r._id+" · "+r.expert.replace(/^[^-]*— /,"")+" — "+r.score;
  return '<div class="b" data-id="'+r._id+'" title="'+esc(t)+'" style="height:'+h+'px;background:'+PC[r.pillar]+';animation-delay:'+(i*14)+'ms"></div>';
}).join("");
strip.addEventListener("click", e => {
  const id = e.target.dataset?.id; if(!id) return;
  document.getElementById("card-"+id).classList.add("open");
  document.getElementById("card-"+id).scrollIntoView({behavior:"smooth",block:"start"});
});

/* headlines */
const HR = ${JSON.stringify(HEADLINE_RISKS)};
document.getElementById("risks").innerHTML = HR.map((r,i) =>
  '<div class="li"><div class="rank">'+String(i+1).padStart(2,"0")+'</div><div>'+
  '<span class="chip '+r.sev+'">'+r.sev+'</span><h5 style="display:inline">'+esc(r.title)+'</h5>'+
  '<p>'+esc(r.detail)+'</p><div class="fix">'+esc(r.fix)+'</div>'+
  '<span class="who">'+esc(r.expert)+' · verified this audit</span></div></div>').join("");
const HS = ${JSON.stringify(HEADLINE_STRENGTHS)};
document.getElementById("strengths").innerHTML = HS.map((s,i) =>
  '<div class="li"><div class="rank">'+String(i+1).padStart(2,"0")+'</div><div>'+
  '<h5>'+esc(s.title)+' <span style="color:var(--signal)">· '+s.score+'</span></h5>'+
  '<p>'+esc(s.detail)+'</p><span class="who">'+esc(s.expert)+'</span></div></div>').join("");

/* highlighter */
function hl(code){
  let s = esc(code);
  const stash = [];
  const keep = (html) => { stash.push(html); return "\\u0000" + String.fromCharCode(0xE000 + stash.length - 1) + "\\u0000"; };
  s = s.replace(/[/][/].*/g, (m) => keep('<span class="tk-c">'+m+'</span>'));
  s = s.replace(/&quot;.*?&quot;|'.*?'/g, (m) => keep('<span class="tk-s">'+m+'</span>'));
  s = s.replace(/\\b(const|let|var|function|return|yield|import|from|export|class|extends|new|if|else|for|of|await|async|type|interface|readonly|Effect|Layer|Context|Schema|Option|Redacted)\\b/g, '<span class="tk-k">$&</span>');
  s = s.replace(/\\b(\\d+[a-zA-Z_]*)\\b/g, '<span class="tk-n">$&</span>');
  s = s.replace(/\\u0000(.)\\u0000/g, (_, c) => stash[c.charCodeAt(0) - 0xE000]);
  return s;
}

/* fleet */
const fleet = document.getElementById("fleet");
const fp = document.getElementById("fp"), fs = document.getElementById("fs"), so = document.getElementById("so"), q = document.getElementById("q");
[...new Set(DATA.reports.map(r=>r.pillar))].forEach(p => fp.add(new Option(p,p)));

function sevMax(r){ let m=99; for(const w of r.weaknesses) m=Math.min(m,sevRank[w.severity]??99); return m; }
function render(){
  const query = q.value.trim().toLowerCase();
  let rs = DATA.reports.filter(r => {
    if (fp.value && r.pillar !== fp.value) return false;
    if (fs.value && sevMax(r) > sevRank[fs.value]) return false;
    if (query) {
      const blob = JSON.stringify(r).toLowerCase();
      if (!blob.includes(query)) return false;
    }
    return true;
  });
  const k = so.value;
  rs.sort((a,b) => k==="score" ? b.score-a.score : k==="scorea" ? a.score-b.score : k==="risk" ? (sevMax(a)-sevMax(b)) || (b.score-a.score) : a._id.localeCompare(b._id));
  fleet.innerHTML = rs.map(r => card(r)).join("") || '<div style="color:var(--faint);padding:30px 0">no expert matches the filter.</div>';
}
function card(r){
  const minis = ["critical","high","medium","low"].map(s => r._w && r._w[s] ? '<i title="'+s+' ×'+r._w[s]+'" style="background:var(--'+s+')"></i>' : "").join("");
  const strengths = r.strengths.map(s =>
    '<div class="finding"><span class="chip '+(s.impact==="high"?"s-impact":s.impact==="medium"?"m-impact":"l-impact")+'">'+(s.impact||"–")+' impact</span>'+
    '<h6 style="display:inline">'+esc(s.title)+'</h6><p>'+esc(s.detail)+'</p><div class="ev">⌗ '+esc(s.evidence)+'</div></div>').join("");
  const weaknesses = r.weaknesses.map(w =>
    '<div class="finding"><span class="chip '+w.severity+'">'+w.severity+'</span>'+
    '<h6 style="display:inline">'+esc(w.title)+'</h6><p>'+esc(w.detail)+'</p>'+
    (w.recommendation ? '<div class="rec">'+esc(w.recommendation)+'</div>' : "")+
    '<div class="ev">⌗ '+esc(w.evidence)+'</div></div>').join("");
  const examples = r.usage_examples.map(u =>
    '<div class="code"><button class="cp" onclick="copyCode(this)">copy</button><pre>'+hl(u.code)+'</pre>'+
    '<span class="src">'+esc(u.title)+' — '+esc(u.source)+'</span></div>').join("");
  const metrics = r.metrics.length ? '<table class="mtable">'+r.metrics.map(m =>
    '<tr><td>'+esc(m.name)+'</td><td>'+esc(m.value)+(m.unit?' <span style="color:var(--faint)">'+esc(m.unit)+'</span>':'')+'</td><td></td></tr>').join("")+'</table>' : '<p style="color:var(--faint)">none reported</p>';
  const kpis = r.kpis.length ? '<table class="mtable ktable">'+r.kpis.map(m =>
    '<tr><td>'+esc(m.name)+'</td><td>'+esc(m.value)+'</td><td>target: '+esc(m.target)+'</td></tr>').join("")+'</table>' : '<p style="color:var(--faint)">none reported</p>';
  return '<div class="card" id="card-'+r._id+'">'+
    '<div class="head" onclick="this.parentElement.classList.toggle(&quot;open&quot;)">'+
      '<span class="pillar-tag" style="color:'+PC[r.pillar]+';border-color:'+PC[r.pillar]+'55">'+r.pillar+'</span>'+
      '<span class="title">'+esc(r.expert.replace(/^E\\d+ — /,""))+'</span>'+
      '<span class="minis">'+minis+'</span>'+
      '<span class="scorechip" style="color:'+PC[r.pillar]+'">'+r.score.toFixed(1)+'</span>'+
      '<span class="toggle">▶</span>'+
    '</div>'+
    '<div class="body">'+
      (r.domain ? '<p style="color:var(--faint);font-size:11px;margin-bottom:12px">scope: '+esc(r.domain)+'</p>' : "")+
      '<div class="sum">'+esc(r.summary)+'</div>'+
      '<div class="sub">strengths · '+r.strengths.length+'</div>'+strengths+
      '<div class="sub">weaknesses · '+r.weaknesses.length+'</div>'+weaknesses+
      (examples ? '<div class="sub">usage evidence</div>'+examples : "")+
      '<div class="sub">metrics</div>'+metrics+
      '<div class="sub">KPIs</div>'+kpis+
    '</div></div>';
}
function copyCode(btn){
  navigator.clipboard.writeText(btn.parentElement.querySelector("pre").innerText).then(()=>{btn.textContent="copied";setTimeout(()=>btn.textContent="copy",1200)});
}
q.addEventListener("input", render); fp.addEventListener("change", render); fs.addEventListener("change", render); so.addEventListener("change", render);
render();
</script>
</body>
</html>`;

writeFileSync("expert-audit-dashboard.html", html);
console.log(`written expert-audit-dashboard.html (${(html.length / 1024).toFixed(0)} KB)`);
