// Plan 02: the store contract on the `Ref` adapters.
import * as StoreContract from "../src/StoreContract.ts";
import { framework } from "./support/storeContract.ts";

StoreContract.run(framework, { mode: "memory" });
