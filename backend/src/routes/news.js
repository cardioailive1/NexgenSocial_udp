const express = require("express");
const Parser = require("rss-parser");

const router = express.Router();
const parser = new Parser({ timeout: 8000 });

// These are each network's own public RSS feed, meant for syndication --
// we're pulling headline + link + short description, never full article
// text. That's the standard, legal way news aggregators (Google News,
// Apple News, RSS readers) work: attribute and link out, don't republish.
// Swap/add sources here freely; if a feed URL changes or goes down, that
// source is silently skipped rather than failing the whole request.
const SOURCES = [
  { name: "ABC News", url: "https://abcnews.go.com/abcnews/topstories" },
  { name: "CNN", url: "http://rss.cnn.com/rss/cnn_topstories.rss" },
  { name: "MSNBC", url: "https://feeds.nbcnews.com/nbcnews/public/news" },
  { name: "BBC News", url: "http://feeds.bbci.co.uk/news/rss.xml" },
];

let cache = { data: null, fetchedAt: 0 };
const CACHE_MS = 5 * 60 * 1000; // 5 minutes -- polite to the source servers, still feels live

async function fetchAll() {
  const results = await Promise.allSettled(
    SOURCES.map(async (source) => {
      const feed = await parser.parseURL(source.url);
      return (feed.items || []).slice(0, 8).map((item) => ({
        source: source.name,
        title: item.title,
        link: item.link,
        description: (item.contentSnippet || item.summary || "").slice(0, 220),
        publishedAt: item.isoDate || item.pubDate || null,
      }));
    })
  );

  const items = results.filter((r) => r.status === "fulfilled").flatMap((r) => r.value);
  items.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));

  const failedSources = SOURCES.filter((_, i) => results[i].status === "rejected").map((s) => s.name);
  return { items, failedSources };
}

router.get("/breaking", async (_req, res) => {
  const isStale = Date.now() - cache.fetchedAt > CACHE_MS;
  if (!cache.data || isStale) {
    try {
      cache = { data: await fetchAll(), fetchedAt: Date.now() };
    } catch (err) {
      if (!cache.data) {
        return res.status(502).json({ error: "Couldn't reach any news sources right now." });
      }
    }
  }
  res.json({ ...cache.data, cachedAt: new Date(cache.fetchedAt).toISOString() });
});

module.exports = router;
