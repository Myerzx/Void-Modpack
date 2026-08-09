import type { AnalysisConfidence, KnowledgeStatus } from './types.js';

export interface SystemClassification {
  readonly slug: string;
  readonly title: string;
  readonly ruleId: string;
  readonly status: KnowledgeStatus;
  readonly confidence: AnalysisConfidence;
}

interface SystemRule {
  readonly slug: string;
  readonly title: string;
  readonly signals: readonly string[];
}

/**
 * Generic functional vocabulary used for presentation.
 *
 * These rules classify words already present in a field path, author comment
 * or registry path. They do not claim behaviour and never change a value. The
 * matching rule is persisted as evidence so a wrong placement can be reviewed
 * and corrected without pretending it came from the mod itself.
 */
const SYSTEM_RULES: readonly SystemRule[] = Object.freeze([
  {
    slug: 'messages-observability',
    title: 'Messages and diagnostics',
    signals: ['message', 'announcement', 'log_', 'error_spam'],
  },
  {
    slug: 'compatibility',
    title: 'Compatibility',
    signals: ['compat', 'integration', 'preset'],
  },
  { slug: 'party', title: 'Party and teams', signals: ['party', 'team'] },
  {
    slug: 'loot',
    title: 'Loot and drops',
    signals: ['drop_rate', 'droprate', 'drop_chance', 'loot', 'chest', 'drop_bonus'],
  },
  {
    slug: 'spells',
    title: 'Spells and mana',
    signals: ['spell', 'mana', 'aura', 'support_gem', 'skill_gem'],
  },
  {
    slug: 'skills',
    title: 'Skills and professions',
    signals: ['skill', 'talent', 'perk', 'profession'],
  },
  {
    slug: 'stats',
    title: 'Stats and attributes',
    signals: ['stat', 'attribute', 'resist', 'base_stats', 'value_calc'],
  },
  {
    slug: 'combat',
    title: 'Combat and survival',
    signals: [
      'combat',
      'damage',
      'dmg',
      'attack',
      'pvp',
      'cooldown',
      'regen',
      'energy',
      'health',
      'weapon',
      'offhand',
      'block_cost',
    ],
  },
  {
    slug: 'mobs',
    title: 'Mobs and entities',
    signals: ['mob', 'entity', 'summon', 'slime'],
  },
  {
    slug: 'worldgen',
    title: 'World generation',
    signals: ['worldgen', 'biome', 'dimension', 'structure', 'terrain'],
  },
  {
    slug: 'maps-dungeons',
    title: 'Maps and dungeons',
    signals: ['map_', '_map', 'dungeon', 'arena', 'prophecy', 'omen'],
  },
  {
    slug: 'gear',
    title: 'Gear and rarity',
    signals: ['gear', 'rarity', 'affix', 'rune', 'jewel', 'currency', 'soul'],
  },
  {
    slug: 'progression',
    title: 'Progression and levels',
    signals: ['experience', 'exp_', '_exp', 'rested_xp', 'level', 'lvl', 'character', 'favor'],
  },
  {
    slug: 'items',
    title: 'Items',
    signals: ['item', 'recipe', 'blacklist'],
  },
]);

function normalized(input: {
  readonly path?: string;
  readonly documentation?: readonly string[];
  readonly resourceType?: string;
}): string {
  return [input.path ?? '', input.resourceType ?? '', ...(input.documentation ?? [])]
    .join(' ')
    .normalize('NFKD')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9_]+/gu, '_');
}

export function classifySystem(input: {
  readonly path?: string;
  readonly documentation?: readonly string[];
  readonly resourceType?: string;
}): SystemClassification {
  const haystack = normalized(input);
  for (const rule of SYSTEM_RULES) {
    const signal = rule.signals.find((candidate) => haystack.includes(candidate));
    if (signal === undefined) continue;
    return Object.freeze({
      slug: rule.slug,
      title: rule.title,
      ruleId: `semantic-token:${rule.slug}:${signal}`,
      status: 'interpreted',
      confidence: input.resourceType === undefined ? 'medium' : 'high',
    });
  }
  return Object.freeze({
    slug: 'general',
    title: 'General',
    ruleId: 'semantic-token:unmatched',
    status: 'unknown',
    confidence: 'unknown',
  });
}

export function knownSystemSlugs(): readonly string[] {
  return Object.freeze([...SYSTEM_RULES.map((rule) => rule.slug), 'general']);
}
