const http = require('http');
const fs = require('fs');
const path = require('path');

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const PORT = process.env.PORT || 3000;

const POSSIBLE_PUBLIC = [
  path.join(__dirname, 'public'),
  path.join(process.cwd(), 'public'),
  __dirname,
];

function findPublicDir() {
  for (const dir of POSSIBLE_PUBLIC) {
    if (fs.existsSync(path.join(dir, 'index.html'))) {
      console.log('Public dir:', dir);
      return dir;
    }
  }
  return path.join(__dirname, 'public');
}

const PUBLIC_DIR = findPublicDir();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function handleAPI(req, res) {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: 'railway-v4', ok: true }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }
  if (!ANTHROPIC_KEY) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'ANTHROPIC_API_KEY não configurada.' }));
    return;
  }

  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    try {
      const { prompt, useWebSearch = true } = JSON.parse(body);
      if (!prompt) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Prompt ausente' }));
        return;
      }

      // Use Haiku for fast itinerary (no web search), Sonnet for real price searches
      const model = useWebSearch ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';
      console.log('Using model:', model, '| webSearch:', useWebSearch);

      const headers = {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      };

      const requestBody = {
        model,
        max_tokens: useWebSearch ? 8000 : 16000,
        messages: [{ role: 'user', content: prompt }]
      };

      if (useWebSearch) {
        headers['anthropic-beta'] = 'web-search-2025-03-05';
        requestBody.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
      }

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody)
      });

      console.log('Anthropic status:', r.status);
      const txt = await r.text();

      if (!r.ok) {
        let e = 'Erro ' + r.status;
        try { e = JSON.parse(txt).error?.message || e; } catch {}
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e }));
        return;
      }

      const data = JSON.parse(txt);
      const stopReason = data.stop_reason || '';
      let text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');

      if (stopReason === 'max_tokens' && text) {
        const lb = text.lastIndexOf('}');
        if (lb > 0) text = text.substring(0, lb + 1);
      }

      if (!text) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Sem resposta. stop_reason=' + stopReason }));
        return;
      }

      console.log('Done, length:', text.length);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text, stopReason }));

    } catch (err) {
      console.error('Error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Erro interno' }));
    }
  });
}

function serveStatic(req, res) {
  let p = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  p = path.join(PUBLIC_DIR, p);
  fs.readFile(p, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(d2);
      });
      return;
    }
    const ext = path.extname(p);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  if (req.url.startsWith('/api/search')) { handleAPI(req, res); return; }
  serveStatic(req, res);
});

server.timeout = 300000;
server.keepAliveTimeout = 310000;

server.listen(PORT, '0.0.0.0', () => {
  console.log('TripMind railway-v4 port', PORT, 'key:', !!ANTHROPIC_KEY);
});
