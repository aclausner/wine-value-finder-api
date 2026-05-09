const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// Browser-like headers to avoid being blocked
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-CA,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
};

// ─── Health check ───────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Wine Value Finder API is running" });
});

// ─── LCBO Search ─────────────────────────────────────────────────────────────
// Searches LCBO's internal product API
app.get("/api/lcbo", async (req, res) => {
  const { q, minPrice, maxPrice } = req.query;
  if (!q) return res.status(400).json({ error: "Missing query parameter q" });

  try {
    // LCBO uses Coveo search internally
    const url = `https://www.lcbo.com/en/catalogsearch/result/?q=${encodeURIComponent(q)}`;
    
    // Hit LCBO's search API endpoint
    const apiUrl = `https://www.lcbo.com/api/2.0/products.json?q=${encodeURIComponent(q)}&per_page=20&page=1`;
    
    const response = await axios.get(apiUrl, {
      headers: {
        ...HEADERS,
        "Referer": "https://www.lcbo.com/",
      },
      timeout: 10000,
    });

    let products = response.data?.result || response.data?.products || [];

    // Filter by price if provided
    if (minPrice) products = products.filter(p => (p.price || p.regular_price) >= parseFloat(minPrice));
    if (maxPrice) products = products.filter(p => (p.price || p.regular_price) <= parseFloat(maxPrice));

    const wines = products.map(p => ({
      name: p.name || p.title,
      sku: p.id || p.sku || p.product_no,
      price: parseFloat(p.price || p.regular_price || 0),
      vintage: p.product_attributes?.vintage_year || extractVintage(p.name || ""),
      varietal: p.product_attributes?.varietal || p.varietal || "",
      region: p.product_attributes?.region || p.region || "",
      country: p.product_attributes?.country || p.country || "",
      url: `https://www.lcbo.com${p.url || ""}`,
      image: p.image || p.thumbnail || "",
      in_stock: p.availability !== "out_of_stock",
    }));

    res.json({ success: true, count: wines.length, wines });

  } catch (err) {
    console.error("LCBO API error:", err.message);
    // Fallback: try alternate LCBO endpoint
    try {
      const fallbackUrl = `https://lcboapi.com/products?q=${encodeURIComponent(q)}&per_page=20`;
      const fallback = await axios.get(fallbackUrl, { headers: HEADERS, timeout: 8000 });
      const products = fallback.data?.result || [];
      res.json({ success: true, count: products.length, wines: products, source: "fallback" });
    } catch (fallbackErr) {
      res.status(500).json({ error: "LCBO search failed", detail: err.message });
    }
  }
});

// ─── Vivino Search ───────────────────────────────────────────────────────────
// Searches Vivino for wine scores
app.get("/api/vivino", async (req, res) => {
  const { wine_name, vintage, country_code } = req.query;
  if (!wine_name) return res.status(400).json({ error: "Missing wine_name parameter" });

  try {
    const query = vintage ? `${wine_name} ${vintage}` : wine_name;
    
    const url = `https://www.vivino.com/api/wines/search?q=${encodeURIComponent(query)}&language=en&wine_type_ids[]=1&wine_type_ids[]=2`;
    
    const response = await axios.get(url, {
      headers: {
        ...HEADERS,
        "Referer": "https://www.vivino.com/",
        "Accept": "application/json",
        "x-vivino-platform": "web",
      },
      timeout: 10000,
    });

    const wines = response.data?.explore_vintage?.matches || response.data?.wines || [];

    const results = wines.slice(0, 5).map(w => {
      const wine = w.vintage?.wine || w.wine || w;
      const vintageData = w.vintage || w;
      return {
        vivino_id: wine.id,
        name: wine.name,
        winery: wine.winery?.name,
        vintage: vintageData.year,
        varietal: wine.style?.varietal_name || wine.type_id,
        region: wine.region?.name,
        country: wine.region?.country?.name,
        score: vintageData.statistics?.ratings_average || wine.statistics?.ratings_average,
        ratings_count: vintageData.statistics?.ratings_count || wine.statistics?.ratings_count,
        vivino_url: `https://www.vivino.com/wines/${wine.id}`,
        image: wine.image?.location ? `https://images.vivino.com/thumbs/${wine.image.location}` : null,
      };
    });

    res.json({ success: true, count: results.length, wines: results });

  } catch (err) {
    console.error("Vivino API error:", err.message);
    res.status(500).json({ error: "Vivino search failed", detail: err.message });
  }
});

