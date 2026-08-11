import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isAllowedDesktopNavigation,
  parseDesktopBackendMessage,
} from '../src/backend-protocol.js';

describe('desktop backend protocol', () => {
  it('accepts only a coherent loopback readiness message', () => {
    assert.deepEqual(parseDesktopBackendMessage({ type: 'stopped' }), { type: 'stopped' });
    assert.deepEqual(
      parseDesktopBackendMessage({
        type: 'ready',
        baseUrl: 'http://127.0.0.1:43123',
        launchUrl: 'http://127.0.0.1:43123/local/session?token=opaque',
        port: 43123,
      }),
      {
        type: 'ready',
        baseUrl: 'http://127.0.0.1:43123',
        launchUrl: 'http://127.0.0.1:43123/local/session?token=opaque',
        port: 43123,
      },
    );
    assert.equal(
      parseDesktopBackendMessage({
        type: 'ready',
        baseUrl: 'http://0.0.0.0:43123',
        launchUrl: 'http://0.0.0.0:43123/',
        port: 43123,
      }),
      null,
    );
    assert.equal(
      parseDesktopBackendMessage({
        type: 'ready',
        baseUrl: 'http://127.0.0.1:43123',
        launchUrl: 'https://example.com/',
        port: 43123,
      }),
      null,
    );
  });

  it('keeps every navigation on the exact control-plane origin', () => {
    const baseUrl = 'http://127.0.0.1:43123';
    assert.equal(isAllowedDesktopNavigation(`${baseUrl}/workspaces`, baseUrl), true);
    assert.equal(isAllowedDesktopNavigation(`${baseUrl}/api/v1/auth/session`, baseUrl), true);
    assert.equal(isAllowedDesktopNavigation('http://127.0.0.1:43124/workspaces', baseUrl), false);
    assert.equal(isAllowedDesktopNavigation('https://example.com/', baseUrl), false);
    assert.equal(isAllowedDesktopNavigation('file:///C:/Windows/System32/drivers/etc/hosts', baseUrl), false);
  });
});
