/**
 * Unified Server - Boots all ride-hailing microservices in a single process.
 * 
 * Services:
 *   HTTP:   ride-service (/rides), location-service (/drivers), fare-service (/fares)
 *   Workers: payment-service, history-service (Redis Streams consumers) — only if Redis is available
 */

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Pool } = require('pg');

// ──────────────────────────────────────────
//  Shared Infrastructure
// ──────────────────────────────────────────

const PORT = process.env.PORT || 3000;

// Database
const dbPoolUrl = process.env.DATABASE_URL || 'postgres://admin:password@localhost:5432/ridehail';
const pool = new Pool({
  connectionString: dbPoolUrl,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 30000,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false,
});

const isDatabaseUnavailableError = (error) => {
  const message = error?.message || '';
  const code = error?.code || error?.cause?.code || '';
  return error instanceof AggregateError
    || code === 'ECONNREFUSED'
    || code === 'ETIMEDOUT'
    || /ECONNREFUSED|ETIMEDOUT|timeout|connect|terminated|refused/i.test(message);
};

const query = async (text, params) => {
  try {
    return await pool.query(text, params);
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      const unavailableError = new Error('Database unavailable');
      unavailableError.code = 'DB_UNAVAILABLE';
      throw unavailableError;
    }
    throw error;
  }
};

// ── Redis (Optional) ──
let redisClient = null;
let redisReady = false;

function createMemoryRedisClient() {
  const geoStore = new Map();
  const timestamps = new Map();

  const distanceInKm = (lng1, lat1, lng2, lat2) => {
    const toRad = (value) => (value * Math.PI) / 180;
    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };

  return {
    on() { return this; },
    async geoadd(key, lng, lat, member) {
      const current = geoStore.get(key) || new Map();
      current.set(member, { lng, lat });
      geoStore.set(key, current);
      return 1;
    },
    async zadd(key, score, member) {
      const current = timestamps.get(key) || new Map();
      current.set(member, score);
      timestamps.set(key, current);
      return 1;
    },
    async zscore(key, member) {
      return timestamps.get(key)?.get(member) ?? null;
    },
    async zrem(key, member) {
      const current = timestamps.get(key);
      if (current) {
        current.delete(member);
        if (current.size === 0) timestamps.delete(key);
      }
      return 1;
    },
    async geosearch(key, ...args) {
      const current = geoStore.get(key);
      if (!current) return [];
      const [, lng, lat] = args;
      return Array.from(current.entries())
        .map(([member, coords]) => [member, distanceInKm(lng, lat, coords.lng, coords.lat).toFixed(2)])
        .sort((a, b) => parseFloat(a[1]) - parseFloat(b[1]));
    },
    async xadd() { return '1-0'; },
    async xgroup() { return 'OK'; },
    async xreadgroup() { return []; },
    async xack() { return 1; },
  };
}

async function initRedis() {
  if (!process.env.REDIS_URL) {
    redisClient = createMemoryRedisClient();
    redisReady = true;
    console.log('[Redis] No REDIS_URL set — using in-memory Redis fallback.');
    return;
  }
  try {
    const Redis = require('ioredis');
    redisClient = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => (times > 3 ? null : Math.min(times * 500, 2000)),
    });
    redisClient.on('error', (err) => console.log('[Redis] Error:', err.message));
    redisClient.on('connect', () => {
      console.log('[Redis] Connected');
      redisReady = true;
    });
    redisClient.on('close', () => { redisReady = false; });
  } catch (err) {
    console.log('[Redis] Failed to initialize:', err.message);
  }
}

// Event Bus (Redis Streams) — no-ops if Redis not available
const eventBus = {
  async publish(stream, eventType, payload) {
    if (!redisReady || !redisClient) return null;
    try {
      return await redisClient.xadd(stream, '*', 'eventType', eventType, 'payload', JSON.stringify(payload));
    } catch (err) {
      console.error(`[EventBus] Failed to publish to ${stream}:`, err.message);
      return null;
    }
  },
  async consume(stream, group, consumerName, callback) {
    if (!redisReady || !redisClient) return;
    try {
      await redisClient.xgroup('CREATE', stream, group, '0', 'MKSTREAM').catch(err => {
        if (!err.message.includes('BUSYGROUP')) throw err;
      });
      console.log(`[EventBus] Consuming ${stream} as ${consumerName}`);
      while (redisReady) {
        const results = await redisClient.xreadgroup('GROUP', group, consumerName, 'BLOCK', '5000', 'COUNT', '1', 'STREAMS', stream, '>');
        if (results && results.length > 0) {
          for (const message of results[0][1]) {
            const id = message[0];
            const fields = message[1];
            const event = {};
            for (let i = 0; i < fields.length; i += 2) event[fields[i]] = fields[i + 1];
            if (event.payload) { try { event.payload = JSON.parse(event.payload); } catch (e) {} }
            try {
              await callback(event, id);
              await redisClient.xack(stream, group, id);
            } catch (err) {
              console.error(`[EventBus] Error processing ${id}:`, err.message);
            }
          }
        }
      }
    } catch (err) {
      console.error('[EventBus] Consumer error:', err.message);
    }
  }
};

