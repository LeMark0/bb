import { fileURLToPath } from "node:url";
import base from "../../../packages/process-utils/vitest.config.ts";

const directory = process.env.BB_VCS_DIAG_DIR;
if (!directory) throw new Error("BB_VCS_DIAG_DIR must name the diagnostic output directory");

export default {
  ...base,
  root: fileURLToPath(new URL("../../../packages/process-utils/", import.meta.url)),
  test: {
    ...base.test,
    setupFiles: [...(base.test?.setupFiles ?? []), fileURLToPath(new URL("./trace-setup.mjs", import.meta.url))],
    reporters: ["verbose", "json"],
    outputFile: { json: `${directory}/vitest-results.json` },
  },
};
