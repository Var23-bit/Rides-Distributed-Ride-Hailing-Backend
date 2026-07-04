const { z } = require('zod');

const coordinateSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const rideRequestSchema = z.object({
  pickup: coordinateSchema,
  dropoff: coordinateSchema,
});

const locationSchema = z.object({
  driverId: z.string().min(1),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

module.exports = {
  coordinateSchema,
  rideRequestSchema,
  locationSchema,
};
