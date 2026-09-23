import type { ActivityCard, FeatureDetail, HistoryResult, MemoryAccess, MemoryHistoryRequest, MemorySearchRequest, MemorySearchResult } from "@/memory/cards";

import type { GateClient } from "./api";

/**
 * Memory as a run on this machine reaches it: over the client API with the
 * person's own key, which is what scopes it to their team.
 */
export class HttpMemoryAccess implements MemoryAccess {
  /**
   * `remoteUrl` is the origin of the repository the run works in, sent with
   * every search so the answer is about this codebase and not the one next to
   * it with the same file names. Raw, for the server to name — and never
   * asked of the model, which has no way to know it. `executionId` is the run
   * asking, which the server leaves out of what is in flight.
   */
  constructor(
    private readonly client: GateClient,
    private readonly remoteUrl: string | null = null,
    private readonly executionId: string | null = null,
  ) {}

  search(req: MemorySearchRequest): Promise<MemorySearchResult> {
    return this.client.memorySearch(req, this.remoteUrl, this.executionId);
  }

  feature(id: string): Promise<FeatureDetail | null> {
    return this.client.memoryFeature(id);
  }

  history(req: MemoryHistoryRequest): Promise<HistoryResult> {
    return this.client.memoryHistory(req, this.remoteUrl);
  }

  activity(): Promise<ActivityCard[]> {
    return this.client.memoryActivity();
  }
}
