# Distributed Ride-Hailing Backend

A scalable, microservices-based backend system for a ride-hailing platform built with Node.js, PostgreSQL (PostGIS), Redis, Socket.io, and Docker.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js |
| Framework | Express.js |
| Primary Database | PostgreSQL + PostGIS |
| Cache Layer | Redis |
| Real-Time | Socket.io |
| Containerization | Docker / Docker Compose |

---

## Features

- Real-time ride request handling and driver matching
- Geospatial nearest-driver lookup within 5km radius in under 100ms
- Live location tracking for riders and drivers via WebSockets
- Redis caching for active driver coordinates to reduce DB load
- Async event-driven trip lifecycle (Request → Accept → Start → End)
- Fare estimation and final fare calculation
- Fully containerized with Docker Compose

---

## Project Structure
```
ride-hailing-backend/
├── services/
│   ├── ride-service/        # Ride requests, matching, trip state
│   ├── location-service/    # WebSocket connections, GPS updates
│   ├── fare-service/        # Fare estimation and calculation
│   ├── payment-service/     # Payment processing (async)
│   └── history-service/     # Trip history logging (async)
├── shared/
│   ├── db/                  # PostgreSQL connection and migrations
│   ├── cache/               # Redis client setup
│   └── events/              # Async event system
├── docker-compose.yml
├── .env.example
└── README.md
```
---
## API Reference

### Rides

| Method | Endpoint | Description |
|---|---|---|
| POST | /rides/request | Create a new ride request |
| GET | /rides/:id | Get trip details by ID |
| PATCH | /rides/:id/status | Update trip status |

### Drivers

| Method | Endpoint | Description |
|---|---|---|
| GET | /drivers/nearby | Find available drivers within 5km radius |
| POST | /drivers/location | Update driver GPS coordinates |

### Fares

| Method | Endpoint | Description |
|---|---|---|
| GET | /fares/estimate | Get fare estimate for a route |

---

## WebSocket Events

| Event | Direction | Description |
|---|---|---|
| `driver:location:update` | Driver → Server | Driver pushes GPS coordinates |
| `rider:driver:location` | Server → Rider | Server pushes driver location to rider |
| `trip:status:change` | Server → Both | Notifies both parties of trip state change |
| `trip:request` | Server → Driver | New ride request sent to matched driver |

---

## Trip Lifecycle
```
REQUEST → ACCEPT → START → END
   |          |        |      |
Created   Driver    Trip   Fare +
          Matched  Begins  Payment
                          Triggered
```

Each state transition fires an async event to the Payment and History services to keep data consistent without tight coupling.

---

## Geospatial Queries

Driver matching uses PostgreSQL with the PostGIS extension. Nearby drivers are queried using `ST_DWithin` on indexed geometry columns:
```sql
SELECT driver_id, ST_Distance(location, ST_MakePoint($1, $2)::geography) AS distance
FROM drivers
WHERE is_available = true
  AND ST_DWithin(location, ST_MakePoint($1, $2)::geography, 5000)
ORDER BY distance ASC
LIMIT 5;
```

Results consistently return in under 100ms due to spatial indexing.

---

## Caching Strategy

Active driver GPS coordinates are stored in Redis with a short TTL:
```
Key:   driver:location:{driver_id}
Value: { lat, lng, updated_at }
TTL:   30 seconds
```

During driver matching, coordinates are read from Redis first. The primary PostgreSQL database is only hit for persistent trip and user data, keeping it performant under peak load.

---
