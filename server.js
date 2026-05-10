const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "application/json, text/plain, */*",
  "Accept-Language": "en-CA,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
};

const VIVINO_HEADERS = {
  ...HEADERS,
  "Referer": "https://www.vivino.com/",
  "Accept": "application/json",
};

const LCBO_HEADERS = {
  ...HEADERS,
  "Referer": "https://www.lcbo.com/",
};

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Wine Value Finder API is running", version: "2.0" });
});

// Utility: extract year from wine name
function extractVintage(name) {
  const match = (name || "").match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : null;
}

// Utility: normalize value scores to 0-100 and rank
function normalizeAndRank(results) {
  if (results.length === 0) return results;
  const maxRaw = Math.max(...results.map(r => r.raw_value_score));
  const minRaw = Math.min(...results.map(r => r.raw_value_score));
  const range = maxRaw - minRaw || 1;
  results.forEach(r => {
    r.value_score = Math.round(((r.raw_value_score - minRaw) / range) * 100);
    r.exceptional_value = r.value_score >= 75 && r.vivino_score >= 4.0;
  });
  results.sort((a, b) => b.value_score - a.value_score);
  return results;
}

// Match a wine name against Vivino, return score data
async function getVivinoScore(name, vintage) {
  const query = vintage ? `${name} ${vintage}` : name;
  const url = `https://www.vivino.com/api/wines/search?q=${encodeURIComponent(query)}&language=en`;
  const res = await axios.get(url, { headers: VIVINO_HEADERS, timeout: 9000 });
  const matches = res.data?.explore_vintage?.matches || [];
  if (matches.length === 0) return null;

  let best = matches[0];
  if (vintage) {
    const vintageMatch = matches.find(m => m.vintage?.year?.toString() === vintage.toString());
    if (vintageMatch) best = vintageMatch;
  }

  const wine = best.vintage?.wine || best;
  const vData = best.vintage || best;
  const score = parseFloat(vData.statistics?.ratings_average || wine.statistics?.ratings_average || 0);
  const ratingsCount = parseInt(vData.statistics?.ratings_count || wine.statistics?.ratings_count || 0);

  return {
    vivino_name: wine.name,
    winery: wine.winery?.name,
    vivino_score: score,
    vivino_ratings_count: ratingsCount,
    vivino_url: `https://www.vivino.com/wines/${wine.id}`,
    vivino_vintage: vData.year,
  };
}

// Build a unified wine result from LCBO product + Vivino data
function buildWineResult(product, vivino) {
  const name = product.name || product.title || "";
  const vintage = extractVintage(name) || product.product_attributes?.vintage_year || vivino?.vivino_vintage;
  const price = parseFloat(product.price || product.regular_price || 0);
  const score = vivino?.vivino_score || 0;
  const ratingsCount = vivino?.vivino_ratings_count || 0;

  const rawValue = price > 0 && score > 0
    ? Math.pow(score, 2.5) * Math.log(Math.max(ratingsCount, 1)) / price
    : 0;

  return {
    name,
    sku: product.id || product.product_no || product.sku,
    price,
    vintage,
    varietal: product.product_attributes?.varietal || product.varietal || "",
    region: product.product_attributes?.region || product.region || "",
    country: product.product_attributes?.country || product.country || "",
    lcbo_url: product.url ? `https://www.lcbo.com${product.url}` : "",
    in_stock: product.availability !== "out_of_stock",
    is_vintages: product.is_vintages || false,
    vivino_name: vivino?.vivino_name || "",
    vivino_score: score,
    vivino_ratings_count: ratingsCount,
    vivino_url: vivino?.vivino_url || "",
    raw_value_score: rawValue,
    value_score: 0,
    exceptional_value: false,
  };
}

