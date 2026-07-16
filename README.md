# YouTubeToSoferAI

YouTubeToSoferAI is a command-line tool for turning YouTube shiurim or lectures into readable transcript documents using the Sofer.ai transcription API.

The app can:

* Create a CSV of videos from a YouTube channel
* Download YouTube videos as local MP3 audio files
* Upload the audio files to Sofer.ai for transcription
* Check transcription status
* Download completed transcripts as Markdown, DOCX, and JSON files
* Package the whole app into a portable Windows release that does not require the end user to install Node.js

## Project Purpose

This project was built to make it easier to process large collections of YouTube shiurim or lectures.

Instead of manually downloading videos, uploading them one by one, checking their status, and saving the results, this tool provides a repeatable local workflow:

```text
YouTube channel
    → CSV of videos
    → downloaded MP3 audio
    → Sofer.ai transcription
    → transcript documents
```

The production build is designed to be sent to a non-developer user as a zip file. The user extracts the folder, runs the executable, and does not need Node.js installed on their machine.

## Tech Stack

* Node.js
* TypeScript
* Commander
* Axios
* yt-dlp via `youtube-dl-exec`
* FFmpeg / FFprobe
* Sofer.ai API
* esbuild
* Node SEA
* postject

## Requirements for Development

To work on this project locally, you need:

* Node.js 22+
* npm
* A Sofer.ai API key

The production user does **not** need Node.js. Node is only required for development and building releases.

## Clone the Project

```powershell
git clone https://github.com/ChanochW/YoutubeToSoferAI.git
cd YoutubeToSoferAI
```

Install dependencies:

```powershell
npm install
```

## Environment Setup

Create a `.env` file by running:

```powershell
tsx src/index.ts init YOUR_SOFER_API_KEY
```

This creates:

```text
.env
```

with:

```env
SOFER_API_KEY=your_key_here
```

Do not commit `.env`.

## Preparing Helper Binaries in Development

The app depends on three helper binaries:

```text
yt-dlp.exe
ffmpeg.exe
ffprobe.exe
```

In development, these are copied from `node_modules` into a generated local `bin/` folder.

Run:

```powershell
npm run prepare:binaries
```

This creates:

```text
bin/
├── yt-dlp.exe
├── ffmpeg.exe
└── ffprobe.exe
```

The `bin/` folder is generated and should not be committed.

## Running in Development

You can run the CLI directly with `tsx`.

Show help:

```powershell
tsx src/index.ts --help
```

Initialize the API key:

```powershell
tsx src/index.ts init YOUR_SOFER_API_KEY
```

Create a CSV from a YouTube channel:

```powershell
tsx src/index.ts channel-to-csv "https://www.youtube.com/@CHANNEL_NAME" data/videos.csv
```

Download audio:

```powershell
tsx src/index.ts download data/videos.csv
```

Upload local MP3 files to Sofer.ai:

```powershell
tsx src/index.ts transcribe-local data/videos.csv
```

Check transcription statuses and download completed transcripts:

```powershell
tsx src/index.ts check-transcriptions
```

## CSV Format

The CSV should contain:

```csv
id,title,url
001,First Video,https://www.youtube.com/watch?v=...
002,Second Video,https://www.youtube.com/watch?v=...
```

The `channel-to-csv` command generates this automatically from a YouTube channel.

## Runtime Folders

During normal use, the app creates runtime data folders such as:

```text
data/
downloads/
bin/
```

Common generated paths include:

```text
data/videos.csv
data/sofer/submissions/
data/sofer/errors/
downloads/audio/
```

Completed transcript documents are saved to the user’s Downloads folder:

```text
C:\Users\<User>\Downloads\SoferAiTranscripts
```

Each completed transcription gets its own folder.

## Sensitive Files

Do not commit:

```text
.env
data/sofer/
downloads/
bin/
dist/
dist-portable/
release/
production/
```

Important: Sofer transcription IDs should be treated as sensitive because they may allow transcript access by ID.

## Building the Bundled CLI

To bundle the TypeScript CLI into one CommonJS file:

```powershell
npm run build:bundle
```

This creates:

```text
dist/app.cjs
```

You can test the bundled CLI with:

```powershell
node dist/app.cjs --help
```

## Building the Portable Windows App

To generate the portable Windows app:

```powershell
npm run build:exe
```

This does the following:

1. Bundles the TypeScript CLI with esbuild
2. Prepares local helper binaries in `bin/`
3. Builds a Node SEA preparation blob
4. Copies the Node executable
5. Injects the app blob using postject
6. Copies helper binaries into the portable output folder

Output:

```text
dist-portable/
├── YouTubeToSoferAI.exe
├── bin/
│   ├── yt-dlp.exe
│   ├── ffmpeg.exe
│   └── ffprobe.exe
└── data/
```

The end user should receive the entire `dist-portable` folder, not just the `.exe`.

## Testing the Portable App

After building:

```powershell
cd dist-portable
.\YouTubeToSoferAI.exe --help
.\YouTubeToSoferAI.exe init YOUR_SOFER_API_KEY
.\YouTubeToSoferAI.exe channel-to-csv "https://www.youtube.com/@CHANNEL_NAME" data/videos.csv
.\YouTubeToSoferAI.exe download data/videos.csv
```

To verify the portable app is really self-contained, copy `dist-portable` somewhere else, such as the Desktop, and run the executable from there.

The app should work without referencing the original project folder.

## Creating a Production Release Zip

To build the app and create a production zip:

```powershell
npm run package:release
```

This creates a zip in:

```text
production/
```

Example:

```text
production/YouTubeToSoferAI-v1.0.0-windows-x64.zip
```

The zip contains:

```text
YouTubeToSoferAI/
├── YouTubeToSoferAI.exe
├── README.txt
├── bin/
│   ├── yt-dlp.exe
│   ├── ffmpeg.exe
│   └── ffprobe.exe
└── data/
```

The release package intentionally excludes user-specific or sensitive files such as:

```text
.env
downloads/
data/sofer/
data/videos.csv
data/failed-downloads.csv
```

## Recommended Release Process

From a clean project root:

```powershell
npm run package:release
```

Then send the generated zip from:

```text
production/
```

## Useful npm Scripts

```powershell
npm run prepare:binaries
```

Copies helper binaries from `node_modules` into the local generated `bin/` folder.

```powershell
npm run build:bundle
```

Bundles the TypeScript CLI into `dist/app.cjs`.

```powershell
npm run build:exe
```

Builds the portable Windows executable and copies required helper binaries into `dist-portable`.

```powershell
npm run package:release
```

Builds the portable app and creates a production zip in the `production/` folder.

## Notes About Windows Security Warnings

The generated executable is not code-signed. Windows or antivirus software may warn the user before running it.

This is common for custom unsigned executables.
