# Reelbox

A public video gallery with a full player. The owner uploads videos to their own Google
Drive; anyone who opens the site can watch them, with no sign-in.
Live at **https://just-rice.github.io/video-player/**

## What it does

- **Anyone can watch.** Visitors see every video in the gallery and can copy a link to one.
- **Only the owner can upload.** "Owner sign-in" uses Google; the app checks that the account
  owns the gallery folder before showing Upload, Rename and Delete.
- **Player:** seek bar with buffering and hover time, play/pause, ±10 s, next video, volume and
  mute, speed (0.25× to 2×), loop, subtitles, quality, picture in picture, full screen,
  keyboard shortcuts, and it remembers volume, speed and where you stopped on each device.
- **Subtitles:** the owner adds a `.srt` or `.vtt` file from the CC menu and it is saved beside
  the video for every viewer. Visitors can also load a subtitle file just for themselves.
- **Quality:** "Original" plays the uploaded file. "Auto / lower quality" switches to Google
  Drive's own player, which offers the smaller versions Drive makes of each video. The app
  itself stores one copy of each video, so it cannot switch resolutions inside its own player.
- **Uploads** go in 16 MB pieces, so large files work and a dropped connection resumes.

## How it works

Plain HTML, CSS and JavaScript. No build step and no server of its own.

| File | Job |
| --- | --- |
| `js/config.js` | Google client ID, API key and gallery folder ID |
| `js/drive.js` | Owner sign-in and all Google Drive calls |
| `js/app.js` | The screens: library, player, upload queue |
| `sw.js` | Only used before the gallery is public: lets the owner play private files |

Videos live in one Drive folder ("Reelbox") that is shared as "anyone with the link can
view". Visitors read that folder with a read-only API key. The app asks the owner for the
`drive.file` permission only, so it can touch the files it uploaded and nothing else in the
Drive. Subtitles are stored as `sub.<video id>.<label>.vtt` in the same folder.

## Setup (one time)

1. **API key:** in the Google Cloud project `reelbox-511219`, APIs & Services → Credentials →
   Create credentials → API key. Restrict it to the Google Drive API and to the website
   `https://just-rice.github.io/*`. Put it in `API_KEY` in `js/config.js`.
2. **Folder ID:** open the site, use the owner sign-in, and the bar at the top shows the
   folder ID. Put it in `FOLDER_ID` in `js/config.js`.

Until both are filled in, visitors see a "being set up" page and only the owner can use it.

The Google sign-in is in **Testing** mode, so only accounts listed under *Google Auth
Platform → Audience → Test users* can sign in at all.

## Running it locally

```
python3 -m http.server 8765
```

then open http://localhost:8765 (that address is already allowed for sign-in).
