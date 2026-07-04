const test = require('node:test');
const assert = require('node:assert/strict');

const { eventBus } = require('../shared');

test('eventBus.publish does not throw when Redis is unavailable', async () => {
  await assert.doesNotReject(() => eventBus.publish('trip_events', 'TRIP_REQUESTED', { tripId: 'trip-1' }));
});
