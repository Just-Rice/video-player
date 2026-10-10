# Reelbox

A video player that saves your videos to your own Google account.
Live at **https://just-rice.github.io/video-player/**

Sign in with Google, upload video files (drag and drop works), and they are stored in a
"Reelbox" folder in your Google Drive. Sign in on any other device and they are all there,
including the spot where you stopped watching.

## What it does

- **Uploads to your Drive** in 16 MB pieces, so large files work and a dropped connection
  resumes instead of starting over.
- **Plays straight from Drive** with seeking, speed control, keyboard shortcuts and
  auto-play of the next video.
- **Remembers your place** per video, across devices.
- Search, sort, rename, download and delete (delete moves the file to the Drive bin).
- **Share one video by link.** The Share button makes that single file viewable by anyone
  with the link (no sign-in), and nothing else in the library or the Drive. Stop sharing
  switches the link off again.

## How it works

Plain HTML, CSS and JavaScript. No build step and no server of its own.

| File | Job |
| --- | --- |
| `js/drive.js` | Google sign-in and all Google Drive calls |
| `js/app.js` | The screens: library, player, upload queue |
| `sw.js` | Lets the `<video>` tag play private Drive files (it adds the sign-in token to each request and passes byte ranges through so seeking works) |
| `js/config.js` | The Google client ID and folder name |

The app asks for the `drive.file` permission only, which means it can see the files it
uploaded itself and nothing else in the Drive. Google sign-ins from a web page last one
hour; after that the app shows a Reconnect button.

## Running it locally

```
python3 -m http.server 8765
```

then open http://localhost:8765 (that address is already allowed for sign-in).

## Google setup

The sign-in belongs to the Google Cloud project `reelbox-511219` (Drive API enabled, one
"Web application" OAuth client). It is in **Testing** mode, so only Google accounts listed
under *Google Auth Platform → Audience → Test users* can sign in. Add an address there to
let another account use the app.
