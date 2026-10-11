// Works out a video's details from its file name, so new videos arrive already filled in.
//   "Road.Trip.S01E02.Night.Market.1080p.mp4"  ->  series "Road Trip", season 1, episode 2, title "Night Market"
//   "my_birthday_party (1).mov"                ->  title "My Birthday Party"

// Download and camera leftovers that are never part of a title; everything from the first one on is dropped.
const JUNK = /[\s([]+(?:2160p|1080p|720p|480p|360p|4k|uhd|hdr|x26[45]|h\.?26[45]|hevc|web-?rip|web-?dl|blu-?ray|brrip|dvdrip|hdtv|aac|final cut|final)\b.*$/i;

function clean(text) {
  let t = text.replace(/_/g, ' ');
  if (!/\s/.test(t)) t = t.replace(/\./g, ' '); // dots used as spaces: "Road.Trip.Night"
  t = t.replace(JUNK, '')
    .replace(/\s*\((?:\d{1,2}|copy)\)\s*$/i, '') // "(1)" and "(copy)" added by downloads
    .replace(/\s+copy$/i, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—.:]+|[\s\-–—.:]+$/g, '');
  // A name typed all in one case gets capitals; one with its own capitals is left alone.
  const shouting = t === t.toUpperCase() && t.replace(/[^A-Z]/g, '').length >= 6; // not camera names like IMG 4821
  if (t && (t === t.toLowerCase() || shouting)) t = t.toLowerCase().replace(/(^|[\s\-(])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  return t;
}

// The ways people number episodes, most specific first. Each gives: series, season, episode, title.
const PATTERNS = [
  [/^(.*?)[\s._\-–]*\bs(\d{1,2})[\s._\-–]*e(?:p(?:isode)?)?[\s._\-–]*(\d{1,3})\b(.*)$/i, m => [m[1], m[2], m[3], m[4]]], // S01E02, s1 e2, S01.EP02
  [/^(.*?)[\s._\-–]+(\d{1,2})x(\d{1,3})\b(.*)$/i, m => [m[1], m[2], m[3], m[4]]], // 1x02
  [/^(.*?)[\s._\-–]*\bseason[\s._\-–]*(\d{1,2})[\s._\-–,]*(?:episode|ep|part|pt)\.?[\s._\-–]*(\d{1,3})\b(.*)$/i, m => [m[1], m[2], m[3], m[4]]], // Season 1 Episode 2
  [/^(.*?)[\s._\-–]*\b(?:episode|ep|part|pt)\.?[\s._\-–#]*(\d{1,3})\b(.*)$/i, m => [m[1], 1, m[2], m[3]]], // Episode 2, Ep. 2, Part 2
  [/^(.+?)\s+[-–]\s+#?(\d{1,3})(?:\s+[-–]\s+(.*))?$/, m => [m[1], 1, m[2], m[3] || '']], // "Road Trip - 02 - Night Market"
];

export function guessDetails(fileName) {
  const base = fileName.replace(/\.[a-z0-9]{2,5}$/i, '');
  const spaced = /\s/.test(base) ? base : base.replace(/[._]/g, ' ');
  for (const [pattern, read] of PATTERNS) {
    const m = pattern.exec(spaced);
    if (!m) continue;
    const [series, season, episode, rest] = read(m);
    const name = clean(series);
    if (!name) continue; // a number with no series name in front of it isn't an episode
    return { title: clean(rest) || `Episode ${Number(episode)}`, series: name, season: Number(season) || 1, episode: Number(episode) };
  }
  return { title: clean(base) || base };
}
