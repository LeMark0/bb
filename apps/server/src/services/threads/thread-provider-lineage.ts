import {
  getThreadPluginMetadata,
  threads,
  type DbQueryConnection,
} from "@bb/db";
import { deepFreezePluginMetadata } from "@bb/domain";
import type { ExperimentalPluginProviderLineageEntry } from "@get-bb/plugin-sdk";
import { eq } from "drizzle-orm";

const PROVIDER_LINEAGE_DEPTH = 16;

export function readProviderOptionsLineage(
  db: DbQueryConnection,
  threadId: string,
): ExperimentalPluginProviderLineageEntry[] {
  const lineage: ExperimentalPluginProviderLineageEntry[] = [];
  const listed = new Set<string>();
  let nextThreadId: string | null = threadId;
  while (
    nextThreadId !== null &&
    lineage.length < PROVIDER_LINEAGE_DEPTH &&
    !listed.has(nextThreadId)
  ) {
    const row = db
      .select({
        sourceThreadId: threads.sourceThreadId,
        originPluginId: threads.originPluginId,
      })
      .from(threads)
      .where(eq(threads.id, nextThreadId))
      .get();
    if (row === undefined) break;
    listed.add(nextThreadId);
    lineage.push({
      threadId: nextThreadId,
      originPluginId: row.originPluginId,
      originPluginMetadata: deepFreezePluginMetadata(
        row.originPluginId === null
          ? {}
          : getThreadPluginMetadata(db, nextThreadId, row.originPluginId)
              .metadata,
      ),
    });
    nextThreadId = row.sourceThreadId;
  }
  return lineage;
}
