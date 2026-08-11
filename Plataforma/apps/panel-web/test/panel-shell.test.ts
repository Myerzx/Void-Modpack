import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PanelSessionClient, type PanelFetch } from '../lib/panel-session';
import {
  actionView,
  knownActionIds,
  provenance,
  screenStateForStatus,
  screenStateView,
  type PanelSession,
} from '../lib/panel-shell';
import {
  buildAuditView,
  buildDashboardView,
  buildInstanceSelectorView,
  buildOperationsView,
  countInFlightOperations,
  type ServerInstance,
} from '../lib/panel-views';

function session(permissions: readonly string[]): PanelSession {
  return {
    userId: '018f6b8c-76a3-7d10-9f2e-1d9e52a63701',
    displayName: 'Owner fixture',
    permissions: [...permissions],
    csrfToken: 'csrf-token',
  };
}

const owner = session([
  'dashboard.view',
  'server.view',
  'audit.view',
  'mods.view',
  'mods.manage',
  'mods.classify',
  'configuration.view',
  'configuration.apply',
  'configuration.rollback',
  'server.control.start',
  'server.control.stop',
  'console.command',
  'backups.create',
]);

const instance: ServerInstance = {
  id: '018f6b8c-76a3-7d10-9f2e-1d9e52a63702',
  slug: 'voidfall-principal',
  displayName: 'VoidFall Principal',
  environment: 'production',
  minecraftVersion: '1.20.1',
  loader: 'forge',
  loaderVersion: '47.4.4',
  desiredState: 'unknown',
  observedState: 'unknown',
};

describe('screen states', () => {
  it('renders content only when ready', () => {
    assert.equal(screenStateView('ready').showsContent, true);
    for (const state of ['loading', 'empty', 'unavailable', 'denied', 'error'] as const) {
      const view = screenStateView(state);
      assert.equal(view.showsContent, false);
      assert.ok(view.title.length > 0);
      assert.ok(view.detail.length > 0);
    }
  });

  it('never shows a refusal as a failure', () => {
    assert.equal(screenStateForStatus(401), 'denied');
    assert.equal(screenStateForStatus(403), 'denied');
    assert.equal(screenStateForStatus(404), 'empty');
    assert.equal(screenStateForStatus(503), 'unavailable');
    assert.equal(screenStateForStatus(500), 'error');
  });
});

describe('action policy', () => {
  it('hides an action the session has no permission for', () => {
    const readOnly = session(['dashboard.view', 'server.view', 'mods.view']);
    const upload = actionView(readOnly, 'artifact.upload');
    assert.equal(upload.visible, false);
    assert.equal(upload.enabled, false);
  });

  it('keeps a dangerous mutation visible but disabled until its phase lands', () => {
    for (const dangerous of ['backup.create']) {
      const view = actionView(owner, dangerous);
      assert.equal(view.visible, true, `${dangerous} should be visible to an owner`);
      // Permission alone is not enough: the capability does not exist yet.
      assert.equal(view.enabled, false, `${dangerous} must stay disabled`);
      assert.ok(view.reason.length > 0);
    }
  });

  it('enables process control and the console now that the agent serves them', () => {
    for (const landed of ['server.start', 'server.stop', 'console.command']) {
      const view = actionView(owner, landed);
      assert.equal(view.enabled, true, `${landed} should be enabled`);
      assert.equal(view.reason, '');
    }
    // Restart is enabled by policy and this session simply does not hold the
    // permission, so it stays invisible — which is the rule, not an exception:
    // a greyed control tells somebody a capability exists and that they were
    // refused, and they have no use for either fact.
    assert.equal(actionView(owner, 'server.restart').visible, false);
    // The agent claims a durable operation, starts a real Forge server and
    // settles the operation afterwards. Turning these on before the settlement
    // worked would have given the panel a start button and no stop button.
  });

  it('offers artifact installation to a session with the management permission', () => {
    const install = actionView(owner, 'artifact.install');
    assert.equal(install.enabled, true);
    assert.equal(install.reason, '');
  });

  it('enables the actions whose phases already landed', () => {
    for (const ready of [
      'artifact.upload',
      'artifact.decide',
      'configuration.apply',
      'configuration.rollback',
      'artifact.install',
    ]) {
      const view = actionView(owner, ready);
      assert.equal(view.visible, true);
      assert.equal(view.enabled, true);
    }
  });

  it('refuses an action it does not know', () => {
    assert.equal(actionView(owner, 'server.rm-rf').visible, false);
    assert.ok(knownActionIds().length > 0);
  });
});

