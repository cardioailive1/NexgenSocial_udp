const express = require("express");

const router = express.Router();

// TheSportsDB's shared free "test" key ("3") is publicly documented by them
// for exactly this kind of evaluation use -- no signup required. It's
// rate-limited and meant for testing, not production traffic: get your own
// free (or paid, for higher limits) key at thesportsdb.com/api.php and set
// SPORTSDB_API_KEY to swap it in with zero code changes.
const API_KEY = process.env.SPORTSDB_API_KEY || "3";
const BASE_URL = `https://www.thesportsdb.com/api/v1/json/${API_KEY}`;

// A small curated set of major leagues. Add more by looking up a league's
// ID at thesportsdb.com (search_all_leagues.php) and adding it here.
const LEAGUES = {
  soccer: { id: "4328", label: "English Premier League" },
  nba: { id: "4387", label: "NBA" },
  nfl: { id: "4391", label: "NFL" },
  mlb: { id: "4424", label: "MLB" },
};

let cache = {}; // keyed by league key, { data, fetchedAt }
const CACHE_MS = 3 * 60 * 1000;

async function fetchLeagueEvents(leagueKey) {
  const league = LEAGUES[leagueKey];
  if (!league) return null;

  const cached = cache[leagueKey];
  if (cached && Date.now() - cached.fetchedAt < CACHE_MS) return cached.data;

  const [nextRes, lastRes] = await Promise.all([
    fetch(`${BASE_URL}/eventsnextleague.php?id=${league.id}`),
    fetch(`${BASE_URL}/eventspastleague.php?id=${league.id}`),
  ]);
  const [nextJson, lastJson] = await Promise.all([nextRes.json(), lastRes.json()]);

  const normalize = (e) => ({
    id: e.idEvent,
    homeTeam: e.strHomeTeam,
    awayTeam: e.strAwayTeam,
    homeScore: e.intHomeScore,
    awayScore: e.intAwayScore,
    date: e.dateEvent,
    time: e.strTime,
    venue: e.strVenue,
    status: e.strStatus,
  });

  const data = {
    league: league.label,
    upcoming: (nextJson.events || []).map(normalize),
    recent: (lastJson.events || []).map(normalize),
  };
  cache[leagueKey] = { data, fetchedAt: Date.now() };
  return data;
}

router.get("/leagues", (_req, res) => {
  res.json({ leagues: Object.entries(LEAGUES).map(([key, v]) => ({ key, label: v.label })) });
});

router.get("/scores", async (req, res) => {
  const leagueKey = req.query.league || "soccer";
  try {
    const data = await fetchLeagueEvents(leagueKey);
    if (!data) return res.status(400).json({ error: "Unknown league. See /api/sports/leagues for options." });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: "Couldn't reach the sports data provider right now." });
  }
});

module.exports = router;
