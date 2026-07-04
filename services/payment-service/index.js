const { query, eventBus } = require('../../shared');

const STREAM_NAME = 'trip_events';
const GROUP_NAME = 'payment_service_group';
const CONSUMER_NAME = `payment_worker_${process.pid}`;

async function processPayment(event) {
  if (event.eventType === 'TRIP_ENDED') {
    const trip = event.payload;
    const { tripId, riderId, fare } = trip;

    try {
      console.log(`[Payment Service] Processing payment for Trip: ${tripId}`);

      const paymentStatus = fare ? 'succeeded' : 'failed';
      await query(`
        INSERT INTO payments (trip_id, rider_id, amount, status, created_at)
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      `, [tripId, riderId, fare || 0, paymentStatus]);

      if (paymentStatus === 'succeeded') {
        console.log(`[Payment Service] Charging Rider: ${riderId} amount: $${fare}`);
        console.log(`[Payment Service] Payment successful for Trip: ${tripId}. Amount: $${fare}`);
        await eventBus.publish('trip_events', 'PAYMENT_SUCCEEDED', { tripId, riderId, amount: fare });
      } else {
        await query(`
          INSERT INTO failed_events (event_type, payload, error_message, created_at)
          VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
        `, ['TRIP_ENDED', trip, 'Missing fare for payment']);
        await eventBus.publish('trip_events', 'PAYMENT_FAILED', { tripId, riderId, reason: 'Missing fare' });
      }
    } catch (error) {
      await query(`
        INSERT INTO failed_events (event_type, payload, error_message, created_at)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
      `, ['TRIP_ENDED', trip, error.message]);
      console.error(`[Payment Service] Failed to process payment for ${tripId}`, error.message);
    }
  }
}

async function start() {
  console.log('Payment Service Booting...');
  
  // Wait a bit to ensure Redis is fully up before creating groups
  setTimeout(() => {
    eventBus.consume(STREAM_NAME, GROUP_NAME, CONSUMER_NAME, processPayment);
  }, 2000);
}

start();