describe('instance selector', () => {
  it('selects the first real instance and marks it', () => {
    const view = buildInstanceSelectorView({ session: owner, instances: [instance] });
    assert.equal(view.screen.state, 'ready');
    assert.equal(view.selectedId, instance.id);
    assert.equal(view.options[0]?.selected, true);
    assert.equal(view.options[0]?.runtimeLabel, '1.20.1 · forge 47.4.4');
    assert.equal(view.provenance.source, 'control-api');
  });

  it('drops a selection the session can no longer see', () => {
    const view = buildInstanceSelectorView({
      session: owner,
      instances: [instance],
      selectedId: '018f6b8c-76a3-7d10-9f2e-1d9e52a6370f',
    });
    assert.equal(view.selectedId, instance.id);
  });

  it('reports each screen state from the API instead of guessing', () => {
    assert.equal(buildInstanceSelectorView({ session: owner }).screen.state, 'loading');
    assert.equal(
      buildInstanceSelectorView({ session: owner, instances: [] }).screen.state,
      'empty',
    );
    assert.equal(
      buildInstanceSelectorView({ session: owner, status: 503 }).screen.state,
      'unavailable',
    );
    assert.equal(
      buildInstanceSelectorView({ session: session(['mods.view']), instances: [instance] }).screen
        .state,
      'denied',
    );
  });
});

describe('dashboard', () => {
  it('states the source, quality and time of every tile', () => {
    const view = buildDashboardView({
      session: owner,
      instance,
      processState: {
        lifecycle: 'online',
        observedPid: 4242,
        observedAt: '2026-08-05T12:00:00.000Z',
        stale: false,
        observed: true,
      },
      openOperations: 1,
    });

    assert.equal(view.screen.state, 'ready');
    for (const tile of view.tiles) {
      assert.ok(tile.provenance.label.length > 0);
      assert.ok(['control-api', 'agent-observation'].includes(tile.provenance.source));
    }
    const pid = view.tiles.find((tile) => tile.id === 'pid');
    assert.equal(pid?.value, '4242');
    assert.equal(pid?.provenance.observedAt, '2026-08-05T12:00:00.000Z');
    assert.equal(pid?.provenance.quality, 'live');
  });

  it('reports a never-observed process as unknown rather than offline', () => {
    const view = buildDashboardView({ session: owner, instance });
    const process = view.tiles.find((tile) => tile.id === 'process');
    assert.equal(process?.value, 'Desconhecido');
    assert.equal(process?.provenance.quality, 'unknown');
    assert.equal(process?.provenance.observedAt, null);
    // A pid is never shown for something nobody observed.
    assert.equal(view.tiles.find((tile) => tile.id === 'pid'), undefined);
  });

  it('marks a stale observation as stale instead of current', () => {
    const view = buildDashboardView({
      session: owner,
      instance,
      processState: {
        lifecycle: 'unknown',
        observedPid: null,
        observedAt: '2026-08-05T11:00:00.000Z',
        stale: true,
        observed: true,
      },
    });
    assert.equal(view.tiles.find((tile) => tile.id === 'process')?.provenance.quality, 'stale');
  });

  it('names the areas that are still fixtures', () => {
    const view = buildDashboardView({ session: owner, instance });
    assert.ok(view.fixtureAreas.length > 0);
  });

  it('denies the dashboard without its permission', () => {
    assert.equal(
      buildDashboardView({ session: session(['server.view']), instance }).screen.state,
      'denied',
    );
  });
});

describe('operations page', () => {
  it('does not label historical operations as in flight', () => {
    assert.equal(
      countInFlightOperations({
        total: 12,
        operations: [
          {
            operationId: 'operation-1',
            kind: 'server.start',
            status: 'succeeded',
            acceptedAt: '2026-08-09T12:00:00.000Z',
            correlationId: 'correlation-1',
            receipt: { outcome: 'succeeded', failureCode: null },
          },
        ],
      }),
      0,
    );
  });

  const operation = {
    operationId: '018f6b8c-76a3-7d10-9f2e-1d9e52a63703',
    kind: 'server.start',
    status: 'succeeded',
    acceptedAt: '2026-08-05T12:00:00.000Z',
    correlationId: '018f6b8c-76a3-7d10-9f2e-1d9e52a63704',
    receipt: { outcome: 'succeeded', failureCode: null },
  };

  it('shows the receipt outcome and the correlation that ties it together', () => {
    const view = buildOperationsView({
      session: owner,
      page: { operations: [operation], total: 1 },
    });
    assert.equal(view.screen.state, 'ready');
    assert.equal(view.rows[0]?.receiptOutcome, 'succeeded');
    assert.equal(view.rows[0]?.correlationId, operation.correlationId);
  });

  it('reports an in-flight operation as having no receipt yet', () => {
    const view = buildOperationsView({
      session: owner,
      page: { operations: [{ ...operation, status: 'accepted', receipt: null }], total: 1 },
    });
    assert.equal(view.rows[0]?.receiptOutcome, null);
  });

  it('distinguishes empty, loading and denied', () => {
    assert.equal(
      buildOperationsView({ session: owner, page: { operations: [], total: 0 } }).screen.state,
      'empty',
    );
    assert.equal(buildOperationsView({ session: owner }).screen.state, 'loading');
    assert.equal(
      buildOperationsView({ session: session(['mods.view']) }).screen.state,
      'denied',
    );
  });
});

