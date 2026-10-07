import { useMemo } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import { experimental_useSidebarThreads } from "@get-bb/plugin-sdk/app";

export interface LiveThreads {
  ready: boolean;
  byId: ReadonlyMap<string, PluginSidebarThread>;
}

export function useLiveThreads(): LiveThreads {
  const { status, threads } = experimental_useSidebarThreads();
  const byId = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread])),
    [threads],
  );
  return { ready: status !== "loading", byId };
}
