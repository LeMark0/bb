import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runProbe } from "./env-probe-lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(here, "..", "..", "probe-config.json"), "utf8"));
process.exitCode = await runProbe({ config });
