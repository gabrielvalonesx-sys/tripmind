const http = require('http');
const fs = require('fs');
const path = require('path');

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const PORT = process.env.PORT || 3000;

// Try multiple possible locations for the public folder
const POSSIBLE_PUBLIC = [
  path.join(__dirname, 'public'),
  path.join(__dirname, '..', 'public'),
  path.join(process.cwd(), 'public'),
  __dirname,
];

function findPublicDir() {
  for (const dir of POSSIBLE_PUBLIC) {
    const test = path.join(dir, 'index.html');
    if (fs.existsSync(test)) {
      console.log('Found public dir:', dir);
      return dir;
    }
  }
  console.log('WARNING: Could not find index.html in any location');
  console.log('CWD:', process.cwd());
  console.log('__dirname:', __dirname);
  console.log('Files in __dirname:', fs.readdirSync(__dirname));
  return path.join(__dirname, 'public');
}

const PUBLIC_DIR = findPublicDir();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
};

async function handleApiSearch(req, res) {
  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ version: 'railway-v2', status: 'ok', keyOk: !!ANTHROPIC_KEY, publicDir: PUBLIC_DIR }));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  if (!ANTHROPIC_KEY) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'ANTHROPIC_API_KEY não configurada no servidor.' }));
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
      const { prompt } = JSON.parse(body);
      if (!prompt) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Prompt ausente' }));
        return;
      }

      console.log('Calling Anthropic API...');

      const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'web-search-2025-03-05',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 16000,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages: [{ role: 'user', content: prompt }]
        })
      });

      console.log('Anthropic status:', anthropicRes.status);
      const responseText = await anthropicRes.text();

      if (!anthropicRes.ok) {
        let errMsg = 'Erro Anthropic ' + anthropicRes.status;
        try { errMsg = JSON.parse(responseText).error?.message || errMsg; } catch {}
        res.writeHead(anthropicRes.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: errMsg }));
        return;
      }

      const data = JSON.parse(responseText);
      const stopReason = data.stop_reason || '';
      let text = (data.content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');

      if (stopReason === 'max_tokens' && text) {
        const lastBrace = text.lastIndexOf('}');
        if (lastBrace > 0) text = text.substring(0, lastBrace + 1);
      }

      if (!text) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Claude não retornou texto. stop_reason=' + stopReason }));
        return;
      }

      console.log('Success, response length:', text.length);
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
  let urlPath = req.url === '/' ? '/index.html' : req.url;
  urlPath = urlPath.split('?')[0];
  const filePath = path.join(PUBLIC_DIR, urlPath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, data2) => {
        if (err2) {
          res.writeHead(404);
          res.end('Not found - publicDir: ' + PUBLIC_DIR);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data2);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  if (req.url.startsWith('/api/search')) { handleApiSearch(req, res); return; }
  serveStatic(req, res);
});

server.timeout = 300000;
server.keepAliveTimeout = 310000;

server.listen(PORT, '0.0.0.0', () => {
  console.log('TripMind railway-v2 on port', PORT);
  console.log('API key:', !!ANTHROPIC_KEY);
  console.log('Public dir:', PUBLIC_DIR);
});
