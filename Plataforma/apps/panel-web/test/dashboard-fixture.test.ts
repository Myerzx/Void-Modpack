import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dashboardFixture } from '../lib/dashboard-fixture';

describe('read-only dashboard fixture', () => {
  it('marks every displayed metric as local demo data', () => {
    assert.equal(dashboardFixture.dataMode, 'demo-fixture');
    assert.equal(dashboardFixture.metrics.length > 0, true);
    assert.equal(dashboardFixture.metrics.every((metric) => metric.source === 'fixture-local'), true);
    assert.match(dashboardFixture.instance.environment, /demonstração/u);
  });

  it('does not claim a real desired or observed server state', () => {
    assert.equal(dashboardFixture.instance.desiredState, 'Não definido');
    assert.equal(dashboardFixture.instance.observedState, 'Sem agente real');
  });
});
