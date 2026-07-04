const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { redisClient, query, eventBus } = require('../../shared');
const { locationSchema } = require('../../shared/validation');
const logger = require('../../shared/logger');
const { verifyAccessToken } = require('../../shared/auth');

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

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const internalToken = req.headers['x-internal-token'];

  if (internalToken && internalToken === (process.env.INTERNAL_SERVICE_TOKEN || 'internal-service-token')) {
    return next();
  }

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

const PORT = process.env.PORT || 3002;

// --- Helper Functions ---
async function updateDriverLocation(driverId, lat, lng) {
  // 1. Update fast Redis GEO index
  // GEOADD key longitude latitude member
  await redisClient.geoadd('driver_locations', lng, lat, driverId);
  
  // Update a simple set of active timestamps (for potential cleanup)
  await redisClient.zadd('driver_timestamps', Date.now(), driverId);

  // 2. Async update to persistent PostGIS DB (upsert � creates the driver row if it doesn't exist yet)
  try {
    const sql = `
      INSERT INTO drivers (driver_id, name, current_coords, is_available, updated_at)
      VALUES ($3::uuid, 'Driver ' || substring($3::text from 1 for 8), ST_SetSRID(ST_MakePoint($1, $2), 4326), true, CURRENT_TIMESTAMP)
      ON CONFLICT (driver_id)
      DO UPDATE SET current_coords = EXCLUDED.current_coords, is_available = true, updated_at = CURRENT_TIMESTAMP
    `;
    await query(sql, [lng, lat, driverId]);
  } catch (err) {
    console.error(`Failed to update DB for driver ${driverId}`, err);
  }

  // Publish event if needed (e.g. for riders tracking this driver)
  // Riders listening to a trip can join a socket.io room named `trip_${tripId}`
  // For now, emit a pub/sub event that other instances can broadcast
  await eventBus.publish('driver_events', 'LOCATION_UPDATED', { driverId, lat, lng });
}

// --- REST Endpoints ---
app.post('/drivers/location', requireAuth, async (req, res) => {
  const parsed = locationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { driverId, lat, lng } = parsed.data;
  try {
    await updateDriverLocation(driverId, lat, lng);
    res.status(200).json({ success: true });
  } catch (err) {
    logger.error('location update failed', { error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/drivers/nearby', requireAuth, async (req, res) => {
  const { lat, lng, radius = 5 } = req.query; // radius in km
  if (!lat || !lng) {
    return res.status(400).json({ error: 'Missing lat or lng' });
  }

  try {
    // GEORADIUS key longitude latitude radius unit [WITHCOORD] [WITHDIST] [WITHHASH] [COUNT count] [ASC|DESC]
    const results = await redisClient.geosearch(
      'driver_locations',
      'FROMLONLAT', lng, lat,
      'BYRADIUS', radius, 'km',
      'WITHDIST',
      'ASC'
    );
    
    // results look like: [ [ 'driver_id1', '1.23' ], [ 'driver_id2', '2.56' ] ]
    
    // Optionally filter out stale records (> 5 mins old)
    const activeDrivers = [];
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    
    for (const res of results) {
      const driverId = res[0];
      const distance = parseFloat(res[1]);
      const lastUpdate = await redisClient.zscore('driver_timestamps', driverId);
      
      if (lastUpdate && parseInt(lastUpdate, 10) > fiveMinutesAgo) {
        activeDrivers.push({ driverId, distance });
      } else {
        // Cleanup stale data optionally
        await redisClient.zrem('driver_locations', driverId);
        await redisClient.zrem('driver_timestamps', driverId);
      }
    }

    res.status(200).json({ drivers: activeDrivers });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) {
    return next(new Error('Authentication error'));
  }

  try {
    socket.user = verifyAccessToken(token);
    next();
  } catch (error) {
    next(new Error('Authentication error'));
  }
});

// --- WebSocket handlers ---
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Driver authenticates and sends continuous locations
  socket.on('update_location', async (data) => {
    const { driverId, lat, lng } = data;
    if (socket.user?.role !== 'driver' || socket.user.sub !== driverId) {
      return socket.emit('error', { message: 'Unauthorized driver update' });
    }

    if (driverId && lat !== undefined && lng !== undefined) {
      await updateDriverLocation(driverId, lat, lng);
      io.to(`track_driver_${driverId}`).emit('driver_location', { lat, lng });
    }
  });

  // Rider wants to track a driver
  socket.on('subscribe_driver', (data) => {
    const { driverId } = data;
    if (driverId) {
      socket.join(`track_driver_${driverId}`);
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Basic healthcheck
app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/metrics', (req, res) => res.status(200).json(metrics));

server.listen(PORT, () => {
  console.log(`Location Service listening on port ${PORT}`);
});

