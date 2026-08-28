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
console.log('TripMind railway-v8 | Public dir:', PUBLIC_DIR);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const SYSTEM_PROMPT = 'You are a travel planning assistant. CRITICAL: Always respond with ONLY valid JSON. Start your response with { and end with }. No text before or after the JSON.';

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function handleAPI(req, res) {
  if (req.method === 'GET') {
    return sendJSON(res, 200, { version: 'railway-v8', ok: true, keyOk: !!ANTHROPIC_KEY });
  }
  if (req.method !== 'POST') {
    return sendJSON(res, 405, { error: 'Method not allowed' });
  }
  if (!ANTHROPIC_KEY) {
    return sendJSON(res, 500, { error: 'ANTHROPIC_API_KEY não configurada.' });
  }

  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    try {
      const { prompt, useWebSearch = true, maxTokens = 8000 } = JSON.parse(body);
      if (!prompt) return sendJSON(res, 400, { error: 'Prompt ausente' });

      const estInputTokens = Math.round(prompt.length / 4);
      console.log('API call | webSearch:', useWebSearch, '| promptChars:', prompt.length, '| estInputTokens:', estInputTokens, '| maxTokens:', Math.min(maxTokens||4000, 6000));

      const headers = {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      };
      const reqBody = {
        model: 'claude-sonnet-4-6',
        max_tokens: Math.min(maxTokens || 4000, 6000),
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }]
      };
      if (useWebSearch) {
        headers['anthropic-beta'] = 'web-search-2025-03-05';
        reqBody.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
      }

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', headers, body: JSON.stringify(reqBody)
      });

      console.log('Anthropic status:', r.status);
      const txt = await r.text();

      if (!r.ok) {
        let e = 'Erro Anthropic ' + r.status;
        try { e = JSON.parse(txt).error?.message || e; } catch {}
        return sendJSON(res, r.status, { error: e });
      }

      const data = JSON.parse(txt);
      const stopReason = data.stop_reason || '';
      let text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');

      // Truncate if max_tokens hit
      if (stopReason === 'max_tokens' && text) {
        const lb = text.lastIndexOf('}');
        if (lb > 0) text = text.substring(0, lb + 1);
      }

      if (!text) return sendJSON(res, 500, { error: 'Sem texto. stop_reason=' + stopReason });

      // Strip markdown fences if Claude added them
      text = text.trim();
      if (text.startsWith('```')) {
        text = text.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
      }

      // Strip any preamble text before first {
      const firstBrace = text.indexOf('{');
      if (firstBrace > 0) text = text.substring(firstBrace);

      const usage = data.usage || {};
      const inputTok = usage.input_tokens || 0;
      const outputTok = usage.output_tokens || 0;
      const estCostUSD = (inputTok * 3 + outputTok * 15) / 1000000;
      console.log('Success | length:', text.length, '| stop:', stopReason, '| inputTok:', inputTok, '| outputTok:', outputTok, '| estCost: $'+estCostUSD.toFixed(4));
      return sendJSON(res, 200, { text, stopReason });

    } catch (err) {
      console.error('Error:', err.message);
      return sendJSON(res, 500, { error: err.message || 'Erro interno' });
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
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
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

// Railway Hobby: no timeout
server.timeout = 0;
server.keepAliveTimeout = 0;
server.headersTimeout = 0;

server.listen(PORT, '0.0.0.0', () => {
  console.log('Port:', PORT, '| Key:', !!ANTHROPIC_KEY);
});