// ──────────────────────────────────────────
//  Express App & HTTP Server
// ──────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);

// ──────────────────────────────────────────
//  Root Route & Health
// ──────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({
    message: 'Ride-Hailing Backend API — All Services Running',
    services: {
      ride: { endpoints: ['POST /rides/request', 'GET /rides/:id', 'PATCH /rides/:id/status'] },
      location: { endpoints: ['POST /drivers/location', 'GET /drivers/nearby'] },
      fare: { endpoints: ['POST /fares/estimate'] },
      payment: { type: 'background worker (Redis Streams consumer)', active: redisReady },
      history: { type: 'background worker (Redis Streams consumer)', active: redisReady },
    },
    redis: redisReady ? 'connected' : 'not configured',
    health: '/health',
  });
});

app.get('/health', (req, res) => res.status(200).json({ status: 'OK', redis: redisReady }));

// ──────────────────────────────────────────
//  RIDE SERVICE routes  (/rides/*)
// ──────────────────────────────────────────

app.post('/rides/request', async (req, res) => {
  const { riderId, pickup, dropoff } = req.body;
  if (!riderId || !pickup || !dropoff) {
    return res.status(400).json({ error: 'Missing riderId, pickup, or dropoff coordinates' });
  }

  try {
    // Find nearest driver via DB (works without Redis)
    let selectedDriver = null;

    if (redisReady && redisClient) {
      // Try Redis geo-search first (fast path)
      try {
        const results = await redisClient.geosearch('driver_locations', 'FROMLONLAT', pickup.lng, pickup.lat, 'BYRADIUS', 5, 'km', 'WITHDIST', 'ASC');
        if (results && results.length > 0) {
          selectedDriver = results[0][0];
        }
      } catch (e) {
        console.warn('[Ride] Redis geosearch failed, falling back to DB:', e.message);
      }
    }

    // Fallback: query PostGIS directly
    if (!selectedDriver) {
      const driverRes = await query(`
        SELECT driver_id FROM drivers
        WHERE is_available = true AND current_coords IS NOT NULL
        ORDER BY current_coords <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
        LIMIT 1
      `, [pickup.lng, pickup.lat]);
      if (driverRes.rows.length > 0) {
        selectedDriver = driverRes.rows[0].driver_id;
      }
    }

    if (!selectedDriver) {
      return res.status(404).json({ error: 'No drivers available nearby' });
    }

    // Get fare estimate (in-process call)
    const distKm = getDistanceFromLatLonInKm(pickup.lat, pickup.lng, dropoff.lat, dropoff.lng);
    const estTimeMins = (distKm / SPEED) * 60;
    let fareEstimate = Math.round((BASE_FARE + (distKm * PER_KM_RATE) + (estTimeMins * PER_MIN_RATE)) * 100) / 100;

    // Create Trip in DB
    const sql = `
      INSERT INTO trips (rider_id, driver_id, pickup_coords, dropoff_coords, status)
      VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326), ST_SetSRID(ST_MakePoint($5, $6), 4326), 'REQUESTED')
      RETURNING trip_id, status, created_at
    `;
    const result = await query(sql, [riderId, selectedDriver, pickup.lng, pickup.lat, dropoff.lng, dropoff.lat]);
    if (!result.rows || result.rows.length === 0) {
      return res.status(503).json({ error: 'Ride service temporarily unavailable' });
    }
    const trip = result.rows[0];

    // Publish event (no-op if no Redis)
    await eventBus.publish('trip_events', 'TRIP_REQUESTED', {
      tripId: trip.trip_id, riderId, driverId: selectedDriver, pickup, dropoff, timestamp: trip.created_at
    });

    res.status(201).json({
      message: 'Ride requested successfully',
      tripId: trip.trip_id,
      driverId: selectedDriver,
      status: trip.status,
      fareEstimate
    });
  } catch (err) {
    console.error('Error creating ride request:', err.message || err.cause?.message || 'Unknown error');
    if (err && (err.code === 'DB_UNAVAILABLE' || isDatabaseUnavailableError(err))) {
      return res.status(503).json({ error: 'Ride service temporarily unavailable' });
    }
    res.status(500).json({ error: 'Internal server error while requesting ride' });
  }
});

