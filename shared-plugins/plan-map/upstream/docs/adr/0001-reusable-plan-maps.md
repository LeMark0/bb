# ADR: Reusable plan maps

This is a sanitised historical record. Personal names and source-project identifiers have been removed from the prose, evidence and baseline note. Step IDs, scope, dates and recorded outcomes are preserved. It records the original implementation, not the tool's current readiness or installation requirements.

## Context

The original requester needed to track scope, discoveries and progress across large agent-assisted features. A working prototype rendered one reconstructed feature report, but its content and layout were tied to that feature.

## Decision

Keep one feature ADR in the owning project, with readable decision prose and a versioned YAML execution-plan block. Store the reusable TypeScript viewer in a separate repository. A Claude Code skill creates or attaches to the ADR, validates updates and opens the local viewer. Use a Java 21 read-only service for registered files.

## Consequences

The original baseline and later changes remain distinguishable. Sessions can continue the same feature record. Recording evidence still depends on the agent and reviewer; this viewer does not independently audit completion. A local Java 21 runtime and Node 22 build tooling are required. Direct edits outside the helper can bypass update-history validation. New revisions are offered for explicit loading to preserve the user’s current inspection.

## Execution plan

```yaml plan-map
schema: plan-map/v1
id: ADR-plan-map
title: Reusable ADR-driven plan maps
goal: Keep a feature’s plan, progress and decision history readable across Claude Code sessions
  through one reusable viewer.
decision_status: accepted
updated_at: 2026-09-10T10:15:34.173Z
baseline:
  kind: original
  captured_at: 2026-09-09T17:27:54.987Z
  note: Scope agreed with the original requester on 9 September 2026. This is the first written
    implementation baseline; work on the contract and prototype had already started.
  steps:
    - id: P1
      title: Define the versioned ADR contract
      needs: []
    - id: P2
      title: Generalise the interactive viewer
      needs:
        - P1
    - id: P3
      title: Serve project ADRs from a separate local repository
      needs:
        - P1
    - id: P4
      title: Package and install the Claude Code skill
      needs:
        - P1
        - P3
    - id: P5
      title: Verify reuse and the complete invocation flow
      needs:
        - P2
        - P3
        - P4
groups:
  - id: contract
    title: ADR contract
    recap: A durable decision and execution record with explicit provenance.
  - id: viewer
    title: Interactive viewer
    recap: Reusable navigation and inspection of any valid feature ADR.
  - id: bridge
    title: Local file access
    recap: Read project records without copying them into the UI repository.
  - id: workflow
    title: Claude workflow
    recap: Invoke, update and verify the map from existing or new sessions.
steps:
  - id: P1
    title: Define the versioned ADR contract
    group: contract
    status: done
    needs: []
    notes: []
    evidence:
      - Validated the template, two unrelated ADRs and the rejection of invalid references, cycles,
        unsupported versions, missing evidence, baseline rewrites and unrecorded scope changes on 9
        September 2026.
    acceptance:
      - Reject invalid references, cycles and unsupported format versions.
    tickets: []
  - id: P2
    title: Generalise the interactive viewer
    group: viewer
    status: done
    needs:
      - P1
    notes:
      - Reusable rendering and browser interaction were verified after an earlier environment
        blocker was resolved.
    evidence:
      - "10 September 2026: inspected a 45-step project ADR and this unrelated viewer ADR in
        the shared browser. Selection retained all nodes, edges, positions and viewport without
        dimming; explicit scope navigation and the recap worked."
    acceptance:
      - Render unrelated plans without source-specific IDs or copy.
      - Node selection preserves the visible map and viewport.
    tickets: []
  - id: P3
    title: Serve project ADRs from a separate local repository
    group: bridge
    status: done
    needs:
      - P1
    notes: []
    evidence:
      - Java 21 compilation passed. Read-only service returned both registered ADRs through HTTP on
        port 5180 on 9 September 2026.
    acceptance:
      - Register only the named ADR and serve the viewer locally.
      - Keep feature records in their owning project.
    tickets: []
  - id: P4
    title: Package and install the Claude Code skill
    group: workflow
    status: done
    needs:
      - P1
      - P3
    notes: []
    evidence:
      - Claude Code 2.1.205 invoked /plan-map open and returned ADR-plan-map with 5 steps. The
        symlink wrapper issue found by that run was fixed; check and open passed through the
        installed global skill path. Skill quick_validate passed.
    acceptance:
      - Create, update and open an ADR from an existing session.
      - Refuse stale writes and baseline rewrites.
    tickets: []
  - id: P5
    title: Verify reuse and the complete invocation flow
    group: workflow
    status: done
    needs:
      - P2
      - P3
      - P4
    notes:
      - The earlier CLI/update checks remain recorded below. Browser verification completed after
        the environment became available.
    evidence:
      - "9 September: recorded actual Claude invocation, stale-update rejection and unrelated ADR
        validation. 10 September: installed helpers created, updated and opened an unrelated project ADR;
        both that project record and this viewer record rendered in the browser.
        Selection, scope navigation, recap and explicit Load update were checked."
    acceptance:
      - Validate two unrelated ADRs and inspect both in the browser.
      - Prove invalid updates fail without modifying the ADR.
    tickets: []
  - id: P6
    title: Make map statuses distinguishable with readable card backgrounds
    group: viewer
    status: done
    needs:
      - P2
    notes:
      - Green done, blue in progress, neutral to do, rose blocked and lilac parked. Text/icons
        remain; parked cards also have dashed borders. Selection retains the status surface.
        Workstreams containing only parked steps now correctly report Parked.
    evidence:
      - "10 September: browser inspected all five statuses across 45 real steps in light and dark
        themes. Minimum computed text contrast, including change labels, was 4.7:1 light and 6.4:1
        dark. Selected blocked card kept its fill and received an outline, with all positions
        unchanged. npm run lint and npm run build passed; the Impeccable detector returned no
        findings."
    acceptance:
      - Each status has a distinct background and readable text in both themes.
      - Labels and icons distinguish statuses independently of colour.
      - Selection preserves the status fill and existing map behaviour.
    tickets: []
  - id: P7
    title: Explain the original plan, current plan and recorded reasons together
    group: viewer
    status: done
    needs:
      - P2
    notes:
      - Changed, added and parked steps show Originally and Now near the title, followed by the
        latest recorded change and its reason. Dependency differences use linked step names. Unknown
        wording, prerequisites or reasons remain explicit. Proposed and rejected records cannot
        explain an applied change.
      - The recap exposes the preserved baseline in its original order and links to changed, added
        and parked steps. Existing ADR data was not rewritten to manufacture plain-language
        explanations.
    evidence:
      - "10 September 2026: browser verified an unrelated project ADR. A parked
        step showed its original inclusion, current state and recorded reason.
        A changed step named its added dependencies and acknowledged its missing
        direct reason. An added step correctly showed it was added. The recap listed all nine
        original steps in baseline order; selection retained all node positions and viewport. No
        horizontal inspector overflow at the current narrow width."
      - npm run lint and npm run build passed. Impeccable detector returned no findings.
    acceptance:
      - A reader can compare the original and current step near the top of the inspector.
      - Reasons come from recorded evidence; missing reasons are not inferred.
      - The recap exposes the original plan and comparison navigation without changing graph scope.
    tickets: []
  - id: P8
    title: Open linked tickets from step cards and details
    group: viewer
    status: done
    needs:
      - P2
    notes:
      - Tickets accept existing plain identifiers, HTTP(S) URL strings or explicit id/url objects.
        The viewer does not guess tracker workspaces. Step cards show the first ticket and a count
        for extras; the inspector lists every ticket. Search includes ticket identifiers.
      - Seven canonical ticket URLs were recovered from tracker-generated comments on source-project
        PRs. They were added to nine steps in a project ADR using the stale-hash checked helper.
        One ticket remained unlinked because no destination was verified; the tracker connector
        required reauthentication.
      - The original requester subsequently required the project's tracker connector for lookups.
        That installation reported authentication failures, preserved existing references and left
        unknown destinations unlinked. This records a historical project preference; the shared
        skill follows each owning project's tracker guidance.
    evidence:
      - "10 September 2026: the browser rendered ticket links on nine step cards and the step
        inspector. Mouse activation of one ticket and keyboard activation of another left selection,
        all 19 node positions and viewport unchanged. Links use a new-tab target and an
        external-link icon."
      - npm run lint, npm run build and javac -d work/server server/PlanMapServer.java passed.
        Impeccable detector returned no findings. Direct schema/adapter assertions passed for legacy
        IDs, explicit links, URL strings and rejection of javascript, data and relative object
        destinations.
    acceptance:
      - Known ticket destinations are accessible from the node and its details.
      - Ticket activation preserves the map and selected step.
      - Existing ADRs remain valid and unknown destinations remain text.
    tickets: []
changes:
  - id: C1
    at: 2026-09-10T09:39:24.455Z
    author: Original requester (name removed)
    status: accepted
    summary: Use status backgrounds to make the map easier to scan
    why: The original requester reported that statuses were hard to distinguish and requested different backgrounds while
      keeping the text readable.
    affects:
      - P6
    evidence:
      - "User request in the original implementation discussion on 10 September 2026: improve status visibility using
        item backgrounds."
  - id: C2
    at: 2026-09-10T09:59:43.908Z
    author: Original requester (name removed)
    status: accepted
    summary: Explain Changed since plan with a visible original/current comparison
    why: The original requester wanted to understand the initial plan and the changes in simple language. The old
      inspector separated the original wording from current details and the reason, making the
      comparison easy to miss.
    affects:
      - P7
    evidence:
      - User request in the original implementation discussion on 10 September 2026, including a parked-step
        example.
  - id: C3
    at: 2026-09-10T10:15:34.173Z
    author: Original requester (name removed)
    status: accepted
    summary: Link tickets from their plan nodes
    why: The original requester wanted ticket links on nodes when tickets exist, so readers can move from a plan step to
      the tracked work.
    affects:
      - P8
    evidence:
      - User request in the original implementation discussion on 10 September 2026.
assumptions:
  - id: A1
    statement: A versioned structured block inside Markdown is sufficient to render the plan without
      inferring dependencies from prose.
    status: supported
    evidence:
      - Both an unrelated project ADR and this viewer ADR rendered from their structured blocks
        without source-specific viewer changes.
checks:
  - id: V1
    title: Typecheck, lint and production build
    status: passed
    evidence:
      - npm run lint, npm run build (including TypeScript check), and javac compilation passed on 9
        September 2026.
  - id: V2
    title: Validate unrelated ADRs and reject invalid updates
    status: passed
    evidence:
      - Validated 5-step and 20-step ADRs; retained 16 dependencies; stale apply left the
        file unchanged; create and a recorded scope update succeeded.
  - id: V3
    title: Inspect the viewer and skill invocation flow
    status: passed
    evidence:
      - Earlier Claude invocation and installed helper checks passed. 10 September browser
        verification covered unrelated ADR rendering, node selection without
        filtering/dimming/movement, explicit workstream exploration, recap and Load update.
  - id: V4
    title: Status colours, contrast and parked workstream semantics
    status: passed
    evidence:
      - All five status fills inspected against real data in both themes. Minimum measured text
        contrast 4.7:1 light and 6.4:1 dark; labels/icons retained. Parked-only workstream displays
        Parked / All parked. Selection retains its fill and changes only the outline.
      - npm run lint and npm run build passed; mechanical design detector returned [].
  - id: V5
    title: Before/now comparisons and recap navigation
    status: passed
    evidence:
      - Live browser checks covered a parked original step, an added step, changed named
        prerequisites and a missing recorded reason. The original nine-step order was preserved.
        Selection left the map unchanged and the inspector had no horizontal overflow. Lint and
        production build passed.
  - id: V6
    title: Ticket destinations and isolated link activation
    status: passed
    evidence:
      - Browser checks confirmed nine linked cards and the step inspector link, with unchanged
        graph selection and viewport after mouse and keyboard activation. Schema checks preserved
        legacy records and rejected unsupported URL protocols. Lint, build and Java compilation
        passed.
questions: []
sessions: []
```
