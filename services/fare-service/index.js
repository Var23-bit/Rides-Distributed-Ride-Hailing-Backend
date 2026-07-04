const express = require('express');
const cors = require('cors');
const { rideRequestSchema } = require('../../shared/validation');

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

const PORT = process.env.PORT || 3003;

// Base fare mechanics
const BASE_FARE = 2.50;
const PER_KM_RATE = 1.25;
const PER_MIN_RATE = 0.30;
const SPEED = 30; // approx 30km/h in city

// Fast Haversine formula for distance
function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // Radius of the earth in km
  const dLat = deg2rad(lat2 - lat1);  // deg2rad below
  const dLon = deg2rad(lon2 - lon1); 
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * 
    Math.sin(dLon/2) * Math.sin(dLon/2)
    ; 
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
  const d = R * c; // Distance in km
  return d;
}

function deg2rad(deg) {
  return deg * (Math.PI/180);
}

app.post('/fares/estimate', (req, res) => {
  const parsed = rideRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { pickup, dropoff } = parsed.data;

  try {
    const distKm = getDistanceFromLatLonInKm(pickup.lat, pickup.lng, dropoff.lat, dropoff.lng);
    const estTimeMins = (distKm / SPEED) * 60;
    
    let totalFare = BASE_FARE + (distKm * PER_KM_RATE) + (estTimeMins * PER_MIN_RATE);
    
    // Simple rounding
    totalFare = Math.round(totalFare * 100) / 100;

    res.status(200).json({
      estimate: totalFare,
      distance_km: distKm,
      time_mins: estTimeMins,
      currency: 'USD'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/metrics', (req, res) => res.status(200).json(metrics));

app.listen(PORT, () => {
  console.log(`Fare Service listening on port ${PORT}`);
});
