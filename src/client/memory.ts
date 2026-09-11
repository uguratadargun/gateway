import type { FeatureDetail, MemoryAccess, MemorySearchRequest, MemorySearchResult } from "@/memory/cards";

import type { GateClient } from "./api";

/**
 * Memory as a run on this machine reaches it: over the client API with the
 * person's own key, which is what scopes it to their team.
 */
export class HttpMemoryAccess implements MemoryAccess {
  constructor(private readonly client: GateClient) {}

  search(req: MemorySearchRequest): Promise<MemorySearchResult> {
    return this.client.memorySearch(req);
  }

  feature(id: string): Promise<FeatureDetail | null> {
    return this.client.memoryFeature(id);
  }
}
