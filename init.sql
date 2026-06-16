-- init.sql
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Drivers Table
CREATE TABLE IF NOT EXISTS drivers (
    driver_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    current_coords GEOMETRY(Point, 4326),
    is_available BOOLEAN DEFAULT false,
    vehicle_info JSONB,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Trips Table
CREATE TABLE IF NOT EXISTS trips (
    trip_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id VARCHAR(255) NOT NULL,
    driver_id UUID REFERENCES drivers(driver_id),
    pickup_coords GEOMETRY(Point, 4326) NOT NULL,
    dropoff_coords GEOMETRY(Point, 4326) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'REQUESTED',
    fare DECIMAL(10, 2),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Events Log Table (for History Service)
CREATE TABLE IF NOT EXISTS events_log (
    event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trip_id UUID REFERENCES trips(trip_id),
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Geo-spatial Indexing
CREATE INDEX IF NOT EXISTS drivers_geom_idx ON drivers USING GIST (current_coords);
CREATE INDEX IF NOT EXISTS trips_pickup_geom_idx ON trips USING GIST (pickup_coords);
CREATE INDEX IF NOT EXISTS trips_dropoff_geom_idx ON trips USING GIST (dropoff_coords);

-- Regular Indexing
CREATE INDEX IF NOT EXISTS idx_trips_driver_id ON trips(driver_id);
CREATE INDEX IF NOT EXISTS idx_events_log_trip_id ON events_log(trip_id);
