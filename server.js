const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

const PORT = process.env.PORT || 3001;

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Wine Value Finder API is running", version: "3.0" });
});

// Proxy the Anthropic API call server-side (avoids CORS)
app.post("/api/wines", async (req, res) => {
  const { vintagesOnly, minPrice, maxPrice, minScore, wineType } = req.body;

  const prompt = `You are an expert on LCBO Vintages wines and Vivino community scores. Generate a list of 12 real wines that:
- Are ${vintagesOnly ? 'from the LCBO Vintages collection (premium curated selection)' : 'available at LCBO'}
- Are ${wineType === 'any' ? 'any colour' : wineType + ' wines'}
- Priced between $${minPrice}–$${maxPrice} CAD at LCBO
- Have a Vivino community score of ${minScore} or higher
- Are well-known enough to have substantial Vivino ratings (1000+ ratings minimum)

For each wine provide accurate real data:
- name: producer + wine name
- vintage: year (e.g. "2020") or "NV"
- varietal: grape variety
- region: appellation/region
- country: country
- lcbo_price: realistic LCBO price in CAD between ${minPrice} and ${maxPrice}
- vivino_score: real Vivino score (must be >= ${minScore}, between ${minScore} and 4.6)
- vivino_ratings_count: realistic number (1000–500000)
- lcbo_sku: plausible 6-7 digit LCBO product number
- tasting_notes: one sentence
- food_pairing: best match

Then compute for each:
  raw_value = vivino_score^2.5 * ln(vivino_ratings_count) / lcbo_price
Normalize all raw_value scores to 0–100 scale as value_score.
Set exceptional_value: true for wines in top 25% AND vivino_score >= 4.0.

Respond ONLY with valid JSON, no markdown, no explanation:
{
  "wines": [
    {
      "name": "", "vintage": "", "varietal": "", "region": "", "country": "",
      "lcbo_price": 0.0, "vivino_score": 0.0, "vivino_ratings_count": 0,
      "lcbo_sku": "", "tasting_notes": "", "food_pairing": "",
      "value_score": 0, "exceptional_value": false
    }
  ]
}`;

  try {
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 3000,
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        timeout: 30000,
      }
    );

    const text = response.data.content?.find(b => b.type === "text")?.text || "";
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    res.json({ success: true, ...parsed });
  } catch (err) {
    console.error("API error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Wine Value Finder API v3.0 running on port ${PORT}`);
});