// ─── Combined match endpoint ─────────────────────────────────────────────────
// Takes an LCBO wine and finds its best Vivino match
app.post("/api/match", async (req, res) => {
  const { name, vintage, varietal, price } = req.body;
  if (!name) return res.status(400).json({ error: "Missing wine name" });

  try {
    // Search Vivino for this specific wine
    const query = `${name} ${vintage || ""}`.trim();
    const url = `https://www.vivino.com/api/wines/search?q=${encodeURIComponent(query)}&language=en`;

    const response = await axios.get(url, {
      headers: {
        ...HEADERS,
        "Referer": "https://www.vivino.com/",
      },
      timeout: 10000,
    });

    const matches = response.data?.explore_vintage?.matches || [];
    
    if (matches.length === 0) {
      return res.json({ success: false, message: "No Vivino match found" });
    }

    // Find best match: prioritize same vintage + similar name
    let bestMatch = matches[0];
    for (const match of matches) {
      const matchVintage = match.vintage?.year?.toString();
      const matchName = (match.vintage?.wine?.name || "").toLowerCase();
      const searchName = name.toLowerCase();
      
      // Prefer vintage match
      if (vintage && matchVintage === vintage.toString()) {
        bestMatch = match;
        break;
      }
    }

    const wine = bestMatch.vintage?.wine || bestMatch;
    const vintageData = bestMatch.vintage || bestMatch;
    const score = vintageData.statistics?.ratings_average || wine.statistics?.ratings_average || 0;
    const ratingsCount = vintageData.statistics?.ratings_count || wine.statistics?.ratings_count || 0;

    // Calculate value score
    const valueScore = price > 0 && score > 0
      ? Math.pow(score, 2.5) * Math.log(Math.max(ratingsCount, 1)) / price
      : 0;

    res.json({
      success: true,
      match: {
        vivino_name: wine.name,
        winery: wine.winery?.name,
        vintage: vintageData.year,
        score: score,
        ratings_count: ratingsCount,
        region: wine.region?.name,
        country: wine.region?.country?.name,
        vivino_url: `https://www.vivino.com/wines/${wine.id}`,
        raw_value_score: valueScore,
      }
    });

  } catch (err) {
    console.error("Match error:", err.message);
    res.status(500).json({ error: "Matching failed", detail: err.message });
  }
});

// ─── Full pipeline: LCBO search → Vivino match → value ranking ───────────────
app.get("/api/search", async (req, res) => {
  const { q, minPrice, maxPrice } = req.query;
  if (!q) return res.status(400).json({ error: "Missing query" });

  try {
    // 1. Get LCBO results
    const lcboUrl = `https://www.lcbo.com/api/2.0/products.json?q=${encodeURIComponent(q)}&per_page=12&page=1`;
    const lcboRes = await axios.get(lcboUrl, {
      headers: { ...HEADERS, "Referer": "https://www.lcbo.com/" },
      timeout: 10000,
    });

    let products = lcboRes.data?.result || lcboRes.data?.products || [];
    if (minPrice) products = products.filter(p => (p.price || 0) >= parseFloat(minPrice));
    if (maxPrice) products = products.filter(p => (p.price || 0) <= parseFloat(maxPrice));
    products = products.slice(0, 10);

    // 2. For each LCBO wine, find Vivino score in parallel
    const matchPromises = products.map(async (product) => {
      const name = product.name || product.title || "";
      const vintage = extractVintage(name) || product.product_attributes?.vintage_year;
      const price = parseFloat(product.price || product.regular_price || 0);

      try {
        const vivinoUrl = `https://www.vivino.com/api/wines/search?q=${encodeURIComponent(name)}&language=en`;
        const vivinoRes = await axios.get(vivinoUrl, {
          headers: { ...HEADERS, "Referer": "https://www.vivino.com/" },
          timeout: 8000,
        });

        const matches = vivinoRes.data?.explore_vintage?.matches || [];
        if (matches.length === 0) return null;

        const best = matches[0];
        const wine = best.vintage?.wine || best;
        const vData = best.vintage || best;
        const score = parseFloat(vData.statistics?.ratings_average || wine.statistics?.ratings_average || 0);
        const ratingsCount = parseInt(vData.statistics?.ratings_count || wine.statistics?.ratings_count || 0);

        const rawValue = price > 0 && score > 0
          ? Math.pow(score, 2.5) * Math.log(Math.max(ratingsCount, 1)) / price
          : 0;

        return {
          // LCBO data
          name: name,
          sku: product.id || product.product_no,
          price,
          vintage: vintage || vData.year,
          varietal: product.product_attributes?.varietal || "",
          region: product.product_attributes?.region || wine.region?.name || "",
          country: product.product_attributes?.country || wine.region?.country?.name || "",
          lcbo_url: `https://www.lcbo.com${product.url || ""}`,
          in_stock: product.availability !== "out_of_stock",
          // Vivino data
          vivino_name: wine.name,
          vivino_score: score,
          vivino_ratings_count: ratingsCount,
          vivino_url: `https://www.vivino.com/wines/${wine.id}`,
          // Value
          raw_value_score: rawValue,
          value_score: 0, // normalized below
          exceptional_value: false,
        };
      } catch {
        return null;
      }
    });

    const results = (await Promise.all(matchPromises)).filter(Boolean);

    // 3. Normalize value scores to 0–100
    if (results.length > 0) {
      const maxRaw = Math.max(...results.map(r => r.raw_value_score));
      const minRaw = Math.min(...results.map(r => r.raw_value_score));
      const range = maxRaw - minRaw || 1;

      results.forEach(r => {
        r.value_score = Math.round(((r.raw_value_score - minRaw) / range) * 100);
      });

      // Flag top 25% with vivino score >= 4.0
      const threshold = 75;
      results.forEach(r => {
        r.exceptional_value = r.value_score >= threshold && r.vivino_score >= 4.0;
      });
    }

    // Sort by value score
    results.sort((a, b) => b.value_score - a.value_score);

    res.json({ success: true, count: results.length, wines: results });

  } catch (err) {
    console.error("Search pipeline error:", err.message);
    res.status(500).json({ error: "Search failed", detail: err.message });
  }
});

// ─── Utility ─────────────────────────────────────────────────────────────────
function extractVintage(name) {
  const match = name.match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : null;
}

app.listen(PORT, () => {
  console.log(`Wine Value Finder API running on port ${PORT}`);
});
