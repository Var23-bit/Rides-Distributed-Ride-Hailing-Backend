const { Pool } = require('pg');
const Redis = require('ioredis');

// --- Database Configuration ---
const dbPoolUrl = process.env.DATABASE_URL || 'postgres://admin:password@localhost:5432/ridehail';
const isLocalDb = !process.env.DATABASE_URL
  || /@(localhost|127\.0\.0\.1|postgres)(:|\/)/.test(process.env.DATABASE_URL);

const pool = new Pool({
  connectionString: dbPoolUrl,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  ssl: isLocalDb ? false : { rejectUnauthorized: false },
});

const isDatabaseUnavailableError = (error) => {
  const message = error?.message || '';
  const code = error?.code || error?.cause?.code || '';
  return error instanceof AggregateError
    || code === 'ECONNREFUSED'
    || code === 'ETIMEDOUT'
    || /ECONNREFUSED|ETIMEDOUT|timeout|connect|terminated|refused/i.test(message);
};

// A standard query wrapper
const query = async (text, params) => {
  try {
    const start = Date.now();
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    // console.log('executed query', { text, duration, rows: res.rowCount });
    return res;
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      console.warn('Database unavailable; request will continue in degraded mode.', error.message || error.cause?.message || '');
      return { rows: [], rowCount: 0 };
    }
    throw error;
  }
};

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

// --- Redis Configuration ---
const redisUrl = process.env.REDIS_URL;
const redisClient = redisUrl
  ? new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    })
  : createMemoryRedisClient();

if (redisUrl) {
  redisClient.on('error', (err) => console.log('Redis Client Error', err.message));
  redisClient.on('connect', () => console.log('Connected to Redis'));
} else {
  console.log('Redis Client Error: using in-memory Redis fallback');
}

// --- Event Bus (Redis Streams) ---
class EventBus {
  constructor(client) {
    this.client = client;
  }

  // Publish an event to a stream
  async publish(stream, eventType, payload) {
    if (!this.client || typeof this.client.xadd !== 'function') {
      return null;
    }

    try {
      const messageId = await this.client.xadd(
        stream,
        '*', // let redis assign ID
        'eventType', eventType,
        'payload', JSON.stringify(payload)
      );
      return messageId;
    } catch (err) {
      console.warn(`EventBus publish skipped for ${stream}:`, err.message);
      return null;
    }
  }

  // Simple consumer for listening to a stream
  // This approach uses continuous read blocking - good for simple microservices
  async consume(stream, group, consumerName, callback) {
    if (!this.client || typeof this.client.xgroup !== 'function') {
      return;
    }

    try {
      // Create consumer group, ignore if it already exists
      await this.client.xgroup('CREATE', stream, group, '0', 'MKSTREAM').catch(err => {
        if (!err.message.includes('BUSYGROUP')) throw err;
      });

      console.log(`Started consuming from stream ${stream} as ${consumerName} in group ${group}`);

      while (true) {
        const results = await this.client.xreadgroup(
          'GROUP', group, consumerName,
          'BLOCK', '0',
          'COUNT', '1',
          'STREAMS', stream, '>'
        );

        if (results && results.length > 0) {
          const streamData = results[0];
          const messages = streamData[1];

          for (const message of messages) {
            const id = message[0];
            const fields = message[1];
            
            // Reconstruct event object from Redis key-value pairs
            const event = {};
            for (let i = 0; i < fields.length; i += 2) {
              event[fields[i]] = fields[i + 1];
            }
            if (event.payload) {
                try {
                    event.payload = JSON.parse(event.payload);
                } catch(e) {}
            }

            try {
              // Process the message via callback
              await callback(event, id);
              
              // Acknowledge the message so it's removed from pending
              await this.client.xack(stream, group, id);
            } catch (err) {
              console.error(`Error processing message ${id}:`, err);
              // In a real production system, you'd have a dead letter queue or retry logic here
            }
          }
        }
      }
    } catch (err) {
      console.error('Consumer error:', err);
    }
  }
}

const eventBus = new EventBus(redisClient);

module.exports = {
  pool,
  query,
  redisClient,
  eventBus
};

