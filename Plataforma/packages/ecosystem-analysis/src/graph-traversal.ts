import type {
  EcosystemAnalysis,
  EcosystemEntityType,
  EcosystemGraphEntity,
  EcosystemRelationship,
  EcosystemRelationshipType,
} from './types.js';

export const ECOSYSTEM_GRAPH_MAX_DEPTH = 3;
export const ECOSYSTEM_GRAPH_MAX_ENTITIES = 250;
export const ECOSYSTEM_GRAPH_MAX_RELATIONSHIPS = 500;

export const STRUCTURAL_ECOSYSTEM_RELATIONSHIPS = new Set<EcosystemRelationshipType>([
  'OWNS',
  'DEFINED_IN',
  'USES',
  'PROVEN_BY',
  'PARTICIPATES_IN',
]);

export type EcosystemGraphDirection = 'incoming' | 'outgoing' | 'both';

export interface EcosystemGraphTraversalOptions {
  readonly root: { readonly type: EcosystemEntityType; readonly id: string };
  readonly direction?: EcosystemGraphDirection;
  readonly maxDepth?: number;
  readonly maxEntities?: number;
  readonly maxRelationships?: number;
  /** Structural relationships are excluded by default because they dominate real snapshots. */
  readonly includeStructural?: boolean;
  /** An explicit relationship type takes precedence over `includeStructural`. */
  readonly relationshipType?: EcosystemRelationshipType;
  /** The root is always included; this filter applies to adjacent entities. */
  readonly entityType?: EcosystemEntityType;
}

export interface EcosystemGraphTraversalEntity extends EcosystemGraphEntity {
  readonly depth: number;
}

export interface EcosystemGraphUnresolvedReference {
  readonly type: EcosystemEntityType;
  readonly id: string;
  readonly relationshipIds: readonly string[];
}

export interface EcosystemGraphTraversal {
  readonly root: EcosystemGraphTraversalEntity;
  readonly direction: EcosystemGraphDirection;
  readonly maxDepth: number;
  readonly maxEntities: number;
  readonly maxRelationships: number;
  readonly includeStructural: boolean;
  readonly relationshipType: EcosystemRelationshipType | null;
  readonly entityType: EcosystemEntityType | null;
  readonly depthReached: number;
  readonly entities: readonly EcosystemGraphTraversalEntity[];
  readonly relationships: readonly EcosystemRelationship[];
  readonly unresolvedReferences: readonly EcosystemGraphUnresolvedReference[];
  readonly truncated: {
    readonly entities: boolean;
    readonly relationships: boolean;
  };
}

type TraversableAnalysis = Pick<EcosystemAnalysis, 'graph' | 'relationships'>;

function entityKey(reference: { readonly type: EcosystemEntityType; readonly id: string }): string {
  return `${reference.type}\u0000${reference.id}`;
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.trunc(value)));
}

function compare(left: string, right: string): number {
  return left.localeCompare(right, 'en-US');
}

/**
 * Builds a deterministic, bounded projection of a persisted ecosystem graph.
 *
 * Relationships may legitimately point to a mod or resource that was declared
 * but not present in the analyzed inventory. Those endpoints stay explicit in
 * `unresolvedReferences`; the traversal never manufactures placeholder nodes.
 */
