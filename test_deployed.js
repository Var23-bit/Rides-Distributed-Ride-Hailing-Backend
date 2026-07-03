const axios = require('axios');
axios.defaults.headers.common['Bypass-Tunnel-Reminder'] = 'true';

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Configuration: Pass these via environment variables or CLI
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:80'; 
// If hitting services directly (for debugging)
const RIDE_SERVICE = process.env.RIDE_SERVICE_URL || 'http://localhost:3001';
const LOCATION_SERVICE = process.env.LOCATION_SERVICE_URL || 'http://localhost:3002';

async function runFlow() {
  console.log('=== Starting Deployed Integration Test Flow ===');
  console.log(`Using RIDE_SERVICE: ${RIDE_SERVICE}`);
  console.log(`Using LOCATION_SERVICE: ${LOCATION_SERVICE}`);
  
  const driverId = 'e20be6eb-3ed2-4bae-a6de-7b0b6bc7dd48';
  const riderId = 'rider-deploy-test-' + Math.floor(Math.random() * 1000);
  
  const pickup = { lat: 40.7128, lng: -74.0060 }; // NYC
  const dropoff = { lat: 40.7306, lng: -73.9866 }; // A bit further in NYC

  try {
    // 1. Update driver location (Mock a driver coming online)
    console.log('1. Mocking driver location update...');
    await axios.post(`${LOCATION_SERVICE}/drivers/location`, {
      driverId,
      lat: pickup.lat,
      lng: pickup.lng
    });
    console.log('   Driver location updated.');

    // Wait for async PostGIS update
    await sleep(1000);

    // 2. Request a ride
    console.log('2. Requesting a ride...');
    const startReq = Date.now();
    const rideRes = await axios.post(`${RIDE_SERVICE}/rides/request`, {
      riderId, pickup, dropoff
    });
    const matchTime = Date.now() - startReq;
    
    console.log(`   Ride matched! Trip ID: ${rideRes.data.tripId}, Matched Driver: ${rideRes.data.driverId}`);
    
    const tripId = rideRes.data.tripId;

    // 3. Progress trip state
    console.log('3. Progressing trip state: ACCEPTED');
    await axios.patch(`${RIDE_SERVICE}/rides/${tripId}/status`, { status: 'ACCEPTED' });
    
    await sleep(1000); 
    
    console.log('4. Progressing trip state: STARTED');
    await axios.patch(`${RIDE_SERVICE}/rides/${tripId}/status`, { status: 'STARTED' });
    
    await sleep(1000); 
    
    console.log('5. Progressing trip state: ENDED');
    const endRes = await axios.patch(`${RIDE_SERVICE}/rides/${tripId}/status`, { status: 'ENDED' });
    
    console.log(`   Trip ENDED! Final Fare computed: $${endRes.data.trip.fare}`);

    console.log('=== Integration Test Flow Complete ===');
    console.log('Deployment looks STABLE.');
  } catch (err) {
    console.error('Test Failed:', err.response ? err.response.data : err.message);
    process.exit(1);
  }
}

runFlow();
