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
// Google Cloud project number; the Drive file picker needs it.
export const APP_ID = '661147755281';
export const FOLDER_ID = '1TrZUldml5bAW4m-xXomH_dg92oAw9or4';

// The hidden manage page (/sign-in) asks for a password. Only a salted hash is kept here.
// The password hides the page; what actually stops anyone else changing the gallery is the
// Google sign-in, which only the folder's owner can pass.
export const ADMIN_SALT = '34ee1bb3a9dd6fe334cf5efb9404cdf7';
export const ADMIN_HASH = '5cf90ebadfc50941fe36b47c85552798c10b4c0928541adfc98cc8af4274743c';
