import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { inferForm } from '@voidfall/configuration-inference';

import {
  MINE_AND_SLASH_MOD_ID,
  adapterForPath,
  createMineAndSlashAdapter,
  registeredAdapterModIds,
} from '../src/index.js';

/**
 * The Mine and Slash adapter, against field names taken from the real file.
 *
 * The property under test: an adapter groups, it does not interpret. Every
 * bound still comes from what the mod declared, and a field no rule claimed is
 * shown rather than hidden.
 */

/** A cut of the real `mine_and_slash-server.toml`, comments and all. */
const REAL_SHAPE = `
#General Configs
[general]
	GET_STARTER_ITEMS = true
	loot_announcements = true
	#Chance for a map to drop.
	#Range: 0.0 ~ 100.0
	map_droprate = 1.5
	gear_drop_rate = 100.0
	prophecy_gear_rarity = 1.0
	exp_gain_multi = 1.0
	death_exp_penalty = 0.1
	mob_level_variance = 2
	extra_mob_stats_per_lvl = 1.0
	party_exp_bonus = 0.1
	max_team_distance = 100
	max_characters = 3
	log_errors = true
	mob_death_messages = false
	favor_chest_gain = 1.0
	block_cost = 1.0
	map_gen_terrain_radius = 100
	lvl_distance_loot_penalty_per_level = 0.05
	stat_order_test = false
`;

const form = inferForm({ format: 'toml', content: REAL_SHAPE });
const adapter = createMineAndSlashAdapter();

function categoryOf(path: string): string | undefined {
  const result = adapter.categorise(form);
  return result.fields.find((entry) => entry.field.path === path)?.categoryId;
}

describe('the Mine and Slash adapter', () => {
  it('owns its file wherever the level directory happens to be named', () => {
    // The level is whatever the operator called it, and a sandbox renames it
    // again, so the match is by suffix.
    assert.equal(
      adapterForPath('world/serverconfig/mine_and_slash-server.toml')?.modId,
      MINE_AND_SLASH_MOD_ID,
    );
    assert.equal(
      adapterForPath('voidfall-sandbox-world/serverconfig/mine_and_slash-server.toml')?.modId,
      MINE_AND_SLASH_MOD_ID,
    );
    // And it does not claim a file belonging to somebody else.
    assert.equal(adapterForPath('world/serverconfig/curios-server.toml'), undefined);
  });

  it('groups settings the way their names actually fall', () => {
    assert.equal(categoryOf('general.map_droprate'), 'loot');
    assert.equal(categoryOf('general.gear_drop_rate'), 'loot');
    assert.equal(categoryOf('general.exp_gain_multi'), 'experience');
    assert.equal(categoryOf('general.mob_level_variance'), 'mobs');
    assert.equal(categoryOf('general.party_exp_bonus'), 'party');
    assert.equal(categoryOf('general.max_team_distance'), 'party');
    assert.equal(categoryOf('general.max_characters'), 'characters');
    // A setting that controls whether something is printed goes with the other
    // output toggles, whatever its subject is.
    assert.equal(categoryOf('general.mob_death_messages'), 'messages');
    assert.equal(categoryOf('general.loot_announcements'), 'messages');
    assert.equal(categoryOf('general.map_gen_terrain_radius'), 'maps');
  });

  it('resolves an overlapping name by rule order, not by guesswork', () => {
    // `lvl_distance_loot_penalty_per_level` contains loot, lvl and level. It is
    // a loot setting, and the loot rules come first — first match rather than
    // best match, so the outcome is predictable from reading the rules.
    assert.equal(categoryOf('general.lvl_distance_loot_penalty_per_level'), 'loot');
    // `prophecy_gear_rarity` contains gear and rarity, and both point the same
    // way; `favor_chest_gain` contains chest, which is loot.
    assert.equal(categoryOf('general.prophecy_gear_rarity'), 'rarity');
    assert.equal(categoryOf('general.favor_chest_gain'), 'loot');
  });

  it('shows a setting no rule claimed instead of hiding it', () => {
    const result = adapter.categorise(form);
    const shown = new Set([
      ...result.fields.map((entry) => entry.field.path),
      ...result.uncategorised.map((field) => field.path),
    ]);
    // Every field survives categorisation. A mod adding a setting the rules do
    // not recognise must not make it disappear from the editor.
    assert.equal(shown.size, form.fields.length);
    assert.ok(result.uncategorised.every((field) => !shown.has('') && field.path.length > 0));
  });

  it('names the rule that placed each field', () => {
    const placed = adapter.categorise(form).fields.find(
      (entry) => entry.field.path === 'general.map_droprate',
    );
    // So a misplacement is traceable to a line rather than to "the categoriser".
    assert.equal(placed?.matchedBy, 'loot.rates');
  });

  it('adds no bound the mod did not declare', () => {
    const result = adapter.categorise(form);
    const droprate = result.fields.find((entry) => entry.field.path === 'general.map_droprate');
    // Read from the file's own comment, unchanged by the adapter.
    assert.deepEqual(droprate?.field.constraints, [
      { kind: 'range', minimum: 0, maximum: 100, source: 'declared' },
    ]);
    // And a field the mod said nothing about still carries nothing.
    const starter = result.fields.find(
      (entry) => entry.field.path === 'general.GET_STARTER_ITEMS',
    );
    assert.deepEqual(starter?.field.constraints ?? [], []);
  });

  it('offers no category it cannot fill', () => {
    const result = adapter.categorise(form);
    // An empty tab is a promise the configuration did not keep. There is no
    // spells or talents category because this file holds no such settings.
    assert.ok(
      result.categories.every((category) =>
        result.fields.some((entry) => entry.categoryId === category.id),
      ),
    );
    assert.ok(!result.categories.some((category) => category.id === 'spells'));
  });

  it('registers exactly the mods somebody has actually reviewed', () => {
    // Closed on purpose: an adapter asserts a person looked at a real file.
    assert.deepEqual([...registeredAdapterModIds()], [MINE_AND_SLASH_MOD_ID]);
  });
});
