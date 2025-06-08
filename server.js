import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import axiosRetry from 'axios-retry';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const API_KEY = process.env.GNEWS_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'defaultsecret';

const prisma = new PrismaClient();

if (!API_KEY) {
  console.error('❌ ERROR: GNEWS_API_KEY is not set in environment variables!');
  process.exit(1);
}

axiosRetry(axios, {
  retries: 3,
  retryDelay: axiosRetry.exponentialDelay,
  retryCondition: (err) =>
    axiosRetry.isNetworkOrIdempotentRequestError(err) || err.code === 'ETIMEDOUT',
});

// Middleware
app.use(cors());
app.use(express.json());

// JWT Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token provided' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: 'Invalid token' });
    req.user = user;
    next();
  });
};

// ========== DEBUG /api/ping ROUTE ==========
app.get('/api/ping', async (req, res) => {
  try {
    await axios.get('https://gnews.io');
    res.status(200).json({ success: true, message: 'GNews API reachable' });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      code: error.code,
    });
  }
});

// ========== AUTH ROUTES ==========

// Register
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ message: 'Name, email, and password are required' });

  try {
    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists) return res.status(400).json({ message: 'Email already registered' });

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = await prisma.user.create({
      data: { name, email, password: hashedPassword },
      select: { id: true, name: true, email: true },
    });

    res.status(201).json({ message: 'User registered', user: newUser });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ message: 'Email and password are required' });

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(400).json({ message: 'Invalid email or password' });

    const validPass = await bcrypt.compare(password, user.password);
    if (!validPass) return res.status(400).json({ message: 'Invalid email or password' });

    const token = jwt.sign(
      { id: user.id, name: user.name, email: user.email },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Profile
app.get('/api/profile', authenticateToken, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, name: true, email: true },
    });
    if (!user) return res.status(404).json({ message: 'User not found' });

    res.json(user);
  } catch (error) {
    console.error('Profile error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ========== BOOKMARK ROUTES ==========

app.post('/api/bookmarks', authenticateToken, async (req, res) => {
  const { title, description, url, image, publishedAt, source } = req.body;
  if (!title || !url)
    return res.status(400).json({ message: 'Title and URL are required' });

  try {
    const exists = await prisma.bookmark.findFirst({
      where: { userId: req.user.id, url },
    });
    if (exists) return res.status(409).json({ message: 'Bookmark already exists' });

    await prisma.bookmark.create({
      data: {
        userId: req.user.id,
        title,
        description,
        url,
        image,
        publishedAt: publishedAt ? new Date(publishedAt) : null,
        source,
      },
    });

    res.status(201).json({ message: 'Bookmark added' });
  } catch (error) {
    console.error('Bookmark add error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.get('/api/bookmarks', authenticateToken, async (req, res) => {
  try {
    const bookmarks = await prisma.bookmark.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
    });
    res.json(bookmarks);
  } catch (error) {
    console.error('Bookmark fetch error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.delete('/api/bookmarks', authenticateToken, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ message: 'Bookmark URL required' });

  try {
    const deleted = await prisma.bookmark.deleteMany({
      where: { userId: req.user.id, url },
    });
    if (deleted.count === 0) return res.status(404).json({ message: 'Bookmark not found' });

    res.json({ message: 'Bookmark deleted' });
  } catch (error) {
    console.error('Bookmark delete error:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// ========== NEWS API ROUTE ==========

app.get('/api/news', async (req, res) => {
  try {
    const {
      mode = 'top-headlines',
      keyword = '',
      date = '',
      category = 'general',
      source = '',
      language = 'en',
      country = 'in',
      sortBy = 'publishedAt',
    } = req.query;

    let url = new URL(
      mode === 'top-headlines'
        ? 'https://gnews.io/api/v4/top-headlines'
        : 'https://gnews.io/api/v4/search'
    );

    const params = {
      token: API_KEY,
      lang: language,
    };

    if (mode === 'top-headlines') {
      params.country = country;
      params.topic = category;
      if (source) params.source = source;
    } else {
      if (!keyword) {
        return res.status(400).json({ error: 'Keyword is required for search mode.' });
      }
      params.q = keyword;
      if (date) {
        params.from = `${date}T00:00:00Z`;
        params.to = `${date}T23:59:59Z`;
      }
      params.sortby = sortBy;
    }

    const response = await axios.get(url.toString(), {
      params,
      timeout: 15000, // 15 seconds
    });

    res.json(response.data);
  } catch (error) {
    console.error('Error in /api/news:', error.message || error);
    res.status(500).json({ error: 'Failed to fetch news from GNews.' });
  }
});

// ========== IMAGE PROXY ROUTE ==========

app.get('/api/image-proxy', async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) return res.status(400).send('Missing image URL');

  try {
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const contentType = response.headers['content-type'] || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.send(response.data);
  } catch (error) {
    console.error('Error proxying image:', error.message);
    res.status(500).send('Failed to fetch image');
  }
});

// ========== START SERVER ==========

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
