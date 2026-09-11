import { hybridSearchDecisions, hybridSearchFeatures } from "./hybrid";
import { getFeature, implementationsOf, memoryScopeFor, searchDecisions } from "./store";

import { implementationLine, toDecisionCard, toFeatureCard, type FeatureDetail, type MemoryAccess, type MemorySearchRequest, type MemorySearchResult } from "./cards";

export * from "./cards";

/**
 * Memory as the server reads it, for one team. The shapes and the text
 * renderers live in ./cards, which has no database behind it; this is the
 * one implementation that does.
 */
export class LocalMemoryAccess implements MemoryAccess {
  constructor(private readonly teamId: string) {}

  async search(req: MemorySearchRequest): Promise<MemorySearchResult> {
    const scope = memoryScopeFor(this.teamId);
    const limit = Math.min(Math.max(req.limit ?? 10, 1), 50);
    const features = req.query ? (await hybridSearchFeatures(scope, req.query, 5)).map((f) => toFeatureCard(f)) : [];
    const decisions = (
      await hybridSearchDecisions(scope, {
        query: req.query,
        paths: req.paths,
        featureId: req.featureId,
        asOf: req.asOf,
        since: req.since,
        limit,
      })
    ).map(toDecisionCard);
    return { scope: { own: scope.own, teams: scope.teams }, features, decisions };
  }

  async feature(id: string): Promise<FeatureDetail | null> {
    const scope = memoryScopeFor(this.teamId);
    const feature = getFeature(id);
    if (!feature || feature.orgId !== scope.orgId) return null;
    const implementations = implementationsOf(scope, id);
    const decisions = searchDecisions(scope, { featureId: id, limit: 50 }).map(toDecisionCard);
    return {
      feature: toFeatureCard(feature, implementations.map((i) => i.teamId)),
      implementations: implementations.map(implementationLine),
      decisions,
    };
  }
}

