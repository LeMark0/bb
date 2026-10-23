import { useMemo, useSyncExternalStore } from "react";
import {
  createWorkersStore,
  type WorkersSdk,
  type WorkersSnapshot,
} from "./workers-store.js";

export function useWorkersSnapshot(
  sdk: WorkersSdk,
  threadId: string,
): WorkersSnapshot {
  const store = useMemo(
    () => createWorkersStore(sdk, threadId),
    [sdk, threadId],
  );
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}

const CLOCK_INTERVAL_MS = 1_000;
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;
let clockNow = Date.now();

function subscribeClock(listener: () => void): () => void {
  clockListeners.add(listener);
  if (clockTimer === null) {
    clockNow = Date.now();
    clockTimer = setInterval(() => {
      clockNow = Date.now();
      clockListeners.forEach((notify) => notify());
    }, CLOCK_INTERVAL_MS);
  }
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockTimer !== null) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

const readClock = () => clockNow;
const readClockMinute = () => Math.floor(clockNow / 60_000) * 60_000;

export function useNow(): number {
  return useSyncExternalStore(subscribeClock, readClock, readClock);
}

export function useNowMinute(): number {
  return useSyncExternalStore(subscribeClock, readClockMinute, readClockMinute);
}