app.get('/rides/:id', async (req, res) => {
  try {
    const sql = `
      SELECT trip_id, rider_id, driver_id, status, fare, created_at, updated_at,
             ST_X(pickup_coords::geometry) as pickup_lng, ST_Y(pickup_coords::geometry) as pickup_lat,
             ST_X(dropoff_coords::geometry) as dropoff_lng, ST_Y(dropoff_coords::geometry) as dropoff_lat
      FROM trips WHERE trip_id = $1
    `;
    const result = await query(sql, [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Trip not found' });
    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/rides/:id/status', async (req, res) => {
  const tripId = req.params.id;
  const { status } = req.body;
  const validStatuses = ['ACCEPTED', 'STARTED', 'ENDED', 'CANCELED'];
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  try {
    let finalFare = null;
    if (status === 'ENDED') {
      const tripRes = await query(`
        SELECT ST_X(pickup_coords::geometry) as p_lng, ST_Y(pickup_coords::geometry) as p_lat,
               ST_X(dropoff_coords::geometry) as d_lng, ST_Y(dropoff_coords::geometry) as d_lat
        FROM trips WHERE trip_id = $1
      `, [tripId]);

      if (tripRes.rows.length > 0) {
        const t = tripRes.rows[0];
        const distKm = getDistanceFromLatLonInKm(t.p_lat, t.p_lng, t.d_lat, t.d_lng);
        const estTimeMins = (distKm / SPEED) * 60;
        finalFare = Math.round((BASE_FARE + (distKm * PER_KM_RATE) + (estTimeMins * PER_MIN_RATE)) * 100) / 100;
      }
    }

    let sql = `UPDATE trips SET status = $1, updated_at = CURRENT_TIMESTAMP`;
    const params = [status];
    if (finalFare !== null) {
      sql += `, fare = $2 WHERE trip_id = $3`;
      params.push(finalFare, tripId);
    } else {
      sql += ` WHERE trip_id = $2`;
      params.push(tripId);
    }
    sql += ` RETURNING *`;

    const result = await query(sql, params);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Trip not found' });

    const updatedTrip = result.rows[0];

    await eventBus.publish('trip_events', `TRIP_${status}`, {
      tripId, driverId: updatedTrip.driver_id, riderId: updatedTrip.rider_id,
      status, fare: updatedTrip.fare, timestamp: updatedTrip.updated_at
    });

    res.status(200).json({ message: `Trip status updated to ${status}`, trip: updatedTrip });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error while updating status' });
  }
});

// ──────────────────────────────────────────
//  LOCATION SERVICE routes  (/drivers/*)
// ──────────────────────────────────────────

async function updateDriverLocation(driverId, lat, lng) {
  // Update Redis geo index if available
  if (redisReady && redisClient) {
    try {
      await redisClient.geoadd('driver_locations', lng, lat, driverId);
      await redisClient.zadd('driver_timestamps', Date.now(), driverId);
    } catch (err) {
      console.error(`[Location] Redis update failed for driver ${driverId}:`, err.message);
    }
  }

  // Always update PostGIS DB
  try {
    await query(`
      INSERT INTO drivers (driver_id, name, current_coords, is_available, updated_at)
      VALUES ($3::uuid, 'Driver ' || substring($3::text from 1 for 8), ST_SetSRID(ST_MakePoint($1, $2), 4326), true, CURRENT_TIMESTAMP)
      ON CONFLICT (driver_id)
      DO UPDATE SET current_coords = EXCLUDED.current_coords, is_available = true, updated_at = CURRENT_TIMESTAMP
    `, [lng, lat, driverId]);
  } catch (err) {
    console.error(`[Location] DB update failed for driver ${driverId}:`, err.message);
  }

  await eventBus.publish('driver_events', 'LOCATION_UPDATED', { driverId, lat, lng });
}

app.post('/drivers/location', async (req, res) => {
  const { driverId, lat, lng } = req.body;
  if (!driverId || lat === undefined || lng === undefined) {
    return res.status(400).json({ error: 'Missing driverId, lat, or lng' });
  }
  try {
    await updateDriverLocation(driverId, lat, lng);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/drivers/nearby', async (req, res) => {
  const { lat, lng, radius = 5 } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'Missing lat or lng' });

  try {
    // Try Redis first
    if (redisReady && redisClient) {
      try {
        const results = await redisClient.geosearch('driver_locations', 'FROMLONLAT', lng, lat, 'BYRADIUS', radius, 'km', 'WITHDIST', 'ASC');
        const activeDrivers = [];
        const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
        for (const item of results) {
          const dId = item[0];
          const distance = parseFloat(item[1]);
          const lastUpdate = await redisClient.zscore('driver_timestamps', dId);
          if (lastUpdate && parseInt(lastUpdate, 10) > fiveMinutesAgo) {
            activeDrivers.push({ driverId: dId, distance });
          }
        }
        return res.status(200).json({ drivers: activeDrivers });
      } catch (e) {
        console.warn('[Location] Redis geosearch failed, using DB fallback:', e.message);
      }
    }

    // Fallback: PostGIS query
    const dbRes = await query(`
      SELECT driver_id, 
             ST_Distance(current_coords, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) / 1000 as distance
      FROM drivers
      WHERE is_available = true AND current_coords IS NOT NULL
        AND ST_DWithin(current_coords, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3 * 1000)
      ORDER BY distance ASC
    `, [lng, lat, radius]);
    const drivers = dbRes.rows.map(r => ({ driverId: r.driver_id, distance: parseFloat(r.distance) }));
    res.status(200).json({ drivers });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────
//  FARE SERVICE routes  (/fares/*)
// ──────────────────────────────────────────

const BASE_FARE = 2.50;
const PER_KM_RATE = 1.25;
const PER_MIN_RATE = 0.30;
const SPEED = 30;

function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function deg2rad(deg) { return deg * (Math.PI / 180); }

app.post('/fares/estimate', (req, res) => {
  const { pickup, dropoff } = req.body;
  if (!pickup || !dropoff) return res.status(400).json({ error: 'Missing pickup or dropoff' });
  try {
    const distKm = getDistanceFromLatLonInKm(pickup.lat, pickup.lng, dropoff.lat, dropoff.lng);
    const estTimeMins = (distKm / SPEED) * 60;
    let totalFare = Math.round((BASE_FARE + (distKm * PER_KM_RATE) + (estTimeMins * PER_MIN_RATE)) * 100) / 100;
    res.status(200).json({ estimate: totalFare, distance_km: distKm, time_mins: estTimeMins, currency: 'USD' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ──────────────────────────────────────────
//  PAYMENT SERVICE (background worker)
// ──────────────────────────────────────────

async function processPayment(event) {
  if (event.eventType === 'TRIP_ENDED') {
    const { tripId, riderId, fare } = event.payload;
    console.log(`[Payment] Processing Trip: ${tripId}, Rider: ${riderId}, Amount: $${fare}`);
    await new Promise(resolve => setTimeout(resolve, 1000));
    console.log(`[Payment] Success for Trip: ${tripId}`);
  }
}

// ──────────────────────────────────────────
//  HISTORY SERVICE (background worker)
// ──────────────────────────────────────────

async function processHistoryEvent(event) {
  const { eventType, payload } = event;
  const tripId = payload.tripId || null;
  try {
    console.log(`[History] Logging: ${eventType} for Trip: ${tripId}`);
    await query(`INSERT INTO events_log (trip_id, event_type, payload) VALUES ($1, $2, $3)`, [tripId, eventType, payload]);
  } catch (err) {
    console.error(`[History] Failed to log ${eventType}:`, err.message);
  }
}

// ──────────────────────────────────────────
//  Boot Everything
// ──────────────────────────────────────────

async function boot() {
  // Initialize Redis (optional)
  await initRedis();

  server.listen(PORT, () => {
    console.log(`\n====================================`);
    console.log(`  Ride-Hailing Unified Server`);
    console.log(`  Listening on port ${PORT}`);
    console.log(`====================================`);
    console.log(`  Routes:`);
    console.log(`    GET  /              - API info`);
    console.log(`    GET  /health        - Health check`);
    console.log(`    POST /rides/request - Request a ride`);
    console.log(`    GET  /rides/:id     - Get trip details`);
    console.log(`    PATCH /rides/:id/status`);
    console.log(`    POST /drivers/location`);
    console.log(`    GET  /drivers/nearby`);
    console.log(`    POST /fares/estimate`);
    console.log(`  Redis: ${redisReady ? 'CONNECTED' : 'NOT CONFIGURED (running in DB-only mode)'}`);
    console.log(`====================================\n`);

    // Start background workers only if Redis is available
    if (redisReady) {
      setTimeout(() => {
        eventBus.consume('trip_events', 'payment_service_group', `payment_worker_${process.pid}`, processPayment);
      }, 2000);
      setTimeout(() => {
        eventBus.consume('trip_events', 'history_service_group', `history_worker_${process.pid}`, processHistoryEvent);
      }, 2500);
    }
  });
}

boot();
