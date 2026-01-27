const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const app = express();
const PORT = 8181;
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
// const ANTHROPIC_URL = 'http://localhost:4001/v1/messages';
const REQUEST_TIMEOUT = 300000; // 5 minutes (same as claude-code-proxy)

// Initialize SQLite database
const db = new Database('requests.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    method TEXT,
    endpoint TEXT,
    headers TEXT,
    body TEXT,
    response TEXT,
    status_code INTEGER,
    response_time INTEGER,
    model TEXT,
    original_model TEXT,
    routed_model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_creation_input_tokens INTEGER,
    cache_read_input_tokens INTEGER,
    user_agent TEXT,
    content_type TEXT,
    session_id TEXT
  )
`);

// Create indexes for performance (like claude-code-proxy)
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_timestamp ON requests(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_endpoint ON requests(endpoint);
  CREATE INDEX IF NOT EXISTS idx_model ON requests(model);
`);

// Middleware to parse JSON with increased limit for large Claude Code requests
app.use(express.json({ limit: '50mb' }));

// Serve static files (index.html)
app.use(express.static('.'));

// Helper function to generate conversation ID from messages
function generateConversationId(messages) {
  if (!messages || messages.length === 0) {
    return crypto.randomBytes(6).toString('hex');
  }

  // Take first 4 messages (or fewer if conversation is shorter)
  const firstMessages = messages.slice(0, Math.min(4, messages.length));

  // Normalize messages by removing cache_control for consistency
  const normalized = firstMessages.map(msg => {
    const copy = { ...msg };
    if (copy.content && Array.isArray(copy.content)) {
      copy.content = copy.content.map(item => {
        if (typeof item === 'object' && item !== null) {
          const { cache_control, ...rest } = item;
          return rest;
        }
        return item;
      });
    }
    return copy;
  });

  // Hash the normalized messages
  return crypto.createHash('md5')
    .update(JSON.stringify(normalized))
    .digest('hex')
    .substring(0, 12);
}

// Helper function to sanitize headers (like claude-code-proxy)
function sanitizeHeaders(headers) {
  const sanitized = { ...headers };
  const sensitiveKeys = [
    'x-api-key',
    'api-key',
    'authorization',
    'anthropic-api-key',
    'openai-api-key'
  ];

  for (const key of Object.keys(sanitized)) {
    if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk))) {
      sanitized[key] = '[REDACTED]';
    }
  }

  return sanitized;
}

// Helper function to extract token usage from response
function extractTokenUsage(responseData) {
  try {
    const parsed = typeof responseData === 'string' ? JSON.parse(responseData) : responseData;
    if (parsed.usage) {
      return {
        input_tokens: parsed.usage.input_tokens || 0,
        output_tokens: parsed.usage.output_tokens || 0,
        cache_creation_input_tokens: parsed.usage.cache_creation_input_tokens || 0,
        cache_read_input_tokens: parsed.usage.cache_read_input_tokens || 0
      };
    }
  } catch (e) {
    // Ignore parse errors
  }
  return null;
}

// Helper function to parse SSE streaming events and extract data
function parseSSEStream(sseText) {
  const lines = sseText.split('\n');
  let fullText = '';
  let messageId = '';
  let model = '';
  let stopReason = '';
  let usage = { input_tokens: 0, output_tokens: 0 };

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;

    const dataStr = line.substring(6).trim();
    if (!dataStr || dataStr === '[DONE]') continue;

    try {
      const data = JSON.parse(dataStr);

      // Extract message metadata
      if (data.type === 'message_start' && data.message) {
        messageId = data.message.id || '';
        model = data.message.model || '';
        stopReason = data.message.stop_reason || '';
      }

      // Extract text content
      if (data.type === 'content_block_delta' && data.delta) {
        if (data.delta.type === 'text_delta' && data.delta.text) {
          fullText += data.delta.text;
        }
      }

      // Extract usage/token info
      if (data.type === 'message_delta' && data.usage) {
        usage.input_tokens = data.usage.input_tokens || usage.input_tokens;
        usage.output_tokens = data.usage.output_tokens || usage.output_tokens;
      }

      // Also check message_stop for stop reason
      if (data.type === 'message_stop' && data.stop_reason) {
        stopReason = data.stop_reason;
      }
    } catch (e) {
      // Ignore parse errors for individual events
    }
  }

  return { fullText, messageId, model, stopReason, usage };
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date() });
});

