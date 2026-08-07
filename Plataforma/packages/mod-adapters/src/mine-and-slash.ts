import type { InferredForm } from '@voidfall/configuration-inference';

import {
  categoriseByRules,
  type CategoryDefinition,
  type CategoryRule,
  type CategorisedForm,
  type ModConfigurationAdapter,
} from './types.js';

/**
 * Mine and Slash — the first mod with an adapter.
 *
 * Its server configuration is 83 settings in a single `[general]` table, so
 * there is no section structure to group by and the rules below go by name.
 * Every pattern here was read off the real file rather than guessed from what
 * an RPG mod might plausibly have.
 *
 * The categories are the ones the settings actually fall into. There is no
 * "spells" or "talents" category because this file has no spell or talent
 * settings in it — those live in the mod's own data, not here, and offering an
 * empty tab would promise an editor that does not exist.
 */

export const MINE_AND_SLASH_MOD_ID = 'mine_and_slash';

/** Where the mod keeps it: per-world, under the level directory. */
const CONFIG_SUFFIX = '/serverconfig/mine_and_slash-server.toml';

const CATEGORIES: readonly CategoryDefinition[] = Object.freeze([
  { id: 'loot', title: 'Loot and drop rates' },
  { id: 'rarity', title: 'Rarity and gear' },
  { id: 'experience', title: 'Experience and levelling' },
  { id: 'mobs', title: 'Mobs' },
  { id: 'maps', title: 'Maps and dungeons' },
  { id: 'party', title: 'Party and teams' },
  { id: 'characters', title: 'Characters and progression' },
  { id: 'messages', title: 'Messages and logging' },
  { id: 'balance', title: 'Balance' },
]);

/**
 * Ordered, and the order matters where names overlap.
 *
 * Three real collisions from this file decided the order.
 * `lvl_distance_loot_penalty_per_level` holds `loot`, `lvl` and `level`, and is
 * a loot setting; `party_exp_bonus` holds both `party` and `exp`, and belongs
 * where somebody tuning party play would look; and `mob_death_messages` holds
 * both `mob` and `messages`, and belongs with the other output toggles. The
 * more specific signal wins, and a suffix describing behaviour beats a prefix
 * describing subject. Each rule is named so a
 * misplacement can be traced to the line that caused it rather than to "the
 * categoriser".
 */
const RULES: readonly CategoryRule[] = Object.freeze([
  {
    // First of all, because a setting that controls *whether something is
    // printed* belongs with the other output toggles whatever its subject is.
    // `mob_death_messages` is not a mob setting to anybody trying to quieten
    // their chat, and `loot_announcements` is not a loot setting to them either.
    id: 'messages.output',
    categoryId: 'messages',
    matches: (name) =>
      name.endsWith('_messages') || name.includes('announcement') || name.includes('log_'),
  },
  {
    // First, because `party_` is the more specific noun: these settings only
    // apply inside a party at all. `party_exp_bonus` would otherwise land under
    // experience, where somebody tuning party play would never look for it.
    id: 'party.grouping',
    categoryId: 'party',
    matches: (name) => name.startsWith('party_') || name.includes('team'),
  },
  {
    id: 'loot.rates',
    categoryId: 'loot',
    matches: (name) =>
      name.includes('drop_rate') ||
      name.includes('droprate') ||
      name.startsWith('loot_') ||
      name.includes('_loot_') ||
      name.endsWith('_loot') ||
      name.includes('loot_chance') ||
      name.includes('chest'),
  },
  {
    id: 'rarity.gear',
    categoryId: 'rarity',
    matches: (name) => name.includes('rarity') || name.includes('gear'),
  },
  {
    id: 'experience.gain',
    categoryId: 'experience',
    matches: (name) => name.includes('exp_') || name.includes('_exp') || name.includes('rested_xp'),
  },
  {
    id: 'maps.generation',
    categoryId: 'maps',
    matches: (name) => name.startsWith('map_') || name.includes('_map') || name.includes('arena'),
  },
  {
    id: 'mobs.behaviour',
    categoryId: 'mobs',
    matches: (name) =>
      name.includes('mob') || name.includes('summon') || name.includes('slime'),
  },
  {
    id: 'characters.progression',
    categoryId: 'characters',
    matches: (name) =>
      name.includes('character') || name.includes('level') || name.includes('lvl'),
  },
  {
    id: 'balance.remainder',
    categoryId: 'balance',
    matches: (name) =>
      name.includes('favor') ||
      name.includes('currency') ||
      name.includes('regen') ||
      name.includes('cost') ||
      name.includes('stat') ||
      name.includes('damage'),
  },
]);

export function createMineAndSlashAdapter(): ModConfigurationAdapter {
  return {
    modId: MINE_AND_SLASH_MOD_ID,
    appliesTo(path: string): boolean {
      // Matched by suffix because the level directory is whatever the operator
      // named it, and a sandbox renames it again.
      return path.toLocaleLowerCase('en-US').endsWith(CONFIG_SUFFIX);
    },
    categorise(form: InferredForm): CategorisedForm {
      return categoriseByRules({
        modId: MINE_AND_SLASH_MOD_ID,
        form,
        categories: CATEGORIES,
        rules: RULES,
      });
    },
  };
}
