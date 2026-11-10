import { Lexer } from "yaml";

import { parseAdr, type AdrDocument } from "./upstream/lib/adr.ts";

export const ADR_LIMITS = { flowDepth: 32, tokens: 60_000 } as const;

const PLAN_BLOCK = /^```yaml plan-map\s*\r?\n([\s\S]*?)^```\s*$/gm;

export function checkAdrShape(markdown: string): void {
  for (const block of markdown.matchAll(PLAN_BLOCK)) {
    let depth = 0;
    let tokens = 0;
    for (const token of new Lexer().lex(block[1] ?? "")) {
      tokens += 1;
      if (tokens > ADR_LIMITS.tokens) {
        throw new Error(`The plan-map block is too large to read safely (over ${ADR_LIMITS.tokens.toLocaleString("en-GB")} YAML tokens). Split or shorten the plan.`);
      }
      if (token === "[" || token === "{") {
        depth += 1;
        if (depth > ADR_LIMITS.flowDepth) {
          throw new Error(`The plan-map block nests [ ] or { } more than ${ADR_LIMITS.flowDepth} levels deep.`);
        }
      } else if (token === "]" || token === "}") {
        depth = Math.max(0, depth - 1);
      }
    }
  }
}

export function parseBoundedAdr(markdown: string): AdrDocument {
  if (markdown.length > 1_000_000) throw new Error("ADR exceeds the 1 MB limit.");
  checkAdrShape(markdown);

  return parseAdr(markdown);
}
