const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { z } = require('zod');
const { hashPassword, comparePassword, createAccessToken, createRefreshToken, verifyRefreshToken, hashRefreshToken } = require('../../shared/auth');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://admin:password@localhost:5432/ridehail',
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost') ? { rejectUnauthorized: false } : false,
});

const registerSchema = z.object({
  phone: z.string().min(4),
  email: z.string().email(),
  password: z.string().min(6),
  role: z.enum(['rider', 'driver']).default('rider'),
  name: z.string().min(2),
  licenseNumber: z.string().optional(),
  vehicleInfo: z.any().optional(),
});

const loginSchema = z.object({ phone: z.string().min(4), password: z.string().min(6) });
const refreshSchema = z.object({ refreshToken: z.string().min(10) });

async function getDb() {
  return pool;
}

app.post('/auth/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { phone, email, password, role, name, licenseNumber, vehicleInfo } = parsed.data;
  const db = await getDb();
  try {
    const passwordHash = await hashPassword(password);
    const userRes = await db.query(`
      INSERT INTO users (phone, email, password_hash, role, name)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING user_id, role, phone, email, name
    `, [phone, email, passwordHash, role, name]);

    const user = userRes.rows[0];
    if (role === 'driver') {
      await db.query(`
        INSERT INTO driver_profiles (user_id, license_number, vehicle_info, is_verified, is_available)
        VALUES ($1, $2, $3, false, true)
      `, [user.user_id, licenseNumber || null, vehicleInfo || null]);
    }

    const accessToken = createAccessToken({ sub: user.user_id, role: user.role, phone: user.phone });
    const refreshToken = createRefreshToken({ sub: user.user_id, role: user.role });
    const refreshHash = hashRefreshToken(refreshToken);
    await db.query(`
      INSERT INTO refresh_tokens (user_id, token_hash, revoked)
      VALUES ($1, $2, false)
    `, [user.user_id, refreshHash]);

    res.status(201).json({ accessToken, refreshToken, user });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/auth/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const { phone, password } = parsed.data;
  const db = await getDb();
  try {
    const result = await db.query(`SELECT user_id, role, phone, email, name, password_hash FROM users WHERE phone = $1`, [phone]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid phone or password' });
    }
    const user = result.rows[0];
    const valid = await comparePassword(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid phone or password' });
    }

    const accessToken = createAccessToken({ sub: user.user_id, role: user.role, phone: user.phone });
    const refreshToken = createRefreshToken({ sub: user.user_id, role: user.role });
    const refreshHash = hashRefreshToken(refreshToken);
    await db.query(`INSERT INTO refresh_tokens (user_id, token_hash, revoked) VALUES ($1, $2, false)`, [user.user_id, refreshHash]);
    res.json({ accessToken, refreshToken, user: { user_id: user.user_id, role: user.role, phone: user.phone, email: user.email, name: user.name } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/auth/refresh', async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const db = await getDb();
  try {
    const token = parsed.data.refreshToken;
    const payload = verifyRefreshToken(token);
    const refreshHash = hashRefreshToken(token);
    const tokenResult = await db.query(`SELECT user_id, revoked FROM refresh_tokens WHERE token_hash = $1`, [refreshHash]);
    if (tokenResult.rows.length === 0 || tokenResult.rows[0].revoked) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }
    const accessToken = createAccessToken({ sub: payload.sub, role: payload.role });
    res.json({ accessToken });
  } catch (error) {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

app.post('/auth/logout', async (req, res) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0].message });
  }

  const db = await getDb();
  try {
    const refreshHash = hashRefreshToken(parsed.data.refreshToken);
    await db.query(`UPDATE refresh_tokens SET revoked = true WHERE token_hash = $1`, [refreshHash]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Logout failed' });
  }
});

app.get('/health', (req, res) => res.status(200).send('OK'));

app.listen(process.env.PORT || 3010, () => console.log('Auth Service listening'));
