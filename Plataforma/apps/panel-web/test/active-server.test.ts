import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { chooseActiveServerId } from '../lib/active-server';

describe('active ServerInstance selection', () => {
  const servers = [{ id: 'server-a' }, { id: 'server-b' }];

  it('keeps a valid explicit preference', () => {
    assert.equal(chooseActiveServerId(servers, 'server-b'), 'server-b');
  });

  it('falls back to the first API result when the preference is stale', () => {
    assert.equal(chooseActiveServerId(servers, 'deleted-server'), 'server-a');
    assert.equal(chooseActiveServerId([], 'server-a'), null);
  });
});
