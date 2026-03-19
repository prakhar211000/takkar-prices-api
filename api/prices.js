// api/prices.js — Vercel serverless function
// Gets Yahoo Finance crumb+cookie first, then fetches prices (required since 2024)

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const { symbols } = req.query;
  if (!symbols) return res.status(400).json({ error: "symbols param required" });

  const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Origin": "https://finance.yahoo.com",
    "Referer": "https://finance.yahoo.com/",
  };

  try {
    // Step 1: Hit Yahoo to get session cookie
    const cookieRes = await fetch("https://fc.yahoo.com", {
      headers: HEADERS,
      redirect: "follow",
    });
    const rawCookies = cookieRes.headers.getSetCookie?.() || [];
    const cookieStr = rawCookies.map(c => c.split(";")[0]).join("; ");

    // Step 2: Get crumb
    const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/csrfToken", {
      headers: { ...HEADERS, "Cookie": cookieStr },
    });
    const crumb = await crumbRes.text();
    if (!crumb || crumb.includes("<")) throw new Error("Could not get crumb");

    // Step 3: Fetch prices with crumb + cookie
    const quoteURL = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketPreviousClose&crumb=${encodeURIComponent(crumb.trim())}`;
    const quoteRes = await fetch(quoteURL, {
      headers: { ...HEADERS, "Cookie": cookieStr },
    });
    if (!quoteRes.ok) throw new Error("Quote HTTP " + quoteRes.status);

    const data = await quoteRes.json();
    const list = data?.quoteResponse?.result;
    if (!list?.length) throw new Error("Empty quote response");

    const prices = {};
    list.forEach(q => {
      const key = q.symbol.replace(/\.(NS|BO)$/, "");
      prices[key] = {
        price:  q.regularMarketPrice,
        chg:    q.regularMarketChange,
        chgPct: q.regularMarketChangePercent,
        prev:   q.regularMarketPreviousClose,
      };
    });

    return res.status(200).json({ source: "yahoo", prices });

  } catch (e) {

    // Fallback: v8/spark (no crumb needed)
    try {
      const sparkURL = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${symbols}&range=1d&interval=5m`;
      const sparkRes = await fetch(sparkURL, { headers: HEADERS });
      if (!sparkRes.ok) throw new Error("Spark HTTP " + sparkRes.status);

      const data = await sparkRes.json();
      const results = data?.spark?.result;
      if (!results?.length) throw new Error("Empty spark");

      const prices = {};
      results.forEach(r => {
        const meta = r?.response?.[0]?.meta;
        if (!meta) return;
        const key    = r.symbol.replace(/\.(NS|BO)$/, "");
        const price  = meta.regularMarketPrice ?? meta.chartPreviousClose;
        const prev   = meta.chartPreviousClose;
        const chg    = price && prev ? price - prev : null;
        const chgPct = chg && prev   ? (chg / prev) * 100 : null;
        if (price) prices[key] = { price, chg, chgPct, prev };
      });

      if (Object.keys(prices).length) {
        return res.status(200).json({ source: "spark", prices });
      }
    } catch (e2) {}

    return res.status(502).json({ error: "Failed to fetch prices", detail: e.message });
  }
}
