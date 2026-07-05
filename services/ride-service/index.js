const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { pool, query, eventBus } = require('../../shared');
const { canTransition, getRequiredRole } = require('../../shared/tripState');
const { rideRequestSchema } = require('../../shared/validation');
const logger = require('../../shared/logger');

const app = express();
const metrics = { requests: 0, errors: 0 };
app.use(cors());
app.use(express.json());
app.use((req, res, next) => {
  metrics.requests += 1;
  res.on('finish', () => {
    if (res.statusCode >= 400) metrics.errors += 1;
  });
  next();
});

const PORT = process.env.PORT || 3001;
const LOCATION_SERVICE_URL = process.env.LOCATION_SERVICE_URL || 'http://localhost:3002';
const FARE_SERVICE_URL = process.env.FARE_SERVICE_URL || 'http://localhost:3003';
const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'internal-service-token';

async function setDriverAvailability(driverId, isAvailable) {
  if (!driverId) {
    return;
  }

  await query(`UPDATE drivers SET is_available = $1, updated_at = CURRENT_TIMESTAMP WHERE driver_id = $2`, [isAvailable, driverId]);
}

// 1. Create a ride request
app.post('/rides/request', async (req, res) => {
  const riderId = req.headers['x-user-id'];
  const parsed = rideRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { pickup, dropoff } = parsed.data;
  if (!riderId) {
    return res.status(400).json({ error: 'Missing authenticated rider' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let drivers = [];
    try {
      const locationRes = await axios.get(`${LOCATION_SERVICE_URL}/drivers/nearby`, {
        params: { lat: pickup.lat, lng: pickup.lng, radius: 5 },
        headers: { 'x-internal-token': INTERNAL_SERVICE_TOKEN },
        timeout: 1500,
      });
      drivers = (locationRes.data.drivers || []).map((driver) => driver.driverId);
    } catch (locationErr) {
      logger.warn('Location service unavailable, falling back to local driver lookup', { error: locationErr.message });
      const fallbackRes = await client.query(`
        SELECT driver_id
        FROM drivers
        WHERE is_available = true AND current_coords IS NOT NULL
        ORDER BY current_coords <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
        LIMIT 5
      `, [pickup.lng, pickup.lat]);
      drivers = fallbackRes.rows.map((row) => row.driver_id);
    }

    if (!drivers.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No drivers available nearby' });
    }

    const claimRes = await client.query(`
      SELECT driver_id
      FROM drivers
      WHERE driver_id = ANY($1::uuid[]) AND is_available = true
      ORDER BY current_coords <-> ST_SetSRID(ST_MakePoint($2, $3), 4326)
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `, [drivers, pickup.lng, pickup.lat]);

    if (claimRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Driver became unavailable while booking' });
    }

    const selectedDriver = claimRes.rows[0].driver_id;
    await client.query(`UPDATE drivers SET is_available = false, updated_at = CURRENT_TIMESTAMP WHERE driver_id = $1`, [selectedDriver]);

    let fareEstimate = null;
    try {
      const fareRes = await axios.post(`${FARE_SERVICE_URL}/fares/estimate`, { pickup, dropoff });
      fareEstimate = fareRes.data.estimate;
    } catch (e) {
      logger.warn('Could not get fare estimate, proceeding without it', { error: e.message });
    }

    const sql = `
      INSERT INTO trips (rider_id, driver_id, pickup_coords, dropoff_coords, status, fare)
      VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), ST_SetSRID(ST_MakePoint($5, $6), 4326), 'REQUESTED', $7)
      RETURNING trip_id, status, created_at
    `;
    const result = await client.query(sql, [
      riderId,
      selectedDriver,
      pickup.lng, pickup.lat,
      dropoff.lng, dropoff.lat,
      fareEstimate
    ]);

    const trip = result.rows[0];

    await client.query('COMMIT');
    await eventBus.publish('trip_events', 'TRIP_REQUESTED', {
      tripId: trip.trip_id,
      riderId,
      driverId: selectedDriver,
      pickup,
      dropoff,
      timestamp: trip.created_at
    });

    res.status(201).json({
      message: 'Ride requested successfully',
      tripId: trip.trip_id,
      driverId: selectedDriver,
      status: trip.status,
      fareEstimate
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Error creating ride request', { error: err.message });
    res.status(500).json({ error: 'Internal server error while requesting ride' });
  } finally {
    client.release();
  }
});

// 2. Get Trip Details
app.get('/rides/:id', async (req, res) => {
  try {
    const sql = `
      SELECT trip_id, rider_id, driver_id, status, fare, created_at, updated_at,
             ST_X(pickup_coords::geometry) as pickup_lng, ST_Y(pickup_coords::geometry) as pickup_lat,
             ST_X(dropoff_coords::geometry) as dropoff_lng, ST_Y(dropoff_coords::geometry) as dropoff_lat
      FROM trips WHERE trip_id = $1::uuid
    `;
    const result = await query(sql, [req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Trip not found' });
    }

    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 3. Update Trip Status (Accept, Start, End)
app.post('/rides/:id/accept', async (req, res) => {
  const tripId = req.params.id;
  const callerId = req.headers['x-user-id'];
  const callerRole = req.headers['x-user-role'];
  if (callerRole !== 'driver') {
    return res.status(403).json({ error: 'Only drivers can accept trips' });
  }

  try {
    const tripRes = await query(`SELECT * FROM trips WHERE trip_id = $1`, [tripId]);
    if (tripRes.rows.length === 0) {
      return res.status(404).json({ error: 'Trip not found' });
    }

    const trip = tripRes.rows[0];
    if (trip.status !== 'REQUESTED') {
      return res.status(409).json({ error: 'Trip is no longer pending' });
    }

    if (trip.driver_id !== callerId) {
      return res.status(403).json({ error: 'You are not assigned to this trip' });
    }

    const result = await query(`UPDATE trips SET status = 'ACCEPTED', updated_at = CURRENT_TIMESTAMP WHERE trip_id = $1 RETURNING *`, [tripId]);
    const updatedTrip = result.rows[0];
    await eventBus.publish('trip_events', 'TRIP_ACCEPTED', { tripId, driverId: updatedTrip.driver_id, riderId: updatedTrip.rider_id, status: 'ACCEPTED' });
    res.status(200).json({ trip: updatedTrip });
  } catch (error) {
    logger.error('accept trip failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error while accepting trip' });
  }
});

app.post('/rides/:id/reject', async (req, res) => {
  const tripId = req.params.id;
  const callerId = req.headers['x-user-id'];
  const callerRole = req.headers['x-user-role'];
  if (callerRole !== 'driver') {
    return res.status(403).json({ error: 'Only drivers can reject trips' });
  }

  try {
    const tripRes = await query(`SELECT * FROM trips WHERE trip_id = $1`, [tripId]);
    if (tripRes.rows.length === 0) {
      return res.status(404).json({ error: 'Trip not found' });
    }

    const trip = tripRes.rows[0];
    if (trip.status !== 'REQUESTED') {
      return res.status(409).json({ error: 'Trip is no longer pending' });
    }

    if (trip.driver_id !== callerId) {
      return res.status(403).json({ error: 'You are not assigned to this trip' });
    }

    const result = await query(`UPDATE trips SET status = 'CANCELED', canceled_by = $2, canceled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE trip_id = $1 RETURNING *`, [tripId, callerId]);
    const updatedTrip = result.rows[0];
    await eventBus.publish('trip_events', 'TRIP_CANCELED', { tripId, driverId: updatedTrip.driver_id, riderId: updatedTrip.rider_id, status: 'CANCELED' });
    res.status(200).json({ trip: updatedTrip });
  } catch (error) {
    logger.error('reject trip failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error while rejecting trip' });
  }
});

app.post('/rides/:id/cancel', async (req, res) => {
  const tripId = req.params.id;
  const callerId = req.headers['x-user-id'];
  const callerRole = req.headers['x-user-role'];
  try {
    const tripRes = await query(`SELECT * FROM trips WHERE trip_id = $1`, [tripId]);
    if (tripRes.rows.length === 0) {
      return res.status(404).json({ error: 'Trip not found' });
    }

    const trip = tripRes.rows[0];
    const canCancel = ['REQUESTED', 'ACCEPTED'].includes(trip.status);
    if (!canCancel) {
      return res.status(409).json({ error: 'Trip cannot be canceled from this state' });
    }

    if (callerRole !== 'driver' && callerId !== trip.rider_id) {
      return res.status(403).json({ error: 'You are not authorized to cancel this trip' });
    }

    const result = await query(`UPDATE trips SET status = 'CANCELED', canceled_by = $2, canceled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE trip_id = $1 RETURNING *`, [tripId, callerId]);
    const updatedTrip = result.rows[0];
    await eventBus.publish('trip_events', 'TRIP_CANCELED', { tripId, driverId: updatedTrip.driver_id, riderId: updatedTrip.rider_id, status: 'CANCELED' });
    res.status(200).json({ trip: updatedTrip });
  } catch (error) {
    logger.error('cancel trip failed', { error: error.message });
    res.status(500).json({ error: 'Internal server error while canceling trip' });
  }
});

app.patch('/rides/:id/status', async (req, res) => {
  const tripId = req.params.id;
  const callerId = req.headers['x-user-id'];
  const callerRole = req.headers['x-user-role'];
  let { status } = req.body;
  const validStatuses = ['ACCEPTED', 'STARTED', 'ENDED', 'CANCELED', 'PENDING_FARE'];

  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    const currentTripRes = await query(`SELECT * FROM trips WHERE trip_id = $1`, [tripId]);
    if (currentTripRes.rows.length === 0) {
      return res.status(404).json({ error: 'Trip not found' });
    }

    const currentTrip = currentTripRes.rows[0];
    if (!canTransition(currentTrip.status, status)) {
      return res.status(409).json({ error: 'Illegal trip transition' });
    }

    const requiredRole = getRequiredRole(currentTrip.status, status);
    if (requiredRole === 'driver' && callerRole !== 'driver') {
      return res.status(403).json({ error: 'Only drivers may perform this action' });
    }

    if (callerRole !== 'driver' && callerId !== currentTrip.rider_id && callerId !== currentTrip.driver_id) {
      return res.status(403).json({ error: 'You are not authorized to update this trip' });
    }

    if (status === 'ACCEPTED' && callerId !== currentTrip.driver_id) {
      return res.status(403).json({ error: 'Only the assigned driver can accept this trip' });
    }

    if (status === 'STARTED' && callerId !== currentTrip.driver_id) {
      return res.status(403).json({ error: 'Only the assigned driver can start this trip' });
    }

    let finalFare = null;
    if (status === 'ENDED') {
      const tripRes = await query(`
        SELECT ST_X(pickup_coords::geometry) as p_lng, ST_Y(pickup_coords::geometry) as p_lat,
               ST_X(dropoff_coords::geometry) as d_lng, ST_Y(dropoff_coords::geometry) as d_lat
        FROM trips WHERE trip_id = $1
      `, [tripId]);

      if (tripRes.rows.length > 0) {
        const t = tripRes.rows[0];
        try {
          const fareRes = await axios.post(`${FARE_SERVICE_URL}/fares/estimate`, {
            pickup: { lat: t.p_lat, lng: t.p_lng },
            dropoff: { lat: t.d_lat, lng: t.d_lng }
          });
          finalFare = fareRes.data.estimate;
        } catch (e) {
          logger.warn('Fare service unavailable while ending trip, marking pending fare', { tripId, error: e.message });
          status = 'PENDING_FARE';
        }
      }
    }

  let sql = `UPDATE trips SET status = $1, updated_at = CURRENT_TIMESTAMP`;
const params = [status];

if (finalFare !== null) {
  sql += `, fare = $2`;
  params.push(finalFare);
  params.push(tripId);
  sql += ` WHERE trip_id = $${params.length}`;
} else {
  sql += ` WHERE trip_id = $2`;
  params.push(tripId);
}

    sql += ` RETURNING *`;

    const result = await query(sql, params);
    const updatedTrip = result.rows[0];

    if (status === 'CANCELED' || status === 'ENDED') {
      await setDriverAvailability(updatedTrip.driver_id, true);
    }

    await eventBus.publish('trip_events', `TRIP_${status}`, {
      tripId,
      driverId: updatedTrip.driver_id,
      riderId: updatedTrip.rider_id,
      status,
      fare: updatedTrip.fare,
      timestamp: updatedTrip.updated_at
    });

    res.status(200).json({ message: `Trip status updated to ${status}`, trip: updatedTrip });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error while updating status' });
  }
});

// Root route
app.get('/', (req, res) => res.status(200).json({ message: 'Ride-Hailing Backend API is running successfully' }));

// Basic healthcheck
app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/metrics', (req, res) => res.status(200).json(metrics));

app.listen(PORT, () => {
  console.log(`Ride Service listening on port ${PORT}`);
});
