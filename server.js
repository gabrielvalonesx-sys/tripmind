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
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return path.join(__dirname, 'public');
}

const PUBLIC_DIR = findPublicDir();
console.log('Public dir:', PUBLIC_DIR);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// System prompt forces JSON-only responses - prevents Claude from adding preamble text
const SYSTEM_PROMPT = 'You are a travel planning assistant. CRITICAL RULE: Always respond with ONLY valid JSON. Never include any text, explanation, or markdown before or after the JSON. Your entire response must start with { and end with } and be parseable by JSON.parse(). Do not say anything like "Here is the JSON" or "I have all the data". Just output the JSON directly.';

async function handleAPI(req, res) {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: 'railway-v7', ok: true, keyOk: !!ANTHROPIC_KEY }));
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

      // SSE keeps connection alive for Safari iOS and long requests
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no',
      });

      // Ping every 20s to keep Safari iOS alive
      const pingInterval = setInterval(() => {
        try { res.write(': ping\n\n'); } catch(e) {}
      }, 20000);

      console.log('API call | webSearch:', useWebSearch, '| prompt length:', prompt.length);

      try {
        const headers = {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
        };

        const requestBody = {
          model: 'claude-sonnet-4-6',
          max_tokens: 16000,
          system: SYSTEM_PROMPT,
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

        clearInterval(pingInterval);
        console.log('Anthropic status:', r.status);

        const txt = await r.text();

        if (!r.ok) {
          let e = 'Erro Anthropic ' + r.status;
          try { e = JSON.parse(txt).error?.message || e; } catch(ex) {}
          res.write('data: ' + JSON.stringify({ error: e }) + '\n\n');
          res.end();
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
          res.write('data: ' + JSON.stringify({ error: 'Sem texto na resposta. stop_reason=' + stopReason }) + '\n\n');
          res.end();
          return;
        }

        // Validate it starts with { (is JSON)
        const trimmed = text.trim();
        if (!trimmed.startsWith('{')) {
          // Claude added preamble text - extract JSON
          const jsonStart = text.indexOf('{');
          const jsonEnd = text.lastIndexOf('}');
          if (jsonStart >= 0 && jsonEnd > jsonStart) {
            text = text.substring(jsonStart, jsonEnd + 1);
            console.log('Extracted JSON from text response');
          } else {
            res.write('data: ' + JSON.stringify({ error: 'Claude não retornou JSON válido.' }) + '\n\n');
            res.end();
            return;
          }
        }

        console.log('Success, text length:', text.length);
        res.write('data: ' + JSON.stringify({ text, stopReason }) + '\n\n');
        res.end();

      } catch (err) {
        clearInterval(pingInterval);
        console.error('Error:', err.message);
        res.write('data: ' + JSON.stringify({ error: err.message || 'Erro interno' }) + '\n\n');
        res.end();
      }

    } catch (parseErr) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Body inválido' }));
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

server.timeout = 0;
server.keepAliveTimeout = 0;

server.listen(PORT, '0.0.0.0', () => {
  console.log('TripMind railway-v7 on port', PORT);
  console.log('API key:', !!ANTHROPIC_KEY);
  console.log('System prompt: JSON-only enforcement active');
});
