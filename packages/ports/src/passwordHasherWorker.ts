// @awthaq/ports — passwordHasherWorker
//
// ERS-001: the worker-thread entry `PasswordHasherWorkerPool` spawns. It is a
// process entry point, not part of the package's public surface (it is not
// exported from `index.ts`); an application reaches it through
// `PasswordHasherWorkerPool.workerEntry`.
//
// Deliberately free of Effect and of any awthaq import: it only derives raw
// digest bytes with hash-wasm and posts them back. Parsing, ceilings, the
// rehash policy and the constant-time comparison all stay on the main thread,
// so there is one implementation of each, shared with the calling-thread
// layers.
//
// Wire protocol (Effect's worker platform framing): the worker announces
// readiness with `[0]`; the parent sends `[0, request]` (or `[1]` to close);
// the worker answers each request with `[1, response]`. Types are imported
// with `import type` so the file needs nothing but Node's own type stripping
// to run from source.

import { parentPort } from "node:worker_threads";
import { argon2id, scrypt } from "hash-wasm";
import type { HasherWorkerRequest, HasherWorkerResponse } from "./PasswordHasherWorkerPool.ts";

const derive = (request: HasherWorkerRequest): Promise<Uint8Array> =>
  request.kind === "argon2id"
    ? argon2id({ ...request.job, outputType: "binary" })
    : scrypt({ ...request.job, outputType: "binary" });

const isRequest = (message: unknown): message is readonly [0, HasherWorkerRequest] =>
  Array.isArray(message) && message[0] === 0 && typeof message[1] === "object";

if (parentPort === null) {
  throw new Error("awthaq: passwordHasherWorker must be started as a worker thread");
}
const port = parentPort;

port.on("message", (message: unknown) => {
  if (isRequest(message)) {
    const request = message[1];
    derive(request).then(
      (digest) => {
        const response: HasherWorkerResponse = { id: request.id, digest };
        port.postMessage([1, response]);
      },
      (error: unknown) => {
        // A derivation failure is reported, never a crash: the pool maps it to `KdfFailed`.
        const response: HasherWorkerResponse = { id: request.id, error: String(error) };
        port.postMessage([1, response]);
      },
    );
  } else {
    port.close();
  }
});

port.postMessage([0]);
