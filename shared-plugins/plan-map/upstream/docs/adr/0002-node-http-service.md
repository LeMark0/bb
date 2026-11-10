# ADR: Run the local HTTP service with Node

## Context

Plan Map already requires Node for its TypeScript CLI and frontend build. Requiring a
JDK as well adds a separate installation step for teammates using the shared skill.
The user requested replacing the Java server with Node while preparing the Moonshot
import. This decision replaces the runtime choice in the historical first ADR.

## Decision

Use Node's built-in HTTP server, implemented in TypeScript and loaded through the
existing `tsx` dependency. The CLI launches the service with its own Node executable
and absolute module paths. Keep the service separate from the short-lived CLI process.

Preserve the GET-only API, loopback binding, Host/Origin checks, registered Markdown
access, one-megabyte file limit and static-directory restrictions. Retain the existing
map registry format. Health responses add the runtime and registry path so the CLI
only reuses a Node process serving the intended UI and registry.

## Consequences

Users need Node and npm, with no JDK installation. Existing skill links and feature
ADRs continue to work. A previously running Java service can be stopped explicitly to
reuse its port; otherwise the Node service uses another available local port.

Vitest HTTP and CLI integration tests exercise the real service with synthetic files,
including startup from another project with no tools on PATH. These checks cover the
runtime change, not browser layout or the ADR updater's full behaviour. The HTTP
service remains local and read-only, without authentication for shared hosting.

## Execution plan

```yaml plan-map
schema: plan-map/v1
id: ADR-node-http-service
title: Run the local HTTP service with Node
goal: Let teammates use Plan Map with Node and npm while preserving local service behaviour.
decision_status: accepted
updated_at: "2026-09-14T17:19:09Z"
baseline:
  kind: reconstructed
  captured_at: "2026-09-14T17:19:09Z"
  note: Reconstructed during implementation from the user's runtime-change request; original step wording and dependencies were not recorded.
  steps:
    - id: N1
      title: null
      needs: null
groups:
  - id: runtime
    title: Local runtime
    recap: Replace the service and keep the existing caller contract.
steps:
  - id: N1
    title: Serve registered plans with Node
    group: runtime
    status: done
    needs: []
    notes:
      - Use the existing tsx loader and built-in Node HTTP module.
      - Keep the historical first ADR unchanged.
    acceptance:
      - The viewer and registered Markdown remain accessible through the same routes.
      - Invalid host/origin, write requests and escaping static paths remain rejected.
      - The CLI starts Node without Java, reuses matching services and isolates registries.
    evidence:
      - On 2026-09-14, 32 HTTP contract tests passed against the original Java service before replacement.
      - On 2026-09-14, npm test passed 37 HTTP and CLI tests against Node, including malformed paths, startup without PATH tools, reuse, isolation and legacy-process handling.
    tickets: []
changes: []
assumptions: []
checks: []
questions: []
sessions: []
```
