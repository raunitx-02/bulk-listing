// Vercel Serverless Function — Keepa API Proxy
// Keeps API key secure in environment variables, never exposed in frontend JS

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const KEEPA_KEY = process.env.KEEPA_API_KEY;
  if (!KEEPA_KEY) {
    return res.status(500).json({ error: 'KEEPA_API_KEY not configured in environment variables' });
  }

  // Forward all query params to Keepa, injecting the key
  const { endpoint, ...params } = req.query;
  if (!endpoint) {
    return res.status(400).json({ error: 'Missing endpoint parameter' });
  }

  // Whitelist allowed Keepa endpoints for security
  const ALLOWED = ['bestsellers', 'product', 'category', 'search'];
  if (!ALLOWED.includes(endpoint)) {
    return res.status(403).json({ error: 'Endpoint not allowed' });
  }

  try {
    const keepaUrl = new URL(`https://api.keepa.com/${endpoint}`);
    keepaUrl.searchParams.set('key', KEEPA_KEY);

    for (const [k, v] of Object.entries(params)) {
      keepaUrl.searchParams.set(k, v);
    }

    const keepaResp = await fetch(keepaUrl.toString(), {
      headers: { 'Accept-Encoding': 'gzip' }
    });

    const data = await keepaResp.json();

    // Pass through the same status code
    return res.status(keepaResp.status).json(data);

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Proxy request failed' });
  }
}