// Models endpoint (required by Claude Code)
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [
      {
        id: 'claude-3-5-sonnet-20241022',
        object: 'model',
        created: 1677610602,
        owned_by: 'anthropic'
      },
      {
        id: 'claude-3-5-sonnet-20240620',
        object: 'model',
        created: 1677610602,
        owned_by: 'anthropic'
      },
      {
        id: 'claude-3-opus-20240229',
        object: 'model',
        created: 1677610602,
        owned_by: 'anthropic'
      },
      {
        id: 'claude-3-sonnet-20240229',
        object: 'model',
        created: 1677610602,
        owned_by: 'anthropic'
      },
      {
        id: 'claude-3-haiku-20240307',
        object: 'model',
        created: 1677610602,
        owned_by: 'anthropic'
      }
    ]
  });
});

// Main proxy endpoint
app.post('/v1/messages', async (req, res) => {
  const requestId = crypto.randomBytes(8).toString('hex');
  const startTime = Date.now();

  // Save request to database with sanitized headers
  const insertStmt = db.prepare(`
    INSERT INTO requests (id, method, endpoint, headers, body, original_model, routed_model, user_agent, content_type, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const originalModel = req.body.model;
  const routedModel = req.body.model; // For now, no routing - just pass through

  // Generate conversation ID from messages
  const conversationId = generateConversationId(req.body.messages);

  insertStmt.run(
    requestId,
    req.method,
    req.path,
    JSON.stringify(sanitizeHeaders(req.headers)),
    JSON.stringify(req.body),
    originalModel,
    routedModel,
    req.headers['user-agent'] || null,
    req.headers['content-type'] || null,
    conversationId
  );

  console.log(`📥 Request ${requestId} - Model: ${originalModel}, Stream: ${req.body.stream}`);

  try {
    // Forward request to Anthropic with timeout and gzip support
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    const response = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        ...req.headers,
        'Content-Type': 'application/json',
        'anthropic-version': req.headers['anthropic-version'] || '2023-06-01',
        'x-api-key': req.headers['x-api-key'],
        'Accept-Encoding': 'gzip', // Request gzip compression like claude-code-proxy
      },
      body: JSON.stringify(req.body),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    // Handle streaming response
    if (req.body.stream) {
      // Forward important headers from upstream response
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // Forward rate limit and request ID headers
      const headersToForward = [
        'anthropic-ratelimit-requests-limit',
        'anthropic-ratelimit-requests-remaining',
        'anthropic-ratelimit-requests-reset',
        'anthropic-ratelimit-tokens-limit',
        'anthropic-ratelimit-tokens-remaining',
        'anthropic-ratelimit-tokens-reset',
        'request-id',
        'x-request-id'
      ];

      for (const header of headersToForward) {
        const value = response.headers.get(header);
        if (value) {
          res.setHeader(header, value);
        }
      }

      const chunks = [];
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          chunks.push(chunk);

          // Forward chunk to client
          res.write(chunk);
        }

        res.end();

        // Parse SSE stream to extract metadata and tokens
        const fullResponse = chunks.join('');
        const parsed = parseSSEStream(fullResponse);

        // Save collected response to database with token usage
        const responseTime = Date.now() - startTime;
        const updateStmt = db.prepare(`
          UPDATE requests
          SET response = ?, status_code = ?, response_time = ?, model = ?,
              input_tokens = ?, output_tokens = ?,
              cache_creation_input_tokens = ?, cache_read_input_tokens = ?
          WHERE id = ?
        `);

        updateStmt.run(
          fullResponse,
          response.status,
          responseTime,
          parsed.model || originalModel,
          parsed.usage.input_tokens,
          parsed.usage.output_tokens,
          0, // cache_creation_input_tokens not in streaming events
          0, // cache_read_input_tokens not in streaming events
          requestId
        );

        console.log(`✅ Request ${requestId} completed in ${responseTime}ms - Tokens: ${parsed.usage.input_tokens}/${parsed.usage.output_tokens}`);
      } catch (streamError) {
        console.error(`❌ Streaming error for ${requestId}:`, streamError);
        res.end();
      }
    } else {
      // Handle non-streaming response
      const responseData = await response.text();
      const responseTime = Date.now() - startTime;

      // Forward important headers from upstream response
      const headersToForward = [
        'anthropic-ratelimit-requests-limit',
        'anthropic-ratelimit-requests-remaining',
        'anthropic-ratelimit-requests-reset',
        'anthropic-ratelimit-tokens-limit',
        'anthropic-ratelimit-tokens-remaining',
        'anthropic-ratelimit-tokens-reset',
        'request-id',
        'x-request-id'
      ];

      for (const header of headersToForward) {
        const value = response.headers.get(header);
        if (value) {
          res.setHeader(header, value);
        }
      }

      // Extract token usage and model from response
      const tokenUsage = extractTokenUsage(responseData);
      let responseModel = originalModel;
      try {
        const parsed = JSON.parse(responseData);
        if (parsed.model) {
          responseModel = parsed.model;
        }
      } catch (e) {
        // Ignore parse errors
      }

      // Save response to database with token usage
      const updateStmt = db.prepare(`
        UPDATE requests
        SET response = ?, status_code = ?, response_time = ?, model = ?,
            input_tokens = ?, output_tokens = ?,
            cache_creation_input_tokens = ?, cache_read_input_tokens = ?
        WHERE id = ?
      `);

      updateStmt.run(
        responseData,
        response.status,
        responseTime,
        responseModel,
        tokenUsage ? tokenUsage.input_tokens : null,
        tokenUsage ? tokenUsage.output_tokens : null,
        tokenUsage ? tokenUsage.cache_creation_input_tokens : null,
        tokenUsage ? tokenUsage.cache_read_input_tokens : null,
        requestId
      );

      // Forward response to client with correct status code
      res.status(response.status)
         .setHeader('Content-Type', response.headers.get('content-type') || 'application/json')
         .send(responseData);

      if (tokenUsage) {
        console.log(`✅ Request ${requestId} completed in ${responseTime}ms - Tokens: ${tokenUsage.input_tokens}/${tokenUsage.output_tokens}`);
      } else {
        console.log(`✅ Request ${requestId} completed in ${responseTime}ms`);
      }
    }
  } catch (error) {
    console.error(`❌ Error for request ${requestId}:`, error);
    res.status(500).json({ error: 'Proxy error', message: error.message });
  }
});

// API to get all requests
app.get('/api/requests', (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';

    let total, requests;

    if (search) {
      // Use FTS5 for full-text search
      // Get total count from FTS5
      const countStmt = db.prepare(`
        SELECT COUNT(*) as total
        FROM requests_fts
        WHERE requests_fts MATCH ?
      `);
      ({ total } = countStmt.get(search));

      // Get paginated requests using FTS5 with JOIN
      const stmt = db.prepare(`
        SELECT
          r.*,
          json_array_length(json_extract(r.body, '$.messages')) as message_count
        FROM requests_fts
        JOIN requests r ON requests_fts.rowid = r.rowid
        WHERE requests_fts MATCH ?
        ORDER BY r.timestamp DESC
        LIMIT ? OFFSET ?
      `);
      requests = stmt.all(search, limit, offset);
    } else {
      // No search - get all requests
      const countStmt = db.prepare(`SELECT COUNT(*) as total FROM requests`);
      ({ total } = countStmt.get());

      const stmt = db.prepare(`
        SELECT
          *,
          json_array_length(json_extract(body, '$.messages')) as message_count
        FROM requests
        ORDER BY timestamp DESC
        LIMIT ? OFFSET ?
      `);
      requests = stmt.all(limit, offset);
    }

    // Parse JSON fields for easier consumption
    const parsedRequests = requests.map(req => {
      try {
        const parsed = {
          ...req,
          headers: req.headers ? JSON.parse(req.headers) : null,
          body: req.body ? JSON.parse(req.body) : null,
          response: req.response ? (req.response.startsWith('data:') ? req.response : JSON.parse(req.response)) : null,
          message_count: req.message_count || 0
        };

        // Count matches in messages if searching
        let matchCount = 0;
        if (search && parsed.body && parsed.body.messages) {
          const searchLower = search.toLowerCase();
          parsed.body.messages.forEach(msg => {
            if (msg.content) {
              const contentStr = typeof msg.content === 'string'
                ? msg.content
                : JSON.stringify(msg.content);
              const contentLower = contentStr.toLowerCase();
              // Count occurrences
              const matches = contentLower.match(new RegExp(searchLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'));
              if (matches) matchCount += matches.length;
            }
          });
        }

        // Always add match_count when searching
        if (search) {
          parsed.match_count = matchCount;
        }

        return parsed;
      } catch (e) {
        // Even on error, include match_count: 0 if searching
        return search ? { ...req, match_count: 0 } : req;
      }
    });

    res.json({
      requests: parsedRequests,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit)
    });
  } catch (error) {
    console.error('Error getting requests:', error);
    res.status(500).json({ error: 'Failed to get requests' });
  }
});

// API to get a specific request by ID with navigation
app.get('/api/requests/:id', (req, res) => {
  try {
    const stmt = db.prepare('SELECT * FROM requests WHERE id = ?');
    const request = stmt.get(req.params.id);

    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    // Parse JSON fields
    try {
      request.headers = request.headers ? JSON.parse(request.headers) : null;
      request.body = request.body ? JSON.parse(request.body) : null;
      request.response = request.response ? (request.response.startsWith('data:') ? request.response : JSON.parse(request.response)) : null;
    } catch (e) {
      // Keep raw if parse fails
    }

    // Add conversation navigation if session_id exists
    if (request.session_id && request.body && request.body.messages) {
      const msgCount = request.body.messages.length;

      // Get previous 10 requests (going back in steps of 2)
      const prev10 = [];
      for (let i = 1; i <= 10; i++) {
        const targetCount = msgCount - (i * 2);
        if (targetCount <= 0) break;

        const prevStmt = db.prepare(`
          SELECT id, timestamp
          FROM requests
          WHERE session_id = ? AND json_array_length(json_extract(body, '$.messages')) = ?
          ORDER BY timestamp DESC
          LIMIT 1
        `);
        const prevReq = prevStmt.get(request.session_id, targetCount);
        if (prevReq) {
          prev10.push({ id: prevReq.id, msg_count: targetCount, timestamp: prevReq.timestamp });
        }
      }

      // Check if there are more previous requests
      const minMsgCount = prev10.length > 0 ? prev10[prev10.length - 1].msg_count : msgCount;
      const hasMorePrevStmt = db.prepare(`
        SELECT COUNT(*) as count
        FROM requests
        WHERE session_id = ? AND json_array_length(json_extract(body, '$.messages')) < ?
      `);
      const hasMorePrev = hasMorePrevStmt.get(request.session_id, minMsgCount - 2).count > 0;

      // Get all next requests (could be multiple due to forking)
      const nextStmt = db.prepare(`
        SELECT id, timestamp
        FROM requests
        WHERE session_id = ? AND json_array_length(json_extract(body, '$.messages')) = ?
        ORDER BY timestamp ASC
      `);
      const nextReqs = nextStmt.all(request.session_id, msgCount + 2);

      // Add navigation to response
      request.navigation = {
        conversation_id: request.session_id,
        msg_count: msgCount,
        prev_10: prev10.reverse(), // Reverse to show oldest->newest
        has_more_prev: hasMorePrev,
        next: nextReqs.map(r => ({ id: r.id, msg_count: msgCount + 2, timestamp: r.timestamp }))
      };
    }

    res.json(request);
  } catch (error) {
    console.error('Error getting request:', error);
    res.status(500).json({ error: 'Failed to get request' });
  }
});

// API to get older history for a request (lazy loading)
app.get('/api/requests/:id/history', (req, res) => {
  try {
    const stmt = db.prepare('SELECT session_id, body FROM requests WHERE id = ?');
    const request = stmt.get(req.params.id);

    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }

    const body = request.body ? JSON.parse(request.body) : null;
    if (!body || !body.messages) {
      return res.json({ prev_requests: [], has_more: false });
    }

    const msgCount = body.messages.length;
    const offset = parseInt(req.query.offset) || 10;
    const limit = parseInt(req.query.limit) || 10;

    // Get previous requests starting from offset
    const prevRequests = [];
    for (let i = offset; i < offset + limit; i++) {
      const targetCount = msgCount - (i * 2);
      if (targetCount <= 0) break;

      const prevStmt = db.prepare(`
        SELECT id, timestamp
        FROM requests
        WHERE session_id = ? AND json_array_length(json_extract(body, '$.messages')) = ?
        ORDER BY timestamp DESC
        LIMIT 1
      `);
      const prevReq = prevStmt.get(request.session_id, targetCount);
      if (prevReq) {
        prevRequests.push({ id: prevReq.id, msg_count: targetCount, timestamp: prevReq.timestamp });
      }
    }

    // Check if there are more requests beyond this batch
    const minMsgCount = prevRequests.length > 0 ? prevRequests[prevRequests.length - 1].msg_count : 0;
    const hasMoreStmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM requests
      WHERE session_id = ? AND json_array_length(json_extract(body, '$.messages')) < ?
    `);
    const hasMore = minMsgCount > 0 && hasMoreStmt.get(request.session_id, minMsgCount - 2).count > 0;

    res.json({
      prev_requests: prevRequests.reverse(), // oldest->newest
      has_more: hasMore
    });
  } catch (error) {
    console.error('Error getting history:', error);
    res.status(500).json({ error: 'Failed to get history' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Claude Code Proxy running on http://localhost:${PORT}`);
  console.log(`📊 Database: requests.db`);
  console.log(`\nSet this in your shell to use the proxy:`);
  console.log(`export ANTHROPIC_BASE_URL=http://localhost:${PORT}`);
});