describe('audit page', () => {
  const event = {
    id: '018f6b8c-76a3-7d10-9f2e-1d9e52a63705',
    occurredAt: '2026-08-05T12:00:00.000Z',
    action: 'agent.work.claim',
    outcome: 'succeeded',
    actor: { type: 'agent', id: '018f6b8c-76a3-7d10-9f2e-1d9e52a63706' },
    correlationId: '018f6b8c-76a3-7d10-9f2e-1d9e52a63707',
  };

  it('shows the actor by kind and a short identifier only', () => {
    const view = buildAuditView({
      session: owner,
      page: { events: [event], total: 1, limit: 50, offset: 0 },
    });
    assert.equal(view.screen.state, 'ready');
    assert.equal(view.rows[0]?.actorLabel, 'agent:018f6b8c');
    // The full identifier is not rendered.
    assert.equal(view.rows[0]?.actorLabel.includes(event.actor.id), false);
  });

  it('keeps the audit page behind its own permission', () => {
    assert.equal(
      buildAuditView({ session: session(['dashboard.view', 'server.view']) }).screen.state,
      'denied',
    );
  });

  it('carries the paging bounds through', () => {
    const view = buildAuditView({
      session: owner,
      page: { events: [event], total: 120, limit: 50, offset: 50 },
    });
    assert.equal(view.total, 120);
    assert.equal(view.offset, 50);
  });
});

describe('panel session', () => {
  function client(script: readonly { status: number; body?: unknown }[]): {
    readonly client: PanelSessionClient;
    readonly calls: string[];
  } {
    const calls: string[] = [];
    let index = 0;
    const fetchImplementation: PanelFetch = async (path) => {
      calls.push(path);
      const step = script[Math.min(index, script.length - 1)] ?? { status: 500 };
      index += 1;
      return {
        ok: step.status < 400,
        status: step.status,
        json: async () => step.body ?? {},
      };
    };
    return { client: new PanelSessionClient(fetchImplementation), calls };
  }

  const body = {
    csrfToken: 'csrf-token',
    user: { id: '018f6b8c-76a3-7d10-9f2e-1d9e52a63701', displayName: 'Owner' },
    permissions: ['dashboard.view'],
  };

  it('signs in and carries the permissions the API reported', async () => {
    const harness = client([{ status: 200, body }]);
    const outcome = await harness.client.signIn('owner@voidfall.invalid', 'password');
    assert.equal(outcome.kind, 'authenticated');
    assert.equal(
      outcome.kind === 'authenticated' ? outcome.session.permissions[0] : undefined,
      'dashboard.view',
    );
    assert.deepEqual(harness.calls, ['/api/v1/auth/login']);
  });

  it('tells a wrong password apart from a lockout and from a failure', async () => {
    assert.equal((await client([{ status: 401 }]).client.signIn('a@b.invalid', 'x')).kind, 'unauthenticated');
    assert.equal((await client([{ status: 429 }]).client.signIn('a@b.invalid', 'x')).kind, 'locked-out');
    assert.equal((await client([{ status: 500 }]).client.signIn('a@b.invalid', 'x')).kind, 'error');
  });

  it('treats a malformed session payload as an error rather than trusting it', async () => {
    const outcome = await client([{ status: 200, body: { csrfToken: 'x' } }]).client.signIn(
      'a@b.invalid',
      'x',
    );
    assert.equal(outcome.kind, 'error');
  });

  it('restores a session on reload without signing in again', async () => {
    const harness = client([{ status: 200, body }]);
    const outcome = await harness.client.current();
    assert.equal(outcome.kind, 'authenticated');
    assert.deepEqual(harness.calls, ['/api/v1/auth/session']);
  });

  it('signs out with the csrf token and tolerates a refusal', async () => {
    const harness = client([{ status: 500 }]);
    await harness.client.signOut({
      userId: 'u',
      displayName: 'Owner',
      permissions: [],
      csrfToken: 'csrf-token',
    });
    assert.deepEqual(harness.calls, ['/api/v1/auth/logout']);
  });
});

describe('provenance', () => {
  it('labels a fixture as a fixture', () => {
    const demo = provenance({ source: 'demo-fixture', quality: 'demo' });
    assert.match(demo.label, /Fixture/u);
    assert.equal(demo.observedAt, null);
  });
});
