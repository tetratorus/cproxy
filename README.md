# Claude Code Proxy (Minimal JS Version)

A minimal JavaScript proxy for Claude Code that intercepts and logs requests to SQLite.

## Features

- ✅ Intercepts Claude Code requests
- ✅ Saves requests and responses to SQLite
- ✅ Supports streaming responses
- ✅ Simple API to view logged requests
- ✅ ~150 lines of code (vs 3000+ in Go version)

## Setup

```bash
npm install
npm start
```

## Usage

Set the proxy URL in your shell:

```bash
export ANTHROPIC_BASE_URL=http://localhost:8181
```

Then run Claude Code normally. All requests will be logged to `requests.db`.

## API Endpoints

- `POST /v1/messages` - Main proxy endpoint (transparent)
- `GET /health` - Health check
- `GET /api/requests` - View all logged requests

## View Logged Requests

```bash
# While the server is running
curl http://localhost:8181/api/requests | jq
```

Or open SQLite directly:

```bash
sqlite3 requests.db "SELECT id, method, status_code, response_time FROM requests"
```

## Database Schema

```sql
CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  timestamp DATETIME,
  method TEXT,
  endpoint TEXT,
  headers TEXT,
  body TEXT,
  response TEXT,
  status_code INTEGER,
  response_time INTEGER
)
```

use pm2 to start this
