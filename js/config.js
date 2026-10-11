// Google settings. None of these are secrets: the client ID and API key only work from the
// web addresses listed for them in the Google Cloud console.

// Lets the owner sign in to upload.
export const CLIENT_ID = '661147755281-4dvds7ddbjv2ep99ornnh4roo3tucqtu.apps.googleusercontent.com';

// drive.file lets the app see only the files it uploaded itself, nothing else in the Drive.
export const SCOPE = 'https://www.googleapis.com/auth/drive.file';

// Name of the Drive folder uploads are kept in.
export const FOLDER_NAME = 'Reelbox';

// Public gallery: with both of these filled in, anyone who opens the site can watch every
// video in the folder without signing in. Only the folder's owner can add or change videos.
// API_KEY is a read-only Google API key (restricted to the Drive API and this site).
// FOLDER_ID is the ID of the owner's "Reelbox" Drive folder; the app shows it after the
// owner's first sign-in.
export const API_KEY = '';
export const FOLDER_ID = '';
