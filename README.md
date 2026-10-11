# Reelbox

A public video gallery with a full player. The owner uploads videos to their own Google
Drive; anyone who opens the site can watch them, with no sign-in.
Live at **https://just-rice.github.io/video-player/**

## What it does

- **Home page:** a featured video across the top, then shelves: Continue watching, My List,
  New, and one per category, with every video's name and picture. A search bar looks through
  titles, descriptions and categories. Anyone can watch, no sign-in. Continue watching and
  My List are remembered per device.
- **Series:** give videos the same series name, with a season and episode number, and they
  become one card on the home page that opens an episode list by season. The player shows
  the episode list beside the video and plays the next episode automatically.
- **Up next:** when a video ends, the next one starts after a five-second countdown.
- **Hidden manage page** at `/sign-in`: asks for the owner password, then the owner's Google
  sign-in. From there the owner can upload videos, add videos that are already in their
  Google Drive, and set each one's title, description, category, thumbnail and subtitles, feature it, or remove it.
- **Player:** seek bar with buffering and hover time, play/pause, ±10 s, next video, volume and
  mute, speed (0.25× to 2×), loop, subtitles, quality, picture in picture, full screen,
  keyboard shortcuts, and it remembers volume, speed and where you stopped on each device.
- **Quality:** "Original" plays the stored file. "Auto / lower quality" switches to Google
  Drive's own player, which offers the smaller versions Drive makes of each video.
- **Uploads** go in 16 MB pieces, so large files work and a dropped connection resumes.

**About the password:** this is a static site, so the password check runs in the browser and
only hides the manage page. What actually stops anyone else changing the gallery is Google:
only the Google account that owns the folder can write to it. The repo holds a salted hash,
never the password. To change it, generate a new salt and PBKDF2-SHA256 hash (200,000 rounds)
and replace `ADMIN_SALT` / `ADMIN_HASH` in `js/config.js`.

## How it works

Plain HTML, CSS and JavaScript. No build step and no server of its own.

| File | Job |
| --- | --- |
| `js/config.js` | Google client ID, API key and gallery folder ID |
| `js/drive.js` | Owner sign-in and all Google Drive calls |
| `js/app.js` | The screens: library, player, upload queue |
| `sw.js` | Only used before the gallery is public: lets the owner play private files |

The gallery is one small file, `gallery.json`, in a Drive folder ("Reelbox") shared as
"anyone with the link can view". It lists each video with its title, description, thumbnail
and subtitles. Visitors read it with a read-only API key. Videos picked from elsewhere in
Drive stay where they are and are made viewable by link one at a time. The app asks the owner for the
`drive.file` permission only, so it can touch the files it uploaded and nothing else in the
Drive, plus the videos the owner picks in Google's file chooser.

## Setup (one time)

1. **API key:** in the Google Cloud project `reelbox-511219`, APIs & Services → Credentials →
   Create credentials → API key. Restrict it to the Google Drive API and to the website
   `https://just-rice.github.io/*`. Put it in `API_KEY` in `js/config.js`.
2. **Picker:** enable the "Google Picker API" in the same project (needed for "Add from
   Google Drive").
3. **Folder ID:** open `/sign-in`, unlock and sign in; the yellow box shows the folder ID. Put it in `FOLDER_ID` in `js/config.js`.

Until the key and folder ID are filled in, visitors see an empty gallery.

The Google sign-in is in **Testing** mode, so only accounts listed under *Google Auth
Platform → Audience → Test users* can sign in at all.

## Running it locally

```
python3 -m http.server 8765
```

then open http://localhost:8765 (that address is already allowed for sign-in).
