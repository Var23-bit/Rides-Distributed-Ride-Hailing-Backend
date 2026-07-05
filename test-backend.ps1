# =========================================================
# Ride-Hailing Backend - End-to-End Test Script
# Run from: C:\ride-hailing-backend
# Usage:    .\test-backend.ps1
# =========================================================

$ErrorActionPreference = "Continue"
$GATEWAY = "http://localhost:8081"
$results = @()

function Test-Step {
    param(
        [string]$Name,
        [scriptblock]$Action
    )
    Write-Host "`n--- $Name ---" -ForegroundColor Cyan
    try {
        $output = & $Action
        Write-Host "PASS: $Name" -ForegroundColor Green
        $script:results += [PSCustomObject]@{ Step = $Name; Status = "PASS"; Detail = "" }
        return $output
    } catch {
        $msg = $_.Exception.Message
        Write-Host "FAIL: $Name -> $msg" -ForegroundColor Red
        $script:results += [PSCustomObject]@{ Step = $Name; Status = "FAIL"; Detail = $msg }
        return $null
    }
}

# Use unique phone numbers each run so re-running the script doesn't hit unique constraint errors
$suffix = Get-Random -Minimum 1000 -Maximum 9999
$riderPhone = "9$suffix" + "0000"
$driverPhone = "8$suffix" + "0000"

# -----------------------------
# 1. Containers up
# -----------------------------
Test-Step "Docker containers running" {
    $ps = docker ps --format "{{.Names}}: {{.Status}}"
    Write-Host $ps
    if ($ps -match "Exited") { throw "One or more containers have exited" }
}

# -----------------------------
# 2. Gateway health
# -----------------------------
Test-Step "Gateway /health" {
    $r = Invoke-RestMethod -Uri "$GATEWAY/health" -Method Get
    Write-Host "Response: $r"
}

# -----------------------------
# 3. Register rider
# -----------------------------
$riderToken = $null
$riderResp = Test-Step "Register rider" {
    $body = @{
        phone = $riderPhone
        email = "rider$suffix@test.com"
        password = "password123"
        name = "Test Rider"
        role = "rider"
    } | ConvertTo-Json
    $r = Invoke-RestMethod -Uri "$GATEWAY/auth/register" -Method Post -ContentType "application/json" -Body $body
    if (-not $r.accessToken) { throw "No accessToken returned" }
    Write-Host "Rider registered: $($r.user.user_id)"
    $r
}
if ($riderResp) { $riderToken = $riderResp.accessToken }

# -----------------------------
# 4. Register driver
# -----------------------------
$driverToken = $null
$driverUserId = $null
$driverResp = Test-Step "Register driver" {
    $body = @{
        phone = $driverPhone
        email = "driver$suffix@test.com"
        password = "password123"
        name = "Test Driver"
        role = "driver"
        licenseNumber = "MP01AB$suffix"
    } | ConvertTo-Json
    $r = Invoke-RestMethod -Uri "$GATEWAY/auth/register" -Method Post -ContentType "application/json" -Body $body
    if (-not $r.accessToken) { throw "No accessToken returned" }
    Write-Host "Driver registered: $($r.user.user_id)"
    $r
}
if ($driverResp) {
    $driverToken = $driverResp.accessToken
    $driverUserId = $driverResp.user.user_id
}

# -----------------------------
# 5. Login as rider (verify login works independent of register)
# -----------------------------
$riderRefreshToken = $null
$loginResp = Test-Step "Login as rider" {
    $body = @{ phone = $riderPhone; password = "password123" } | ConvertTo-Json
    $r = Invoke-RestMethod -Uri "$GATEWAY/auth/login" -Method Post -ContentType "application/json" -Body $body
    if (-not $r.accessToken) { throw "No accessToken returned on login" }
    $r
}
if ($loginResp) { $riderRefreshToken = $loginResp.refreshToken }

# -----------------------------
# 5a. Refresh access token
# -----------------------------
Test-Step "Refresh access token" {
    if (-not $riderRefreshToken) { throw "No refresh token available from login step" }
    $body = @{ refreshToken = $riderRefreshToken } | ConvertTo-Json
    $r = Invoke-RestMethod -Uri "$GATEWAY/auth/refresh" -Method Post -ContentType "application/json" -Body $body
    if (-not $r.accessToken) { throw "No accessToken returned from refresh" }
}

# -----------------------------
# 5b. Logout (revoke refresh token)
# -----------------------------
Test-Step "Logout" {
    if (-not $riderRefreshToken) { throw "No refresh token available from login step" }
    $body = @{ refreshToken = $riderRefreshToken } | ConvertTo-Json
    $r = Invoke-RestMethod -Uri "$GATEWAY/auth/logout" -Method Post -ContentType "application/json" -Body $body
    if (-not $r.success) { throw "Logout did not return success" }
}