export function traverseEcosystemGraph(
  analysis: TraversableAnalysis,
  options: EcosystemGraphTraversalOptions,
): EcosystemGraphTraversal | null {
  const direction = options.direction ?? 'both';
  const maxDepth = boundedInteger(options.maxDepth, 1, ECOSYSTEM_GRAPH_MAX_DEPTH);
  const maxEntities = boundedInteger(options.maxEntities, 75, ECOSYSTEM_GRAPH_MAX_ENTITIES);
  const maxRelationships = boundedInteger(
    options.maxRelationships,
    150,
    ECOSYSTEM_GRAPH_MAX_RELATIONSHIPS,
  );
  const includeStructural = options.includeStructural ?? false;
  const entityByKey = new Map(
    analysis.graph.entities.map((entity) => [entityKey(entity), entity] as const),
  );
  const rootEntity = entityByKey.get(entityKey(options.root));
  if (rootEntity === undefined) return null;

  const graphRelationshipIds = new Set(analysis.graph.relationshipIds);
  const relationships = analysis.relationships
    .filter((relationship) => graphRelationshipIds.has(relationship.relationshipId))
    .filter((relationship) => {
      if (options.relationshipType !== undefined) {
        return relationship.type === options.relationshipType;
      }
      return includeStructural || !STRUCTURAL_ECOSYSTEM_RELATIONSHIPS.has(relationship.type);
    })
    .sort((left, right) => compare(left.relationshipId, right.relationshipId));

  const adjacency = new Map<string, EcosystemRelationship[]>();
  const addAdjacent = (key: string, relationship: EcosystemRelationship): void => {
    const entries = adjacency.get(key) ?? [];
    entries.push(relationship);
    adjacency.set(key, entries);
  };
  for (const relationship of relationships) {
    if (direction !== 'incoming') addAdjacent(entityKey(relationship.from), relationship);
    if (direction !== 'outgoing') addAdjacent(entityKey(relationship.to), relationship);
  }

  const root: EcosystemGraphTraversalEntity = { ...rootEntity, depth: 0 };
  const selectedEntities = new Map<string, EcosystemGraphTraversalEntity>([
    [entityKey(root), root],
  ]);
  const selectedRelationships = new Map<string, EcosystemRelationship>();
  const unresolved = new Map<string, {
    readonly reference: { readonly type: EcosystemEntityType; readonly id: string };
    readonly relationshipIds: Set<string>;
  }>();
  const queue: EcosystemGraphTraversalEntity[] = [root];
  let truncatedEntities = false;
  let truncatedRelationships = false;

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (current === undefined || current.depth >= maxDepth) continue;
    for (const relationship of adjacency.get(entityKey(current)) ?? []) {
      const currentIsFrom = entityKey(relationship.from) === entityKey(current);
      const neighbor = currentIsFrom ? relationship.to : relationship.from;
      if (options.entityType !== undefined && neighbor.type !== options.entityType) continue;

      if (
        !selectedRelationships.has(relationship.relationshipId) &&
        selectedRelationships.size >= maxRelationships
      ) {
        truncatedRelationships = true;
        continue;
      }

      const neighborKey = entityKey(neighbor);
      const neighborEntity = entityByKey.get(neighborKey);
      if (
        neighborEntity !== undefined &&
        !selectedEntities.has(neighborKey) &&
        selectedEntities.size >= maxEntities
      ) {
        truncatedEntities = true;
        continue;
      }

      selectedRelationships.set(relationship.relationshipId, relationship);
      if (neighborEntity === undefined) {
        const missing = unresolved.get(neighborKey) ?? {
          reference: neighbor,
          relationshipIds: new Set<string>(),
        };
        missing.relationshipIds.add(relationship.relationshipId);
        unresolved.set(neighborKey, missing);
        continue;
      }
      if (!selectedEntities.has(neighborKey)) {
        const discovered = { ...neighborEntity, depth: current.depth + 1 };
        selectedEntities.set(neighborKey, discovered);
        queue.push(discovered);
      }
    }
  }

  const entities = [...selectedEntities.values()].sort(
    (left, right) => left.depth - right.depth || compare(entityKey(left), entityKey(right)),
  );
  const relationshipList = [...selectedRelationships.values()].sort((left, right) =>
    compare(left.relationshipId, right.relationshipId),
  );
  const unresolvedReferences = [...unresolved.values()]
    .map(({ reference, relationshipIds }) => ({
      ...reference,
      relationshipIds: [...relationshipIds].sort(compare),
    }))
    .sort((left, right) => compare(entityKey(left), entityKey(right)));

  return {
    root,
    direction,
    maxDepth,
    maxEntities,
    maxRelationships,
    includeStructural,
    relationshipType: options.relationshipType ?? null,
    entityType: options.entityType ?? null,
    depthReached: entities.reduce((maximum, entity) => Math.max(maximum, entity.depth), 0),
    entities,
    relationships: relationshipList,
    unresolvedReferences,
    truncated: {
      entities: truncatedEntities,
      relationships: truncatedRelationships,
    },
  };
}
