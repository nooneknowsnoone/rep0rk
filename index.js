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

// User agents list
const ua_list = [
  "Mozilla/5.0 (Linux; Android 10; Wildfire E Lite) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/105.0.5195.136 Mobile Safari/537.36[FBAN/EMA;FBLC/en_US;FBAV/298.0.0.10.115;]",
  "Mozilla/5.0 (Linux; Android 11; KINGKONG 5 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/87.0.4280.141 Mobile Safari/537.36[FBAN/EMA;FBLC/fr_FR;FBAV/320.0.0.12.108;]",
  "Mozilla/5.0 (Linux; Android 11; G91 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/106.0.5249.126 Mobile Safari/537.36[FBAN/EMA;FBLC/fr_FR;FBAV/325.0.1.4.108;]"
];

// Store for share history and running shares
let shareHistory = [];
let runningShares = [];

// Token extraction function
async function extract_token(cookie, ua) {
  try {
    const response = await axios.get(
      "https://business.facebook.com/business_locations",
      {
        headers: {
          "user-agent": ua,
          "referer": "https://www.facebook.com/",
          "Cookie": cookie
        },
        timeout: 10000
      }
    );

    const tokenMatch = response.data.match(/(EAAG\w+)/);
    return tokenMatch ? tokenMatch[1] : null;
  } catch (err) {
    console.error('Token extraction error:', err.message);
    return null;
  }
}

// Routes
app.get("/", (req, res) => {
  res.render("index");
});

app.get("/share", (req, res) => {
  res.render("share", { history: shareHistory.slice(-10) });
});

// API endpoint for sharing
app.post("/api/share", async (req, res) => {
  try {
    const { cookie, link: post_link, limit } = req.body;
    const limitNum = parseInt(limit, 10);

    // Basic validation
    if (!cookie || !post_link || !limitNum) {
      return res.json({
        status: false,
        message: "Missing required fields."
      });
    }

    const ua = ua_list[Math.floor(Math.random() * ua_list.length)];
    const token = await extract_token(cookie, ua);

    if (!token) {
      return res.json({
        status: false,
        message: "Token extraction failed. Check your cookie."
      });
    }

    let success = 0;
    const shareId = Date.now() + '-' + Math.random().toString(36).substring(2);
    const startTime = new Date();

    // Create running share entry
    const runningItem = {
      id: shareId,
      link: post_link,
      requested: limitNum,
      success: 0,
      status: 'processing',
      startTime: startTime,
      cookiePreview: cookie.substring(0, 15) + '...'
    };
    
    runningShares.unshift(runningItem);

    // Send immediate response that share started
    res.json({
      status: true,
      message: 'Share started successfully',
      share_id: shareId,
      timestamp: new Date().toISOString()
    });

    // Process shares in background
    (async () => {
      for (let i = 0; i < limitNum; i++) {
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
                "Cookie": cookie
              },
              timeout: 10000
            }
          );

          if (response.data && response.data.id) {
            success++;
            
            // Update running share
            const runningItem = runningShares.find(item => item.id === shareId);
            if (runningItem) {
              runningItem.success = success;
            }
          } else {
            break;
          }

          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 100));
          
        } catch (err) {
          console.error('Share attempt failed:', err.message);
          break;
        }
      }

      // Remove from running and add to history
      runningShares = runningShares.filter(item => item.id !== shareId);
      
      // Determine status (success if at least 1 share completed)
      const status = success > 0 ? 'completed' : 'failed';
      
      shareHistory.unshift({
        id: shareId,
        link: post_link,
        requested: limitNum,
        success: success,
        status: status,
        startTime: startTime,
        endTime: new Date()
      });

      // Keep history at reasonable size
      if (shareHistory.length > 50) {
        shareHistory = shareHistory.slice(0, 50);
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

// Get running shares
app.get("/api/running-shares", (req, res) => {
  res.json({
    status: true,
    running_shares: runningShares
  });
});

// Get share history
app.get("/api/history", (req, res) => {
  res.json({
    status: true,
    history: shareHistory.slice(0, 20)
  });
});

// Get specific share status
app.get("/api/share/:id", (req, res) => {
  const { id } = req.params;
  
  // Check running shares first
  const running = runningShares.find(item => item.id === id);
  if (running) {
    return res.json({
      status: true,
      share: running,
      type: 'running'
    });
  }
  
  // Then check history
  const history = shareHistory.find(item => item.id === id);
  if (history) {
    return res.json({
      status: true,
      share: history,
      type: 'history'
    });
  }
  
  res.json({
    status: false,
    message: 'Share not found'
  });
});

// Clear history (admin only - you might want to add auth)
app.post("/api/clear-history", (req, res) => {
  shareHistory = [];
  runningShares = [];
  res.json({
    status: true,
    message: 'History cleared successfully'
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});