# -----------------------------
# 5c. Confirm refresh token is rejected after logout
# -----------------------------
Test-Step "Refresh rejected after logout" {
    if (-not $riderRefreshToken) { throw "No refresh token available from login step" }
    $body = @{ refreshToken = $riderRefreshToken } | ConvertTo-Json
    try {
        Invoke-RestMethod -Uri "$GATEWAY/auth/refresh" -Method Post -ContentType "application/json" -Body $body
        throw "Expected 401 but refresh succeeded after logout"
    } catch {
        if ($_.Exception.Response.StatusCode.value__ -ne 401) {
            throw "Expected 401, got $($_.Exception.Response.StatusCode.value__)"
        }
    }
}

# -----------------------------
# 6. Reject request with no token
# -----------------------------
Test-Step "Protected route rejects missing token" {
    try {
        Invoke-RestMethod -Uri "$GATEWAY/rides/request" -Method Post -ContentType "application/json" -Body "{}"
        throw "Expected 401 but request succeeded"
    } catch {
        if ($_.Exception.Response.StatusCode.value__ -ne 401) {
            throw "Expected 401, got $($_.Exception.Response.StatusCode.value__)"
        }
    }
}

# -----------------------------
# 7a. Clean stale driver location test data from Redis (avoids picking up drivers from previous runs)
# -----------------------------
Test-Step "Clean stale Redis driver data" {
    docker exec ride-hailing-backend-redis-1 redis-cli DEL driver_locations driver_timestamps | Out-Null
}

# -----------------------------
# 7b. Register driver location via location-service (writes to Redis GEO + Postgres)
# -----------------------------
Test-Step "Register driver location" {
    $body = @{
        driverId = $driverUserId
        lat = 23.2599
        lng = 77.4126
    } | ConvertTo-Json
    $r = Invoke-RestMethod -Uri "$GATEWAY/drivers/location" -Method Post -ContentType "application/json" -Headers @{ Authorization = "Bearer $driverToken" } -Body $body
    if (-not $r.success) { throw "Location update did not return success" }
}

# -----------------------------
# 8. Request a ride as rider
# -----------------------------
$tripId = $null
$rideResp = Test-Step "Request a ride" {
    $body = @{
        pickup = @{ lat = 23.2599; lng = 77.4126 }
        dropoff = @{ lat = 23.2320; lng = 77.4014 }
    } | ConvertTo-Json
    $r = Invoke-RestMethod -Uri "$GATEWAY/rides/request" -Method Post -ContentType "application/json" -Headers @{ Authorization = "Bearer $riderToken" } -Body $body
    if (-not $r.tripId) { throw "No tripId returned" }
    Write-Host "Trip created: $($r.tripId), driver: $($r.driverId)"
    $r
}
if ($rideResp) { $tripId = $rideResp.tripId }

# -----------------------------
# 9. Get trip details
# -----------------------------
if ($tripId) {
    Test-Step "Get trip details" {
        $r = Invoke-RestMethod -Uri "$GATEWAY/rides/$tripId" -Method Get -Headers @{ Authorization = "Bearer $riderToken" }
        if ($r.status -ne "REQUESTED") { throw "Expected status REQUESTED, got $($r.status)" }
    }

    # -----------------------------
    # 10. Driver accepts trip
    # -----------------------------
    Test-Step "Driver accepts trip" {
        $r = Invoke-RestMethod -Uri "$GATEWAY/rides/$tripId/accept" -Method Post -Headers @{ Authorization = "Bearer $driverToken" }
        if ($r.trip.status -ne "ACCEPTED") { throw "Expected ACCEPTED, got $($r.trip.status)" }
    }

    # -----------------------------
    # 11. Driver starts trip
    # -----------------------------
    Test-Step "Driver starts trip" {
        $body = @{ status = "STARTED" } | ConvertTo-Json
        $r = Invoke-RestMethod -Uri "$GATEWAY/rides/$tripId/status" -Method Patch -ContentType "application/json" -Headers @{ Authorization = "Bearer $driverToken" } -Body $body
        if ($r.trip.status -ne "STARTED") { throw "Expected STARTED, got $($r.trip.status)" }
    }

    # -----------------------------
    # 12. Driver ends trip
    # -----------------------------
    Test-Step "Driver ends trip" {
        $body = @{ status = "ENDED" } | ConvertTo-Json
        $r = Invoke-RestMethod -Uri "$GATEWAY/rides/$tripId/status" -Method Patch -ContentType "application/json" -Headers @{ Authorization = "Bearer $driverToken" } -Body $body
        if ($r.trip.status -notin @("ENDED", "PENDING_FARE")) { throw "Expected ENDED or PENDING_FARE, got $($r.trip.status)" }
        Write-Host "Final fare: $($r.trip.fare)"
    }
} else {
    Write-Host "Skipping trip lifecycle steps - ride request failed" -ForegroundColor Yellow
}

