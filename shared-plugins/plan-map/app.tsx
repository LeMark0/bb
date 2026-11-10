import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  definePluginApp,
  experimental_InfoSection as InfoSection,
  experimental_useAppPanel,
  experimental_usePluginId,
  useBbContext,
  useComposer,
  useRealtime,
  useRpc,
  type ExperimentalThreadActionTabProps,
  type ExperimentalThreadInfoProps,
} from "@get-bb/plugin-sdk/app";

import { InitActions, type BindOutcome, type DraftTarget, type ProjectState } from "./init-actions.tsx";
import { PlanMapView, type ReadMap, type ReadMaps } from "./plan-map-view.tsx";
import { MAPS_CHANGED } from "./channels.ts";
import type { MapEntry, rpcContract } from "./server.ts";

const TAB = { id: "plan-map", context: { kind: "thread" }, availability: "action" } as const;
const PROJECT_ID_PATTERN = /^proj_[a-z0-9]+$/u;
const EMPTY_HINT = "No plan is bound to this project yet.";

function projectIdFrom(params: unknown, fallback: string | null | undefined): string | null {
  if (typeof params === "object" && params !== null && "projectId" in params) {
    const value = (params as { projectId: unknown }).projectId;
    if (typeof value === "string" && PROJECT_ID_PATTERN.test(value)) return value;
  }

  return fallback && PROJECT_ID_PATTERN.test(fallback) ? fallback : null;
}

function ProjectPlanMap({ projectId }: { projectId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const readMaps = useCallback<ReadMaps>(
    async () => (await rpcRef.current.call("listMaps", { projectId })).maps,
    [projectId],
  );
  const readMap = useCallback<ReadMap>(
    async (mapId) => {
      const result = await rpcRef.current.call("readMap", { projectId, mapId });
      if (!result.ok) throw new Error(result.message);

      return result.text;
    },
    [projectId],
  );

  const composer = useComposer();
  const [mapsVersion, setMapsVersion] = useState(0);
  const [project, setProject] = useState<ProjectState>({ status: "loading" });
  const [projectAttempt, setProjectAttempt] = useState(0);
  const retryProject = useCallback(() => {
    setProject({ status: "loading" });
    setProjectAttempt((value) => value + 1);
  }, []);
  const refresh = useCallback(() => setMapsVersion((value) => value + 1), []);

  useRealtime(MAPS_CHANGED, (payload) => {
    if (typeof payload === "object" && payload !== null && "projectId" in payload && payload.projectId === projectId) refresh();
  });

  useEffect(
    function readProject() {
      let isCurrent = true;
      rpcRef.current.call("projectInfo", { projectId }).then(
        (result) => {
          if (!isCurrent) return;
          setProject(result.ok ? { status: "ready", name: result.name, root: result.root } : { status: "error", message: result.message, code: result.code });
        },
        (reason) => {
          if (isCurrent) setProject({ status: "error", message: reason instanceof Error ? reason.message : String(reason) });
        },
      );

      return () => {
        isCurrent = false;
      };
    },
    [projectId, projectAttempt],
  );

  const bind = useCallback(
    async (path: string): Promise<BindOutcome> => {
      const result = await rpcRef.current.call("bindMap", { projectId, path });

      return result.ok ? { ok: true, path: result.path, title: result.title, alreadyBound: result.alreadyBound } : { ok: false, message: result.message };
    },
    [projectId],
  );

  const draft = useMemo<DraftTarget>(
    () => ({
      isAvailable: composer.scope.kind === "thread",
      text: () => composer.text,
      insert: (text) => composer.insert(text, { at: "end", block: true }),
      focus: () => composer.focus(),
    }),
    [composer, composer.scope.kind],
  );

  return (
    <PlanMapView
      pluginId={experimental_usePluginId()}
      projectId={projectId}
      readMaps={readMaps}
      readMap={readMap}
      emptyHint={EMPTY_HINT}
      mapsVersion={mapsVersion}
      emptyActions={<InitActions project={project} draft={draft} bind={bind} onBound={refresh} onRetryProject={retryProject} />}
    />
  );
}

function PlanMapTab({ params }: ExperimentalThreadActionTabProps) {
  const context = useBbContext();
  const projectId = projectIdFrom(params, context.projectId);
  if (projectId === null) {
    return <p className="p-4 text-xs text-muted-foreground">Open Plan Map from a project conversation.</p>;
  }

  return <ProjectPlanMap key={projectId} projectId={projectId} />;
}

function PlanMapEntry({ projectId }: ExperimentalThreadInfoProps) {
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const panel = experimental_useAppPanel();
  const [maps, setMaps] = useState<MapEntry[] | null>(null);

  useEffect(
    function readBoundMaps() {
      let isCurrent = true;
      setMaps(null);
      rpcRef.current.call("listMaps", { projectId }).then(
        (result) => {
          if (isCurrent && result.projectId === projectId) setMaps(result.maps);
        },
        () => {
          if (isCurrent) setMaps([]);
        },
      );

      return () => {
        isCurrent = false;
      };
    },
    [projectId],
  );

  if (!maps || maps.length === 0) return null;

  return (
    <InfoSection label="Plan map">
      <button
        type="button"
        onClick={() => panel.openTab({ tab: TAB, params: { projectId }, title: "Plan map" })}
        className="self-start rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Open plan map · {maps.length} {maps.length === 1 ? "ADR" : "ADRs"}
      </button>
    </InfoSection>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_tab({
    ...TAB,
    title: "Plan map",
    icon: "Network",
    layout: "flush",
    component: PlanMapTab,
    run: ({ experimental_panel }) => {
      experimental_panel.openTab({ tab: TAB, title: "Plan map" });
    },
  });
  app.slots.experimental_threadInfoSection({
    id: "plan-map",
    group: "0_projectContext",
    order: 25,
    component: PlanMapEntry,
  });
});
