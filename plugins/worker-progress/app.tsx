import { useState } from "react";
import {
  definePluginApp,
  experimental_usePluginId,
  useBbNavigate,
  useComposer,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import { useWorkersSnapshot } from "./use-workers.js";
import { isWorkerBusy } from "./workers-model.js";
import {
  cardVisibility,
  nextIdleCardState,
  workerStates,
  type IdleCardState,
} from "./workers-view.js";
import { useRememberedExpansion, WorkersCard } from "./WorkersCard.js";

function useIdleCardState(
  anyBusy: boolean,
  coordinatorRunning: boolean,
): [IdleCardState, () => void] {
  const [state, setState] = useState<IdleCardState>({
    anyBusy,
    coordinatorRunning,
    dismissed: false,
    expanded: false,
  });
  const toggle = () =>
    setState((current) => ({ ...current, expanded: !current.expanded }));
  if (
    state.anyBusy === anyBusy &&
    state.coordinatorRunning === coordinatorRunning
  ) {
    return [state, toggle];
  }
  const next = nextIdleCardState(state, anyBusy, coordinatorRunning);
  setState(next);
  return [next, toggle];
}

function ThreadWorkers({
  threadId,
  coordinatorRunning,
}: {
  threadId: string;
  coordinatorRunning: boolean;
}) {
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const pluginId = experimental_usePluginId();
  const snapshot = useWorkersSnapshot(sdk, threadId);
  const states = workerStates(snapshot);
  const anyBusy = states.some(isWorkerBusy) || !snapshot.complete;
  const [idleCard, toggleIdle] = useIdleCardState(anyBusy, coordinatorRunning);
  const [busyExpanded, toggleBusy] = useRememberedExpansion(
    `${pluginId}:expanded:${threadId}`,
    true,
  );
  if (!snapshot.loaded) return null;
  const visibility = cardVisibility({
    workerCount: states.length,
    anyBusy,
    dismissedWhileIdle: idleCard.dismissed,
  });
  if (visibility === "hidden") return null;
  const isIdleCard = visibility === "all-idle";
  return (
    <WorkersCard
      snapshot={snapshot}
      isExpanded={isIdleCard ? idleCard.expanded : busyExpanded}
      onToggle={isIdleCard ? toggleIdle : toggleBusy}
      openThread={(id) => navigate.toThread(id)}
    />
  );
}

function WorkersBanner() {
  const composer = useComposer();
  if (composer.scope.kind !== "thread") return null;
  const threadId = composer.scope.threadId;
  return (
    <ThreadWorkers
      key={threadId}
      threadId={threadId}
      coordinatorRunning={composer.isRunning}
    />
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "workers",
    scopes: ["thread"],
    banners: [{ id: "workers", chrome: "bare", component: WorkersBanner }],
  });
});
