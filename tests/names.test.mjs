import { guessDetails as g } from '../js/names.js';
const cases = [
  ['Road.Trip.S01E02.Night.Market.1080p.WEBRip.x264.mp4', { title: 'Night Market', series: 'Road Trip', season: 1, episode: 2 }],
  ['Road Trip S2E10 - Coast Walk.mov', { title: 'Coast Walk', series: 'Road Trip', season: 2, episode: 10 }],
  ['road_trip_s01e03.mp4', { title: 'Episode 3', series: 'Road Trip', season: 1, episode: 3 }],
  ['Cooking Show - 1x04 - Pasta.mp4', { title: 'Pasta', series: 'Cooking Show', season: 1, episode: 4 }],
  ['Cooking Show Season 2 Episode 5 - Soup.mp4', { title: 'Soup', series: 'Cooking Show', season: 2, episode: 5 }],
  ['Piano Lessons Ep 7.mp4', { title: 'Episode 7', series: 'Piano Lessons', season: 1, episode: 7 }],
  ['Piano Lessons - Episode 12 - Scales.mp4', { title: 'Scales', series: 'Piano Lessons', season: 1, episode: 12 }],
  ['Vlog Part 3.mp4', { title: 'Episode 3', series: 'Vlog', season: 1, episode: 3 }],
  ['Road Trip - 02 - Night Market.mp4', { title: 'Night Market', series: 'Road Trip', season: 1, episode: 2 }],
  ['Road Trip - 05.mp4', { title: 'Episode 5', series: 'Road Trip', season: 1, episode: 5 }],
  ['my_birthday_party (1).mov', { title: 'My Birthday Party' }],
  ['Birthday 2026.mp4', { title: 'Birthday 2026' }],
  ['IMG_4821.MOV', { title: 'IMG 4821' }],
  ['Harbour at dawn.mp4', { title: 'Harbour at dawn' }],
  ['S01E02 - Pilot.mp4', { title: 'S01E02 - Pilot' }],
  ['The Departed 1080p BluRay.mkv', { title: 'The Departed' }],
  ['holiday.video.final.mp4', { title: 'Holiday Video' }],
  ['Episode 3.mp4', { title: 'Episode 3' }],
  ['Top 10 Recipes.mp4', { title: 'Top 10 Recipes' }],
  ['Step by step guide.mp4', { title: 'Step by step guide' }],
  ['MY HOLIDAY VIDEO.mp4', { title: 'My Holiday Video' }],
  ['Apartment tour.mp4', { title: 'Apartment tour' }],
  ['Kids - Sports Day.mp4', { title: 'Kids - Sports Day' }],
  ['2026-10-09 14.32.10.mp4', { title: '2026-10-09 14.32.10' }],
  ['Screen Recording 2026-10-09 at 2.32.10 PM.mov', { title: 'Screen Recording 2026-10-09 at 2.32.10 PM' }],
];
let bad = 0;
for (const [name, want] of cases) {
  const got = g(name);
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { bad++; console.log('FAIL', name, '\n   got ', JSON.stringify(got), '\n   want', JSON.stringify(want)); }
}
console.log(bad ? `${bad} failed of ${cases.length}` : `all ${cases.length} passed`);
