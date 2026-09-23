import { inFlight } from "./activity";
import { hybridSearchDecisions, hybridSearchDocs, hybridSearchFeatures } from "./hybrid";
import { heldAnswerCount, liveIssues } from "./issues";
import { designDocsOf, historyOf, interfacesMentioned, toDocumentCard } from "./record-index";
import { getFeature, implementationsOf, memoryScopeFor, searchDecisions } from "./store";

import {
  implementationLine,
  toDecisionCard,
  toFeatureCard,
  toIssueCard,
  type ActivityCard,
  type FeatureDetail,
  type HistoryResult,
  type MemoryAccess,
  type MemoryHistoryRequest,
  type MemorySearchRequest,
  type MemorySearchResult,
} from "./cards";

export * from "./cards";

/**
 * Memory as the server reads it, for one team. The shapes and the text
 * renderers live in ./cards, which has no database behind it; this is the
 * one implementation that does.
 */
export class LocalMemoryAccess implements MemoryAccess {
  /**
   * `repoId` is the repository the caller is working in, when there is one.
   * A run's own is passed in by the runner rather than asked of the model:
   * the model has no way to know the canonical name, and a wrong one here
   * hides the decision that would have stopped it.
   */
  constructor(
    private readonly teamId: string,
    private readonly repoId: string | null = null,
    /**
     * Who is asking, so their own runs are not reported to them as somebody
     * else's work in flight: the run doing the asking, and the person's other
     * runs, which are theirs to know about.
     */
    private readonly asker: { executionId?: string | null; userId?: string | null } = {},
  ) {}

  async search(req: MemorySearchRequest): Promise<MemorySearchResult> {
    const scope = memoryScopeFor(this.teamId);
    const repoId = this.repoId ?? req.repoId ?? null;
    const limit = Math.min(Math.max(req.limit ?? 10, 1), 50);
    const features = req.query ? (await hybridSearchFeatures(scope, req.query, 5)).map((f) => toFeatureCard(f)) : [];
    const decisions = (
      await hybridSearchDecisions(scope, {
        query: req.query,
        paths: req.paths,
        repoId,
        featureId: req.featureId,
        asOf: req.asOf,
        since: req.since,
        limit,
      })
    ).map(toDecisionCard);
    // Objections are looked up by the same paths and feature the decisions
    // were, plus the decisions actually found: a planner that reaches a
    // decision must reach the disagreement standing against it in the same
    // answer, or it will plan against a decision somebody has already refused.
    const issues = liveIssues(scope, {
      paths: req.paths,
      repoId,
      featureId: req.featureId,
      decisionIds: decisions.map((d) => d.id),
      limit,
    }).map(toIssueCard);
    // The repositories' own documents: a sibling's design doc is how it built
    // the feature, in its own words, whether or not a run ever recorded it.
    const documents = (await hybridSearchDocs(scope, { query: req.query, paths: req.paths, repoId, limit: Math.min(limit, 8) })).map((d) =>
      toDocumentCard(d),
    );
    const interfaces = req.query ? interfacesMentioned(scope, req.query) : [];
    const running = req.query
      ? inFlight(scope, { query: req.query, excludeExecution: this.asker.executionId ?? null, excludeUserId: this.asker.userId ?? null, limit: 5 })
      : [];
    return {
      scope: { own: scope.own, teams: scope.teams },
      features,
      decisions,
      issues,
      heldAnswers: heldAnswerCount(scope),
      documents,
      interfaces,
      inFlight: running,
    };
  }

  async history(req: MemoryHistoryRequest): Promise<HistoryResult> {
    const scope = memoryScopeFor(this.teamId);
    return historyOf(scope, { repoId: this.repoId ?? req.repoId ?? null, paths: req.paths ?? [], since: req.since, limit: req.limit });
  }

  async activity(): Promise<ActivityCard[]> {
    return inFlight(memoryScopeFor(this.teamId), { excludeExecution: this.asker.executionId ?? null, excludeUserId: this.asker.userId ?? null, limit: 50 });
  }

  async feature(id: string): Promise<FeatureDetail | null> {
    const scope = memoryScopeFor(this.teamId);
    const feature = getFeature(id);
    if (!feature || feature.orgId !== scope.orgId) return null;
    const implementations = implementationsOf(scope, id);
    const decisions = searchDecisions(scope, { featureId: id, limit: 50 }).map(toDecisionCard);
    const documents = designDocsOf(scope, id);
    // Built by a team that has a page on it, or a design doc for it.
    const teams = [...new Set([...implementations.map((i) => i.teamId), ...documents.map((d) => d.teamId).filter((t): t is string => !!t)])];
    return {
      own: scope.own,
      feature: toFeatureCard(feature, teams),
      implementations: implementations.map(implementationLine),
      decisions,
      issues: liveIssues(scope, { featureId: id, decisionIds: decisions.map((d) => d.id), limit: 50 }).map(toIssueCard),
      documents: documents.map((d) => toDocumentCard(d, d.interfaces)),
    };
  }
}