// Fetch LCBO products with multiple endpoint fallbacks
async function fetchLCBOProducts({ q, minPrice, maxPrice, vintagesOnly, page = 1, perPage = 24 }) {
  const strategies = [];

  if (vintagesOnly) {
    strategies.push(
      `https://www.lcbo.com/api/2.0/products.json?collection_id=vintages&product_type=red_wine&per_page=${perPage}&page=${page}`,
      `https://www.lcbo.com/api/2.0/products.json?q=vintages+red+wine&per_page=${perPage}&page=${page}&facets[collection][]=Vintages`,
      `https://www.lcbo.com/api/2.0/products.json?q=red+wine+vintages&per_page=${perPage}&page=${page}`,
    );
  }

  const baseQ = q || "red wine";
  strategies.push(
    `https://www.lcbo.com/api/2.0/products.json?q=${encodeURIComponent(baseQ)}&per_page=${perPage}&page=${page}`,
    `https://www.lcbo.com/api/2.0/json/search?q=${encodeURIComponent(baseQ)}&per_page=${perPage}&p=${page}`,
  );

  let products = [];
  for (const url of strategies) {
    try {
      const res = await axios.get(url, { headers: LCBO_HEADERS, timeout: 12000 });
      const raw = res.data?.result || res.data?.products || res.data?.items || [];
      if (raw.length > 0) { products = raw; break; }
    } catch (e) { continue; }
  }

  if (minPrice) products = products.filter(p => parseFloat(p.price || p.regular_price || 0) >= parseFloat(minPrice));
  if (maxPrice) products = products.filter(p => parseFloat(p.price || p.regular_price || 0) <= parseFloat(maxPrice));

  return products.map(p => ({
    ...p,
    is_vintages: !!(
      p.collection === "vintages" ||
      p.tags?.includes("vintages") ||
      (p.product_attributes?.collection || "").toLowerCase().includes("vintage") ||
      (p.name || "").match(/\b(19|20)\d{2}\b/)
    ),
  }));
}

// ─── /api/search — search by wine name ───────────────────────────────────────
app.get("/api/search", async (req, res) => {
  const { q, minPrice, maxPrice } = req.query;
  if (!q) return res.status(400).json({ error: "Missing query" });

  try {
    const products = await fetchLCBOProducts({ q, minPrice, maxPrice, perPage: 12 });
    if (products.length === 0) return res.json({ success: true, count: 0, wines: [] });

    const matchPromises = products.slice(0, 10).map(async (product) => {
      const name = product.name || product.title || "";
      const vintage = extractVintage(name) || product.product_attributes?.vintage_year;
      try {
        const vivino = await getVivinoScore(name, vintage);
        if (!vivino) return null;
        return buildWineResult(product, vivino);
      } catch { return null; }
    });

    const results = normalizeAndRank((await Promise.all(matchPromises)).filter(Boolean));
    res.json({ success: true, count: results.length, wines: results });
  } catch (err) {
    res.status(500).json({ error: "Search failed", detail: err.message });
  }
});

// ─── /api/discover — filter-first discovery (Vintages + price + score) ────────
// Params: vintagesOnly, minPrice, maxPrice, minScore, pages (1-5)
app.get("/api/discover", async (req, res) => {
  const {
    vintagesOnly = "true",
    minPrice = "20",
    maxPrice = "40",
    minScore = "4.0",
    pages = "2",
  } = req.query;

  const minScoreNum = parseFloat(minScore);
  const pageCount = Math.min(parseInt(pages) || 2, 5);

  try {
    // Fetch multiple LCBO pages in parallel
    const pageNums = Array.from({ length: pageCount }, (_, i) => i + 1);
    const pageFetches = pageNums.map(page =>
      fetchLCBOProducts({
        q: vintagesOnly === "true" ? "red wine vintages" : "red wine",
        minPrice,
        maxPrice,
        vintagesOnly: vintagesOnly === "true",
        page,
        perPage: 24,
      }).catch(() => [])
    );

    const pagesData = await Promise.all(pageFetches);
    let allProducts = pagesData.flat();

    // Deduplicate
    const seen = new Set();
    allProducts = allProducts.filter(p => {
      const key = p.id || p.product_no || p.name;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (allProducts.length === 0) {
      return res.json({
        success: false,
        count: 0,
        wines: [],
        scanned: 0,
        message: "No LCBO products found for those filters.",
      });
    }

    // Match Vivino scores in batches of 8 (parallel but rate-limit friendly)
    const CONCURRENCY = 8;
    const results = [];
    for (let i = 0; i < allProducts.length; i += CONCURRENCY) {
      const batch = allProducts.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async (product) => {
          const name = product.name || product.title || "";
          const vintage = extractVintage(name) || product.product_attributes?.vintage_year;
          try {
            const vivino = await getVivinoScore(name, vintage);
            if (!vivino || vivino.vivino_score < minScoreNum) return null;
            return buildWineResult(product, vivino);
          } catch { return null; }
        })
      );
      results.push(...batchResults.filter(Boolean));
    }

    const ranked = normalizeAndRank(results);

    res.json({
      success: true,
      count: ranked.length,
      scanned: allProducts.length,
      filters: { vintagesOnly, minPrice, maxPrice, minScore },
      wines: ranked,
    });

  } catch (err) {
    console.error("Discover error:", err.message);
    res.status(500).json({ error: "Discovery failed", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Wine Value Finder API v2.0 running on port ${PORT}`);
});
