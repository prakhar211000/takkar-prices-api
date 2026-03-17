export default async function handler(req, res) {
  const { symbols } = req.query;

  if (!symbols) {
    return res.status(400).json({ error: "Missing symbols parameter" });
  }

  try {
    const url =
      "https://query1.finance.yahoo.com/v7/finance/quote?symbols=" + symbols;

    const response = await fetch(url);
    const data = await response.json();

    const prices = {};

    data.quoteResponse.result.forEach((stock) => {
      prices[stock.symbol] = {
        price: stock.regularMarketPrice,
        change: stock.regularMarketChange,
        percent: stock.regularMarketChangePercent
      };
    });

    res.status(200).json(prices);

  } catch (error) {
    res.status(500).json({ error: "Failed to fetch prices" });
  }
}
