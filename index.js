const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');

const app = express();

// Security middleware
app.use(helmet({
  contentSecurityPolicy: false,
}));
app.use(compression()); // Compress responses
app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? process.env.CLIENT_URL : '*',
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: { status: false, message: 'Too many requests, please try again later.' }
});

app.use('/api/', limiter);

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Set view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// User agents list with rotation
const ua_list = [
  "Mozilla/5.0 (Linux; Android 10; Wildfire E Lite) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/105.0.5195.136 Mobile Safari/537.36[FBAN/EMA;FBLC/en_US;FBAV/298.0.0.10.115;]",
  "Mozilla/5.0 (Linux; Android 11; KINGKONG 5 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/87.0.4280.141 Mobile Safari/537.36[FBAN/EMA;FBLC/fr_FR;FBAV/320.0.0.12.108;]",
  "Mozilla/5.0 (Linux; Android 11; G91 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/106.0.5249.126 Mobile Safari/537.36[FBAN/EMA;FBLC/fr_FR;FBAV/325.0.1.4.108;]"
];

// In-memory store with persistence
let shareHistory = [];
let activeShares = new Map();

// Load history from file on startup
(async () => {
  try {
    const data = await fs.readFile('./history.json', 'utf8');
    shareHistory = JSON.parse(data);
  } catch (err) {
    console.log('No existing history found, starting fresh');
    shareHistory = [];
  }
})();

// Save history periodically
setInterval(async () => {
  try {
    await fs.writeFile('./history.json', JSON.stringify(shareHistory, null, 2));
  } catch (err) {
    console.error('Error saving history:', err);
  }
}, 60000); // Save every minute

// Token extraction function with retries
async function extract_token(cookie, ua, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.get(
        "https://business.facebook.com/business_locations",
        {
          headers: {
            "user-agent": ua,
            "referer": "https://www.facebook.com/",
            "Cookie": cookie,
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "accept-language": "en-US,en;q=0.5",
            "accept-encoding": "gzip, deflate, br",
            "dnt": "1",
            "connection": "keep-alive",
            "upgrade-insecure-requests": "1"
          },
          timeout: 15000,
          maxRedirects: 5
        }
      );

      // Multiple token patterns for better extraction
      const patterns = [
        /(EAAG\w+)/,
        /(EAA[A-Za-z0-9]+)/,
        /access_token=([^&\s"]+)/
      ];
      
      for (const pattern of patterns) {
        const match = response.data.match(pattern);
        if (match) return match[1];
      }
      
      return null;
    } catch (err) {
      console.error(`Token extraction attempt ${i + 1} failed:`, err.message);
      if (i === retries - 1) return null;
      await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1))); // Exponential backoff
    }
  }
}

// Async share function with better error handling
async function performShare(post_link, token, cookie, ua, shareId, totalLimit) {
  const results = [];
  const startTime = Date.now();
  
  for (let i = 0; i < totalLimit; i++) {
    // Check if share was cancelled
    if (activeShares.get(shareId) === 'cancelled') {
      console.log(`Share ${shareId} was cancelled`);
      break;
    }

    try {
      const response = await axios.post(
        "https://graph.facebook.com/v18.0/me/feed",
        null,
        {
          params: {
            link: post_link,
            access_token: token,
            published: 0
          },
          headers: {
            "user-agent": ua,
            "Cookie": cookie,
            "accept": "application/json, text/plain, */*",
            "accept-language": "en-US,en;q=0.9",
            "origin": "https://business.facebook.com",
            "referer": "https://business.facebook.com/"
          },
          timeout: 15000
        }
      );

      if (response.data && response.data.id) {
        results.push({ success: true, id: response.data.id });
        
        // Update progress
        const item = shareHistory.find(h => h.id === shareId);
        if (item) {
          item.success = results.length;
          item.progress = Math.round((results.length / totalLimit) * 100);
        }
      }
      
      // Small delay between requests
      await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 500));
      
    } catch (err) {
      console.error(`Share attempt ${i + 1} failed:`, err.message);
      results.push({ success: false, error: err.message });
      
      // If rate limited, wait longer
      if (err.response && err.response.status === 429) {
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
      
      // Don't break immediately, try to continue
    }
  }
  
  const endTime = Date.now();
  const duration = (endTime - startTime) / 1000; // in seconds
  
  return {
    success: results.filter(r => r.success).length,
    failed: results.filter(r => !r.success).length,
    total: results.length,
    duration
  };
}

// Routes
app.get("/", (req, res) => {
  res.render("index", { 
    title: 'Facebook Share Tool',
    year: new Date().getFullYear()
  });
});

app.get("/share", (req, res) => {
  res.render("share", { 
    history: shareHistory.slice(-20).reverse(),
    title: 'Share History',
    year: new Date().getFullYear()
  });
});

