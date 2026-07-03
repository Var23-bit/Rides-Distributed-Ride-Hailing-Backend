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

// A standard query wrapper
const query = async (text, params) => {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  // console.log('executed query', { text, duration, rows: res.rowCount });
  return res;
};

// --- Redis Configuration ---
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const redisClient = new Redis(redisUrl);

redisClient.on('error', (err) => console.log('Redis Client Error', err));
redisClient.on('connect', () => console.log('Connected to Redis'));

// --- Event Bus (Redis Streams) ---
class EventBus {
  constructor(client) {
    this.client = client;
  }

  // Publish an event to a stream
  async publish(stream, eventType, payload) {
    try {
      const messageId = await this.client.xadd(
        stream,
        '*', // let redis assign ID
        'eventType', eventType,
        'payload', JSON.stringify(payload)
      );
      return messageId;
    } catch (err) {
      console.error(`Failed to publish event to stream ${stream}:`, err);
      throw err;
    }
  }

  // Simple consumer for listening to a stream
  // This approach uses continuous read blocking - good for simple microservices
  async consume(stream, group, consumerName, callback) {
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

