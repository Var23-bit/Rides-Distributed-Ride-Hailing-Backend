const { query, eventBus } = require('../../shared');

const STREAM_NAME = 'trip_events';
const GROUP_NAME = 'history_service_group';
const CONSUMER_NAME = `history_worker_${process.pid}`;

async function processEvent(event) {
  const { eventType, payload } = event;
  const tripId = payload.tripId || null;

  try {
    console.log(`[History Service] Logging Event: ${eventType} for Trip: ${tripId}`);

    const sql = `
      INSERT INTO events_log (trip_id, event_type, payload)
      VALUES ($1, $2, $3)
    `;
    await query(sql, [tripId, eventType, payload]);
  } catch (err) {
    console.error(`[History Service] Failed to log event ${eventType}`, err);
    await query(`
      INSERT INTO failed_events (event_type, payload, error_message, created_at)
      VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
    `, [eventType, payload, err.message]);
  }
}

async function start() {
  console.log('History Service Booting...');
  
  // Wait a bit to ensure Redis is fully up before creating groups
  setTimeout(() => {
    eventBus.consume(STREAM_NAME, GROUP_NAME, CONSUMER_NAME, processEvent);
  }, 2500);
}

start();
