// Google sign-in settings. The client ID is public by design: it only works from the
// web addresses listed for it in the Google Cloud console, and holds no secret.
export const CLIENT_ID = '661147755281-4dvds7ddbjv2ep99ornnh4roo3tucqtu.apps.googleusercontent.com';

// drive.file lets the app see only the files it uploaded itself, nothing else in the Drive.
export const SCOPE = 'https://www.googleapis.com/auth/drive.file';

// Name of the Drive folder uploads are kept in.
export const FOLDER_NAME = 'Reelbox';
