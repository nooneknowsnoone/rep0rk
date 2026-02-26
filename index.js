const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Set view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Enhanced User agents list with more variety
const ua_list = [
  "Mozilla/5.0 (Linux; Android 10; Wildfire E Lite) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/105.0.5195.136 Mobile Safari/537.36[FBAN/EMA;FBLC/en_US;FBAV/298.0.0.10.115;]",
  "Mozilla/5.0 (Linux; Android 11; KINGKONG 5 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/87.0.4280.141 Mobile Safari/537.36[FBAN/EMA;FBLC/fr_FR;FBAV/320.0.0.12.108;]",
  "Mozilla/5.0 (Linux; Android 11; G91 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/106.0.5249.126 Mobile Safari/537.36[FBAN/EMA;FBLC/fr_FR;FBAV/325.0.1.4.108;]",
  "Mozilla/5.0 (Linux; Android 12; SM-G998B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Mobile Safari/537.36[FBAN/EMA;FBLC/en_US;FBAV/350.0.0.12.109;]",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/20D47[FBAN/FBIOS;FBAV/350.0.0.12.109;]",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0[FBAN/EMA;FBLC/en_US;FBAV/350.0.0.12.109;]"
];

// Store for share history (in-memory)
let shareHistory = [];

// Store active share tasks for faster tracking
const activeShares = new Map();

// Token extraction function with retry mechanism
async function extract_token(cookie, ua, retryCount = 2) {
  for (let attempt = 0; attempt <= retryCount; attempt++) {
    try {
      const response = await axios.get(
        "https://business.facebook.com/business_locations",
        {
          headers: {
            "user-agent": ua,
            "referer": "https://www.facebook.com/",
            "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "accept-language": "en-US,en;q=0.5",
            "accept-encoding": "gzip, deflate, br",
            "connection": "keep-alive",
            "upgrade-insecure-requests": "1",
            "sec-fetch-dest": "document",
            "sec-fetch-mode": "navigate",
            "sec-fetch-site": "same-origin",
            "Cookie": cookie
          },
          timeout: 10000,
          maxRedirects: 5
        }
      );

      // Try multiple regex patterns for token extraction
      const patterns = [
        /(EAAG\w+)/,
        /(EAA\w+)/,
        /(EAAB\w+)/
      ];
      
      for (const pattern of patterns) {
        const tokenMatch = response.data.match(pattern);
        if (tokenMatch && tokenMatch[1] && tokenMatch[1].length > 30) {
          return tokenMatch[1];
        }
      }
      
      // If no token found but not error, wait and retry
      if (attempt < retryCount) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
    } catch (err) {
      console.error(`Token extraction attempt ${attempt + 1} failed:`, err.message);
      if (attempt < retryCount) {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
    }
  }
  return null;
}

// Fast share function with concurrency
async function fastShare(shareId, cookie, post_link, limitNum, ua, token) {
  let success = 0;
  const batchSize = 5; // Number of concurrent requests
  const delay = 50; // Minimal delay between batches (ms)
  
  // Update initial status
  const shareItem = {
    id: shareId,
    link: post_link,
    requested: limitNum,
    success: 0,
    status: 'processing',
    startTime: new Date(),
    endTime: null,
    progress: []
  };
  
  shareHistory.push(shareItem);
  activeShares.set(shareId, shareItem);

  // Process shares in batches for speed
  for (let i = 0; i < limitNum && activeShares.has(shareId); i += batchSize) {
    const batch = [];
    const currentBatchSize = Math.min(batchSize, limitNum - i);
    
    // Create batch of promises
    for (let j = 0; j < currentBatchSize; j++) {
      batch.push(
        (async () => {
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
                  "accept": "application/json, text/plain, */*",
                  "accept-language": "en-US,en;q=0.9",
                  "origin": "https://www.facebook.com",
                  "referer": "https://www.facebook.com/",
                  "Cookie": cookie
                },
                timeout: 8000
              }
            );

            if (response.data && response.data.id) {
              return 1;
            }
          } catch (err) {
            // Silent fail for individual requests
          }
          return 0;
        })()
      );
    }

    // Wait for batch to complete
    const results = await Promise.all(batch);
    const batchSuccess = results.filter(r => r === 1).length;
    success += batchSuccess;

    // Update progress
    const activeItem = activeShares.get(shareId);
    if (activeItem) {
      activeItem.success = success;
    }

    // Small delay between batches to avoid rate limiting
    if (i + batchSize < limitNum) {
      await new Promise(r => setTimeout(r, delay));
    }
  }

  // Final update
  const finalItem = shareHistory.find(item => item.id === shareId);
  if (finalItem) {
    finalItem.status = success === limitNum ? 'completed' : (success > 0 ? 'completed' : 'failed');
    finalItem.endTime = new Date();
    finalItem.success = success;
  }

  // Remove from active shares
  activeShares.delete(shareId);

  return {
    success,
    total: limitNum,
    status: success === limitNum ? 'completed' : (success > 0 ? 'completed' : 'failed')
  };
}