// API endpoint for sharing
app.post("/api/share", async (req, res) => {
  const shareId = Date.now();
  
  try {
    const { cookie, link: post_link, limit } = req.body;
    const limitNum = parseInt(limit, 10);

    // Enhanced validation
    if (!cookie || !post_link || !limitNum) {
      return res.status(400).json({
        status: false,
        message: "Missing required fields: cookie, link, and limit are required.",
        code: 'MISSING_FIELDS'
      });
    }

    if (limitNum > 1000) {
      return res.status(400).json({
        status: false,
        message: "Maximum limit is 1000 shares per request.",
        code: 'LIMIT_EXCEEDED'
      });
    }

    // Validate cookie format (basic check)
    if (!cookie.includes('=')) {
      return res.status(400).json({
        status: false,
        message: "Invalid cookie format.",
        code: 'INVALID_COOKIE'
      });
    }

    // Validate URL
    try {
      new URL(post_link);
    } catch {
      return res.status(400).json({
        status: false,
        message: "Invalid URL format.",
        code: 'INVALID_URL'
      });
    }

    const ua = ua_list[Math.floor(Math.random() * ua_list.length)];
    
    // Extract token with progress
    res.json({
      status: 'processing',
      message: 'Extracting token...',
      share_id: shareId,
      stage: 'token_extraction'
    });

    const token = await extract_token(cookie, ua);

    if (!token) {
      return res.status(400).json({
        status: false,
        message: "Token extraction failed. Check your cookie validity.",
        code: 'TOKEN_EXTRACTION_FAILED'
      });
    }

    const startTime = new Date();

    // Save initial history
    const historyEntry = {
      id: shareId,
      link: post_link,
      requested: limitNum,
      success: 0,
      failed: 0,
      status: 'processing',
      progress: 0,
      startTime,
      endTime: null,
      token
    };
    
    shareHistory.push(historyEntry);
    activeShares.set(shareId, 'active');

    // Perform sharing asynchronously
    const shareResults = await performShare(post_link, token, cookie, ua, shareId, limitNum);

    // Finalize history
    const finalItem = shareHistory.find(item => item.id === shareId);
    if (finalItem) {
      finalItem.status = shareResults.success > 0 ? 'completed' : 'failed';
      finalItem.endTime = new Date();
      finalItem.success = shareResults.success;
      finalItem.failed = shareResults.failed;
      finalItem.duration = shareResults.duration;
    }
    
    activeShares.delete(shareId);

    // Keep only last 100 entries
    if (shareHistory.length > 100) {
      shareHistory = shareHistory.slice(-100);
    }

    // Send final response through WebSocket or polling will get the final result
    // For now, we'll just return the initial response

  } catch (error) {
    console.error('API Error:', error);
    activeShares.delete(shareId);
    
    res.status(500).json({
      status: false,
      message: 'Server error occurred. Please try again.',
      code: 'SERVER_ERROR',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get share progress
app.get("/api/share/:id/progress", (req, res) => {
  const shareId = parseInt(req.params.id);
  const share = shareHistory.find(h => h.id === shareId);
  
  if (!share) {
    return res.status(404).json({
      status: false,
      message: 'Share not found'
    });
  }
  
  res.json({
    status: true,
    share: {
      id: share.id,
      progress: share.progress || 0,
      success: share.success || 0,
      failed: share.failed || 0,
      requested: share.requested,
      status: share.status,
      active: activeShares.has(shareId)
    }
  });
});

// Cancel share
app.post("/api/share/:id/cancel", (req, res) => {
  const shareId = parseInt(req.params.id);
  
  if (activeShares.has(shareId)) {
    activeShares.set(shareId, 'cancelled');
    
    const share = shareHistory.find(h => h.id === shareId);
    if (share) {
      share.status = 'cancelled';
      share.endTime = new Date();
    }
    
    res.json({
      status: true,
      message: 'Share cancelled successfully'
    });
  } else {
    res.status(404).json({
      status: false,
      message: 'No active share found with that ID'
    });
  }
});

// Share history
app.get("/api/history", (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  res.json({
    status: true,
    history: shareHistory.slice(-limit).reverse()
  });
});

// Running shares
app.get("/api/running-shares", (req, res) => {
  const runningShares = shareHistory.filter(item => 
    item.status === 'processing' && activeShares.has(item.id)
  );
  res.json({
    status: true,
    running_shares: runningShares
  });
});

// Stats
app.get("/api/stats", (req, res) => {
  const totalShares = shareHistory.length;
  const totalSuccess = shareHistory.reduce((acc, curr) => acc + (curr.success || 0), 0);
  const totalFailed = shareHistory.reduce((acc, curr) => acc + (curr.failed || 0), 0);
  const completedShares = shareHistory.filter(s => s.status === 'completed').length;
  const successRate = totalShares > 0 
    ? Math.round((completedShares / totalShares) * 100) 
    : 0;
  
  res.json({
    status: true,
    stats: {
      total_shares: totalShares,
      total_successful_shares: totalSuccess,
      total_failed_shares: totalFailed,
      completed_shares: completedShares,
      success_rate: successRate,
      active_shares: activeShares.size
    }
  });
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    status: true,
    message: 'Server is running',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📁 Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  app.close(() => {
    console.log('HTTP server closed');
    // Save history before exit
    fs.writeFileSync('./history.json', JSON.stringify(shareHistory, null, 2));
  });
});