const test = require('node:test');
const assert = require('node:assert/strict');
const { canTransition, getRequiredRole } = require('../shared/tripState');

test('allows only legal trip transitions', () => {
  assert.equal(canTransition('REQUESTED', 'ACCEPTED'), true);
  assert.equal(canTransition('ACCEPTED', 'STARTED'), true);
  assert.equal(canTransition('STARTED', 'ENDED'), true);
  assert.equal(canTransition('REQUESTED', 'CANCELED'), true);
  assert.equal(canTransition('REQUESTED', 'ENDED'), false);
  assert.equal(canTransition('ACCEPTED', 'ACCEPTED'), false);
  assert.equal(canTransition('STARTED', 'PENDING_FARE'), true);
});

test('requires driver role for driver-only transitions', () => {
  assert.equal(getRequiredRole('REQUESTED', 'ACCEPTED'), 'driver');
  assert.equal(getRequiredRole('ACCEPTED', 'STARTED'), 'driver');
  assert.equal(getRequiredRole('STARTED', 'ENDED'), 'either');
  assert.equal(getRequiredRole('REQUESTED', 'CANCELED'), 'either');
});