# =========================================================
# Helper: spin up a fresh driver + ride request for isolated
# scenario testing (reject / cancel), so these don't collide
# with the trip already carried through accept/start/end above.
# =========================================================
function New-TestRide {
    param([string]$Label)

    docker exec ride-hailing-backend-redis-1 redis-cli DEL driver_locations driver_timestamps | Out-Null

    $localSuffix = Get-Random -Minimum 1000 -Maximum 9999
    $dPhone = "6$localSuffix" + "0000"

    $dBody = @{
        phone = $dPhone
        email = "driver$Label$localSuffix@test.com"
        password = "password123"
        name = "Test Driver $Label"
        role = "driver"
        licenseNumber = "MP01$Label$localSuffix"
    } | ConvertTo-Json
    $dResp = Invoke-RestMethod -Uri "$GATEWAY/auth/register" -Method Post -ContentType "application/json" -Body $dBody
    $dToken = $dResp.accessToken
    $dUserId = $dResp.user.user_id

    $locBody = @{ driverId = $dUserId; lat = 23.2599; lng = 77.4126 } | ConvertTo-Json
    Invoke-RestMethod -Uri "$GATEWAY/drivers/location" -Method Post -ContentType "application/json" -Headers @{ Authorization = "Bearer $dToken" } -Body $locBody | Out-Null

    $rideBody = @{
        pickup = @{ lat = 23.2599; lng = 77.4126 }
        dropoff = @{ lat = 23.2320; lng = 77.4014 }
    } | ConvertTo-Json
    $ride = Invoke-RestMethod -Uri "$GATEWAY/rides/request" -Method Post -ContentType "application/json" -Headers @{ Authorization = "Bearer $riderToken" } -Body $rideBody

    return @{ TripId = $ride.tripId; DriverToken = $dToken; DriverId = $dUserId }
}

# -----------------------------
# 13. Driver rejects a trip
# -----------------------------
$rejectCtx = Test-Step "Set up ride for reject scenario" {
    New-TestRide -Label "Rej"
}
if ($rejectCtx) {
    Test-Step "Driver rejects trip" {
        $r = Invoke-RestMethod -Uri "$GATEWAY/rides/$($rejectCtx.TripId)/reject" -Method Post -Headers @{ Authorization = "Bearer $($rejectCtx.DriverToken)" }
        if ($r.trip.status -ne "CANCELED") { throw "Expected CANCELED, got $($r.trip.status)" }
    }
}

# -----------------------------
# 14. Rider cancels a trip before it's accepted
# -----------------------------
$cancelCtx = Test-Step "Set up ride for cancel scenario" {
    New-TestRide -Label "Can"
}
if ($cancelCtx) {
    Test-Step "Rider cancels trip" {
        $r = Invoke-RestMethod -Uri "$GATEWAY/rides/$($cancelCtx.TripId)/cancel" -Method Post -Headers @{ Authorization = "Bearer $riderToken" }
        if ($r.trip.status -ne "CANCELED") { throw "Expected CANCELED, got $($r.trip.status)" }
    }

    # -----------------------------
    # 15. Cannot cancel an already-canceled trip (state machine guard)
    # -----------------------------
    Test-Step "Cannot cancel already-canceled trip" {
        try {
            Invoke-RestMethod -Uri "$GATEWAY/rides/$($cancelCtx.TripId)/cancel" -Method Post -Headers @{ Authorization = "Bearer $riderToken" }
            throw "Expected 409 but cancel succeeded twice"
        } catch {
            if ($_.Exception.Response.StatusCode.value__ -ne 409) {
                throw "Expected 409, got $($_.Exception.Response.StatusCode.value__)"
            }
        }
    }
}

# -----------------------------
# Summary
# -----------------------------
Write-Host "`n=========================================="  -ForegroundColor Yellow
Write-Host "TEST SUMMARY" -ForegroundColor Yellow
Write-Host "=========================================="  -ForegroundColor Yellow
$results | Format-Table -AutoSize

$failCount = ($results | Where-Object { $_.Status -eq "FAIL" }).Count
$passCount = ($results | Where-Object { $_.Status -eq "PASS" }).Count
Write-Host "`n$passCount passed, $failCount failed" -ForegroundColor $(if ($failCount -eq 0) { "Green" } else { "Red" })
