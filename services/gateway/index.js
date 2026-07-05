const express = require('express');
const cors = require('cors');
const { verifyAccessToken } = require('/shared/auth');
const rateLimit = require('express-rate-limit');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
app.use(cors());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

const RIDE_URL = process.env.RIDE_SERVICE_URL || 'http://ride-service:3001';
const LOCATION_URL = process.env.LOCATION_SERVICE_URL || 'http://location-service:3002';
const FARE_URL = process.env.FARE_SERVICE_URL || 'http://fare-service:3003';


function requireAuth(req, res, next) {
  if (req.path.startsWith('/auth') || req.path === '/health') {
    return next();
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Missing access token' });
  }

  try {
    const payload = verifyAccessToken(token);
    req.headers['x-user-id'] = payload.sub;
    req.headers['x-user-role'] = payload.role;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid access token' });
  }
}

const makeProxy = (target) =>
  createProxyMiddleware({
    target,
    changeOrigin: true,
    pathRewrite: (path) => path,
    logLevel: 'warn',
  });

app.use((req, res, next) => {
  if (req.path.startsWith('/auth')) {
    return authLimiter(req, res, next);
  }
  return generalLimiter(req, res, next);
});
app.use(requireAuth);
app.use('/rides', makeProxy(RIDE_URL));
app.use('/health', makeProxy(RIDE_URL));
app.use('/drivers', makeProxy(LOCATION_URL));
app.use('/fares', makeProxy(FARE_URL));
app.use('/auth', makeProxy('http://auth-service:3010'));

app.get('/', (req, res) => {
  res.json({
    message: 'Ride Hailing API Gateway',
    routes: {
      rides: '/rides',
      drivers: '/drivers',
      fares: '/fares',
      health: '/health',
    },
  });
});

const PORT = process.env.PORT || 80;
app.listen(PORT, () => {
  console.log(`Gateway listening on port ${PORT}`);
});
