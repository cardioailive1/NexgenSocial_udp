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
// League ids are TheSportsDB's. The ones below are taken from their
// published dataset rather than guessed -- an id that doesn't exist returns
// an empty list, which looks identical to "between seasons" and is
// frustrating to debug. `verified: false` marks entries inferred rather
// than confirmed, and the UI says so instead of showing a silent blank.
//
// To add more: look the league up on thesportsdb.com/sport/leagues, copy
// its id, and add a row here.
const LEAGUES = {
  // --- Soccer / Football ---
  epl:        { id: "4328", label: "English Premier League", sport: "Soccer", verified: true,  broadcastUrl: "https://www.premierleague.com/broadcast-schedules" },
  laliga:     { id: "4335", label: "Spanish La Liga",        sport: "Soccer", verified: true,  broadcastUrl: "https://www.laliga.com/en-GB" },
  seriea:     { id: "4332", label: "Italian Serie A",        sport: "Soccer", verified: true,  broadcastUrl: "https://www.legaseriea.it/en" },
  bundesliga: { id: "4331", label: "German Bundesliga",      sport: "Soccer", verified: true,  broadcastUrl: "https://www.bundesliga.com/en/bundesliga" },
  ligue1:     { id: "4334", label: "French Ligue 1",         sport: "Soccer", verified: true,  broadcastUrl: "https://www.ligue1.com/" },
  eredivisie: { id: "4337", label: "Dutch Eredivisie",       sport: "Soccer", verified: true,  broadcastUrl: "https://eredivisie.nl/" },
  greece:     { id: "4336", label: "Greek Super League",     sport: "Soccer", verified: true,  broadcastUrl: "https://www.slgr.gr/en/" },
  mls:        { id: "4346", label: "Major League Soccer",    sport: "Soccer", verified: true,  broadcastUrl: "https://www.mlssoccer.com/schedule/scores" },

  // --- American sports ---
  nfl:  { id: "4391", label: "NFL",  sport: "American Football", verified: true, broadcastUrl: "https://www.nfl.com/schedules/" },
  // NCAA football. These ids were NOT confirmed against TheSportsDB (their
  // API wasn't reachable from the build environment), so they're flagged
  // unverified -- an empty tab will say so rather than looking broken.
  // Verify at thesportsdb.com/sport/leagues and correct if needed.
  ncaaf: { id: "4479", label: "NCAA Football (FBS)", sport: "American Football", verified: false, broadcastUrl: "https://www.ncaa.com/scoreboard/football/fbs" },
  bigten: { id: "4924", label: "Big Ten Conference", sport: "American Football", verified: false, broadcastUrl: "https://bigten.org/calendar.aspx?path=football" },
  nba:  { id: "4387", label: "NBA",  sport: "Basketball",        verified: true, broadcastUrl: "https://www.nba.com/schedule" },
  mlb:  { id: "4424", label: "MLB",  sport: "Baseball",          verified: true, broadcastUrl: "https://www.mlb.com/schedule" },
  nhl:  { id: "4380", label: "NHL",  sport: "Ice Hockey",        verified: true, broadcastUrl: "https://www.nhl.com/schedule" },

  // --- Volleyball ---
  vnl_men:   { id: "5083", label: "FIVB Men's Nations League",   sport: "Volleyball", verified: true,  broadcastUrl: "https://en.volleyballworld.com/" },
  vnl_women: { id: "5084", label: "FIVB Women's Nations League", sport: "Volleyball", verified: false, broadcastUrl: "https://en.volleyballworld.com/" },
  superlega: { id: "5122", label: "Italy SuperLega",             sport: "Volleyball", verified: false, broadcastUrl: "https://www.legavolley.it/" },
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
    sport: league.sport,
    verified: league.verified !== false,
  };
  cache[leagueKey] = { data, fetchedAt: Date.now() };
  return data;
}

router.get("/leagues", (_req, res) => {
  res.json({
    leagues: Object.entries(LEAGUES).map(([key, v]) => ({
      key, label: v.label, sport: v.sport, verified: v.verified !== false,
      broadcastUrl: v.broadcastUrl || null,
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
