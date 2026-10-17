import { parseArgs } from "node:util";
import { prepare, scan } from "./env-probe-lib.mjs";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    release: { type: "string" },
    scratch: { type: "string" },
    evidence: { type: "string" },
  },
});
if (positionals[0] === "prepare" && values.release && values.scratch && values.evidence) {
  prepare({ release: values.release, scratch: values.scratch, evidence: values.evidence });
} else if (positionals[0] === "scan" && values.evidence) {
  process.exitCode = scan({ evidence: values.evidence });
} else {
  console.error("usage: env-probe-host.mjs prepare --release DIR --scratch DIR --evidence DIR | scan --evidence DIR");
  process.exitCode = 64;
}
