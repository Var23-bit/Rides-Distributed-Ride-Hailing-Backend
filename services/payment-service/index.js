const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { z } = require('zod');
const { query, eventBus } = require('../../shared');
const { verifyAccessToken } = require('../../shared/auth');
const logger = require('../../shared/logger');

const app = express();
app.use(cors());
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  },
}));

const PORT = process.env.PORT || 3008;
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  logger.warn('RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET not set - payment creation will fail');
}

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
});

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Missing access token' });
  }
  try {
    req.user = verifyAccessToken(token);
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid access token' });
  }
}

async function createOrderForTrip({ tripId, riderId, fare }) {
  const amountPaise = Math.round(Number(fare) * 100);

  const order = await razorpay.orders.create({
    amount: amountPaise,
    currency: 'INR',
    receipt: tripId,
    notes: { tripId, riderId },
  });

  await query(`
    INSERT INTO payments (trip_id, rider_id, amount, status, razorpay_order_id, created_at, updated_at)
    VALUES ($1, $2, $3, 'created', $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT (trip_id) DO NOTHING
  `, [tripId, riderId, fare, order.id]);

  logger.info('Razorpay order created', { tripId, orderId: order.id, amountPaise });
  return order;
}

const STREAM_NAME = 'trip_events';
const GROUP_NAME = 'payment_service_group';
const CONSUMER_NAME = `payment_worker_${process.pid}`;

async function processTripEvent(event) {
  if (event.eventType !== 'TRIP_ENDED') return;

  const { tripId, riderId, fare } = event.payload;
  try {
    if (!fare) {
      await query(`
        INSERT INTO failed_events (event_type, payload, error_message, created_at)
        VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
      `, ['TRIP_ENDED', event.payload, 'Missing fare for payment']);
      logger.warn('Trip ended with no fare, skipping order creation', { tripId });
      return;
    }
    await createOrderForTrip({ tripId, riderId, fare });
  } catch (error) {
    await query(`
      INSERT INTO failed_events (event_type, payload, error_message, created_at)
      VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
    `, ['TRIP_ENDED', event.payload, error.message]);
    logger.error('Failed to create Razorpay order', { tripId, error: error.message });
  }
}

const verifySchema = z.object({
  tripId: z.string().uuid(),
  razorpayOrderId: z.string().min(5),
  razorpayPaymentId: z.string().min(5),
  razorpaySignature: z.string().min(10),
});

app.post('/payments/verify', requireAuth, async (req, res) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }
  const { tripId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = parsed.data;

  const ownerCheck = await query(`SELECT rider_id FROM payments WHERE trip_id = $1`, [tripId]);
  if (ownerCheck.rows.length === 0) {
    return res.status(404).json({ error: 'No matching payment order found for this trip' });
  }
  if (ownerCheck.rows[0].rider_id !== req.user.sub) {
    return res.status(403).json({ error: 'You are not authorized to verify this payment' });
  }

  const expectedSignature = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');

  if (expectedSignature !== razorpaySignature) {
    logger.warn('Payment signature mismatch', { tripId, razorpayOrderId });
    return res.status(400).json({ error: 'Invalid payment signature' });
  }

  try {
    const result = await query(`
      UPDATE payments
      SET status = 'succeeded', razorpay_payment_id = $2, razorpay_signature = $3, updated_at = CURRENT_TIMESTAMP
      WHERE trip_id = $1
      RETURNING *
    `, [tripId, razorpayPaymentId, razorpaySignature]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No matching payment order found for this trip' });
    }

    await eventBus.publish('trip_events', 'PAYMENT_SUCCEEDED', {
      tripId,
      riderId: result.rows[0].rider_id,
      amount: result.rows[0].amount,
    });

    res.status(200).json({ success: true, payment: result.rows[0] });
  } catch (error) {
    logger.error('Payment verification failed', { tripId, error: error.message });
    res.status(500).json({ error: 'Internal server error during verification' });
  }
});

app.post('/payments/webhook', async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  if (!signature || !req.rawBody) {
    return res.status(400).json({ error: 'Missing signature or body' });
  }

  const expectedSignature = crypto
    .createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest('hex');

  if (expectedSignature !== signature) {
    logger.warn('Webhook signature mismatch - rejecting');
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }

  const { event, payload } = req.body;

  try {
    if (event === 'payment.captured') {
      const paymentEntity = payload.payment.entity;
      const orderId = paymentEntity.order_id;
      const result = await query(`
        UPDATE payments
        SET status = 'succeeded', razorpay_payment_id = $2, updated_at = CURRENT_TIMESTAMP
        WHERE razorpay_order_id = $1 AND status != 'succeeded'
        RETURNING *
      `, [orderId, paymentEntity.id]);

      if (result.rows.length > 0) {
        await eventBus.publish('trip_events', 'PAYMENT_SUCCEEDED', {
          tripId: result.rows[0].trip_id,
          riderId: result.rows[0].rider_id,
          amount: result.rows[0].amount,
        });
      }
    } else if (event === 'payment.failed') {
      const paymentEntity = payload.payment.entity;
      const orderId = paymentEntity.order_id;
      const result = await query(`
        UPDATE payments
        SET status = 'failed', updated_at = CURRENT_TIMESTAMP
        WHERE razorpay_order_id = $1 AND status != 'succeeded'
        RETURNING *
      `, [orderId]);

      if (result.rows.length > 0) {
        await eventBus.publish('trip_events', 'PAYMENT_FAILED', {
          tripId: result.rows[0].trip_id,
          riderId: result.rows[0].rider_id,
          reason: paymentEntity.error_description || 'Payment failed',
        });
      }
    }

    res.status(200).json({ received: true });
  } catch (error) {
    logger.error('Webhook processing failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/payments/:tripId', requireAuth, async (req, res) => {
  try {
    const result = await query(`SELECT * FROM payments WHERE trip_id = $1`, [req.params.tripId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No payment found for this trip' });
    }
    if (result.rows[0].rider_id !== req.user.sub) {
      return res.status(403).json({ error: 'You are not authorized to view this payment' });
    }
    res.status(200).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/health', (req, res) => res.status(200).send('OK'));

async function start() {
  logger.info('Payment Service booting...');
  app.listen(PORT, () => logger.info(`Payment Service listening on port ${PORT}`));

  setTimeout(() => {
    eventBus.consume(STREAM_NAME, GROUP_NAME, CONSUMER_NAME, processTripEvent);
  }, 2000);
}

start();