// Routes
app.get("/", (req, res) => {
  res.render("index");
});

app.get("/share", (req, res) => {
  res.render("share", { history: shareHistory.slice(-10) });
});

// API endpoint for sharing (UPGRADED FAST SHARE)
app.post("/api/share", async (req, res) => {
  try {
    const { cookie, link: post_link, limit } = req.body;
    const limitNum = parseInt(limit, 10);

    // Validation
    if (!cookie || !post_link || !limitNum || limitNum < 1) {
      return res.json({
        status: false,
        message: "Missing required fields or invalid limit."
      });
    }

    // Generate unique share ID
    const shareId = Date.now() + Math.random().toString(36).substr(2, 5);

    // Send immediate response to frontend
    res.json({
      status: true,
      message: "Share process started",
      share_id: shareId,
      timestamp: new Date().toISOString()
    });

    // Process sharing in background
    (async () => {
      try {
        const ua = ua_list[Math.floor(Math.random() * ua_list.length)];
        
        // Extract token
        const token = await extract_token(cookie, ua);
        
        if (!token) {
          const failedItem = shareHistory.find(item => item.id === shareId);
          if (failedItem) {
            failedItem.status = 'failed';
            failedItem.endTime = new Date();
          }
          activeShares.delete(shareId);
          return;
        }

        // Start fast sharing
        await fastShare(shareId, cookie, post_link, limitNum, ua, token);
        
      } catch (error) {
        console.error('Background share error:', error);
        const failedItem = shareHistory.find(item => item.id === shareId);
        if (failedItem) {
          failedItem.status = 'failed';
          failedItem.endTime = new Date();
        }
        activeShares.delete(shareId);
      }
    })();

  } catch (error) {
    console.error('API Error:', error);
    res.json({
      status: false,
      message: 'Server error occurred. Please try again.'
    });
  }
});

// Get specific share progress
app.get("/api/share/:shareId", (req, res) => {
  const { shareId } = req.params;
  const share = shareHistory.find(item => item.id === shareId) || activeShares.get(shareId);
  
  if (share) {
    res.json({
      status: true,
      share: {
        id: share.id,
        link: share.link,
        requested: share.requested,
        success: share.success,
        status: share.status,
        startTime: share.startTime,
        endTime: share.endTime || null
      }
    });
  } else {
    res.json({
      status: false,
      message: "Share not found"
    });
  }
});

// Share history endpoint (UPGRADED)
app.get("/api/history", (req, res) => {
  // Return last 50 items with most recent first
  const history = shareHistory
    .slice(-50)
    .reverse()
    .map(item => ({
      id: item.id,
      link: item.link,
      requested: item.requested,
      success: item.success,
      status: item.status,
      startTime: item.startTime,
      endTime: item.endTime
    }));

  res.json({
    status: true,
    history: history
  });
});

// Running shares endpoint (UPGRADED)
app.get("/api/running-shares", (req, res) => {
  const running = Array.from(activeShares.values()).map(item => ({
    id: item.id,
    link: item.link,
    requested: item.requested,
    success: item.success,
    status: 'processing',
    startTime: item.startTime,
    progress: Math.round((item.success / item.requested) * 100) || 0
  }));

  res.json({
    status: true,
    running_shares: running
  });
});

// Clear old history (keep last 100 items)
setInterval(() => {
  if (shareHistory.length > 100) {
    shareHistory = shareHistory.slice(-100);
  }
}, 3600000); // Clean up every hour

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`⚡ Fast share mode enabled with batch processing`);
  console.log(`📊 Max concurrent shares per task: 5`);
});