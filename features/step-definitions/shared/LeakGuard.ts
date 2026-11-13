// Plan 34: after every feature file, fail when a `TestAuth` app or a `TestSql` client is still open.
// `AWTHAQ_LEAK_GUARD=report` only prints the counts, for a contributor bisecting a leak.
import { TestAuth, TestSql } from "@awthaq/test";
import { afterAll, expect } from "vitest";

// A release already in flight (a mail drain waits up to its 5 s `drainTimeout`) is not a leak: wait for it.
const SETTLE_MS = 10_000;

afterAll(async () => {
  const deadline = Date.now() + SETTLE_MS;
  while ((TestAuth.openApps() > 0 || TestSql.openClients() > 0) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const file = expect.getState().testPath ?? "unknown";
  const relative = file.startsWith(process.cwd()) ? file.slice(process.cwd().length + 1) : file;
  const apps = TestAuth.openApps();
  const clients = TestSql.openClients();
  const line = `[leak-guard] ${relative} apps=${apps} sqlClients=${clients}`;
  process.stderr.write(`${line}\n`);
  if (process.env["AWTHAQ_LEAK_GUARD"] !== "report" && (apps > 0 || clients > 0)) {
    throw new Error(line);
  }
});
