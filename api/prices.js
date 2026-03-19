// api/prices.js — Vercel serverless function
// Uses multiple data sources for NSE India stock prices

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  const { symbols } = req.query;
  if (!symbols) return res.status(400).json({ error: "symbols param required" });

  // Strip .NS suffix to get clean NSE symbols
  const symbolList = symbols.split(",").map(s => s.replace(/\.(NS|BO)$/, "").trim());

  // ── Source 1: NSE India via Stooq ───────────────────────────────────
  // Stooq provides EOD prices for NSE stocks, no auth needed
  try {
    const results = await Promise.allSettled(
      symbolList.map(async sym => {
        const url = `https://stooq.com/q/l/?s=${sym.toLowerCase()}.ns&f=sd2t2ohlcv&h&e=json`;
        const r = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const data = await r.json();
        const quote = data?.symbols?.[0];
        if (!quote?.Close || quote.Close === "N/D") throw new Error("No data");
        const price = parseFloat(quote.Close);
        const open  = parseFloat(quote.Open);
        const chg   = price - open;
        const chgPct= open ? (chg / open) * 100 : 0;
        return { sym, price, chg, chgPct };
      })
    );

    const prices = {};
    let successCount = 0;
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        const { sym, price, chg, chgPct } = r.value;
        prices[sym] = { price, chg, chgPct };
        successCount++;
      }
    });

    if (successCount > 0) {
      return res.status(200).json({ source: "stooq", prices });
    }
  } catch (e) { /* fall through */ }

  // ── Source 2: Yahoo Finance v8/spark (sometimes works from Vercel) ──
  try {
    const yahooSymbols = symbolList.map(s => s + ".NS").join(",");
    const sparkURL = `https://query2.finance.yahoo.com/v8/finance/spark?symbols=${yahooSymbols}&range=1d&interval=1d`;
    const r = await fetch(sparkURL, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://finance.yahoo.com",
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.json();
    const results = data?.spark?.result;
    if (!results?.length) throw new Error("empty");

    const prices = {};
    results.forEach(result => {
      const meta = result?.response?.[0]?.meta;
      if (!meta) return;
      const key    = result.symbol.replace(/\.(NS|BO)$/, "");
      const price  = meta.regularMarketPrice ?? meta.chartPreviousClose;
      const prev   = meta.chartPreviousClose;
      const chg    = price && prev ? price - prev : null;
      const chgPct = chg && prev   ? (chg / prev) * 100 : null;
      if (price) prices[key] = { price, chg, chgPct };
    });

    if (Object.keys(prices).length) {
      return res.status(200).json({ source: "yahoo-spark", prices });
    }
  } catch (e) { /* fall through */ }

  // ── Source 3: Yahoo Finance v7 with query2 domain ──────────────────
  try {
    const yahooSymbols = symbolList.map(s => s + ".NS").join(",");
    const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${yahooSymbols}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent`;
    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Referer": "https://finance.yahoo.com",
        "Accept": "application/json",
        "Cookie": "tbla_id=; B=; GUC=",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.json();
    const list = data?.quoteResponse?.result;
    if (!list?.length) throw new Error("empty");

    const prices = {};
    list.forEach(q => {
      const key = q.symbol.replace(/\.(NS|BO)$/, "");
      if (q.regularMarketPrice) {
        prices[key] = {
          price:  q.regularMarketPrice,
          chg:    q.regularMarketChange,
          chgPct: q.regularMarketChangePercent,
        };
      }
    });

    if (Object.keys(prices).length) {
      return res.status(200).json({ source: "yahoo-v7", prices });
    }
  } catch (e) { /* fall through */ }

  return res.status(502).json({
    error: "All price sources failed. Markets may be closed or APIs are temporarily down.",
  });
}
