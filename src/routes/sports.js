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
// League ids come from TheSportsDB. To add more, look the league up on
// thesportsdb.com and copy its id.
//
// `broadcastUrl` points at the competition's OFFICIAL site, where the
// legitimate broadcast/stream for a match can be found. We deliberately do
// not embed or proxy any game video: broadcast rights for these
// competitions are exclusively licensed and cost millions, so restreaming
// them would be straightforward copyright infringement. Linking out to the
// rights holder is both legal and genuinely more useful, since it lands
// people on whatever service actually carries the match in their country.
const LEAGUES = {
  soccer: { id: "4328", label: "English Premier League", broadcastUrl: "https://www.premierleague.com/broadcast-schedules" },
  nba: { id: "4387", label: "NBA", broadcastUrl: "https://www.nba.com/schedule" },
  nfl: { id: "4391", label: "NFL", broadcastUrl: "https://www.nfl.com/schedules/" },
  mlb: { id: "4424", label: "MLB", broadcastUrl: "https://www.mlb.com/schedule" },
  volleyball_vnl_men: { id: "5083", label: "FIVB Volleyball Men's Nations League", broadcastUrl: "https://en.volleyballworld.com/volleyball/competitions/vnl-2026/" },
  volleyball_vnl_women: { id: "5084", label: "FIVB Volleyball Women's Nations League", broadcastUrl: "https://en.volleyballworld.com/volleyball/competitions/vnl-2026/" },
  volleyball_superlega: { id: "5122", label: "Italy SuperLega (Volleyball)", broadcastUrl: "https://www.legavolley.it/" },
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

  const normalize = (e) => {
    // Kick-off timestamps let the UI mark a fixture as in progress. Most
    // free feeds don't push live scores second-by-second, so this is an
    // honest "match is happening now" indicator rather than a claim of
    // real-time play-by-play.
    const kickoff = e.strTimestamp ? new Date(e.strTimestamp) : null;
    const now = Date.now();
    const isLive = kickoff
      ? now >= kickoff.getTime() && now <= kickoff.getTime() + 3 * 3600 * 1000 &&
        (e.intHomeScore === null || e.strStatus !== "Match Finished")
      : false;

    return {
      id: e.idEvent,
      homeTeam: e.strHomeTeam,
      awayTeam: e.strAwayTeam,
      homeScore: e.intHomeScore,
      awayScore: e.intAwayScore,
      date: e.dateEvent,
      time: e.strTime,
      timestamp: e.strTimestamp || null,
      venue: e.strVenue,
      status: e.strStatus,
      isLive,
      thumbUrl: e.strThumb || null,
    };
  };

  const upcoming = (nextJson.events || []).map(normalize);
  const recent = (lastJson.events || []).map(normalize);

  const data = {
    league: league.label,
    broadcastUrl: league.broadcastUrl || null,
    upcoming,
    recent,
    // Distinguishes "this league id returned nothing at all" from "this
    // league is simply between seasons". Only 5083 (FIVB Men's VNL) was
    // verified directly against TheSportsDB; the other volleyball ids were
    // inferred, so surface the difference rather than showing a blank tab
    // that looks broken.
    noData: upcoming.length === 0 && recent.length === 0,
    leagueId: league.id,
  };
  cache[leagueKey] = { data, fetchedAt: Date.now() };
  return data;
}

router.get("/leagues", (_req, res) => {
  res.json({
    leagues: Object.entries(LEAGUES).map(([key, v]) => ({
      key, label: v.label, broadcastUrl: v.broadcastUrl || null,
    })),
  });
});

// Fixtures happening right now, across every configured league. Powers the
// "Live now" strip so a match in progress is visible without picking its
// league first. Scores refresh on the client's poll interval.
router.get("/live", async (_req, res) => {
  const results = await Promise.allSettled(
    Object.keys(LEAGUES).map(async (key) => {
      const data = await fetchLeagueEvents(key);
      const all = [...(data?.upcoming || []), ...(data?.recent || [])];
      return all.filter((e) => e.isLive).map((e) => ({ ...e, league: data.league, broadcastUrl: data.broadcastUrl }));
    })
  );
  const live = results.filter((r) => r.status === "fulfilled").flatMap((r) => r.value);
  res.json({ live });
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
