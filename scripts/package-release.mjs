import fs from "fs-extra";
import path from "node:path";
import { execFileSync } from "node:child_process";

const packageJsonPath = path.resolve("package.json");
const packageJson = await fs.readJson(packageJsonPath);

const appName = "YouTubeToSoferAI";
const version = packageJson.version ?? "0.0.0";

const distPortableDir = path.resolve("dist-portable");
const releaseRootDir = path.resolve("release");
const productionDir = path.resolve("production");
const releaseAppDir = path.join(releaseRootDir, appName);
const zipPath = path.join(
    productionDir,
    `${appName}-v${version}-windows-x64.zip`,
);

async function assertPathExists(pathToCheck, displayName) {
    if (!(await fs.pathExists(pathToCheck))) {
        throw new Error(`${displayName} was not found at ${pathToCheck}`);
    }
}

async function removeIfExists(pathToRemove) {
    if (await fs.pathExists(pathToRemove)) {
        await fs.remove(pathToRemove);
    }
}

function quotePowerShellPath(filePath) {
    return `'${filePath.replaceAll("'", "''")}'`;
}

function zipReleaseFolder() {
    const command = [
        "Compress-Archive",
        "-Path",
        quotePowerShellPath(releaseAppDir),
        "-DestinationPath",
        quotePowerShellPath(zipPath),
        "-Force",
    ].join(" ");

    execFileSync(
        "powershell.exe",
        [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            command,
        ],
        {
            stdio: "inherit",
        },
    );
}

async function writeReadme() {
    const readmePath = path.join(releaseAppDir, "README.txt");

    const readmeContents = `${appName}

How to use:

1. Extract the zip file.

2. Open PowerShell in the extracted ${appName} folder.

3. Set your Sofer API key:
   .\\${appName}.exe init YOUR_SOFER_API_KEY

4. Create a CSV from a YouTube channel:
   .\\${appName}.exe channel-to-csv "CHANNEL_URL_HERE" data/videos.csv

5. Download audio:
   .\\${appName}.exe download data/videos.csv

6. Upload the downloaded audio to Sofer:
   .\\${appName}.exe transcribe-local data/videos.csv

7. Check and download completed transcripts:
   .\\${appName}.exe check-transcriptions

Important:
- Keep this whole folder together.
- Do not move ${appName}.exe out of this folder.
- The bin folder is required.
- Your Sofer API key is stored in the .env file created by the init command.
- Sofer transcription IDs may allow transcript access by ID, so treat the data folder as sensitive after uploading.
- Windows may warn you before running this app because it is not code-signed.

Generated package:
${appName} v${version} for Windows x64
`;

    await fs.writeFile(readmePath, readmeContents, "utf-8");
}

console.log("Checking portable build...");

await assertPathExists(
    path.join(distPortableDir, `${appName}.exe`),
    `${appName}.exe`,
);

await assertPathExists(
    path.join(distPortableDir, "bin", "yt-dlp.exe"),
    "yt-dlp.exe",
);

await assertPathExists(
    path.join(distPortableDir, "bin", "ffmpeg.exe"),
    "ffmpeg.exe",
);

await assertPathExists(
    path.join(distPortableDir, "bin", "ffprobe.exe"),
    "ffprobe.exe",
);

console.log("Cleaning previous release output...");

await removeIfExists(releaseRootDir);
await removeIfExists(zipPath);
await fs.ensureDir(productionDir);

console.log("Copying dist-portable to release folder...");

await fs.ensureDir(releaseRootDir);

await fs.copy(distPortableDir, releaseAppDir, {
    filter: (sourcePath) => {
        const relativePath = path.relative(distPortableDir, sourcePath);

        if (relativePath === "") {
            return true;
        }

        const normalizedRelativePath = relativePath.replaceAll("\\", "/");

        if (normalizedRelativePath === ".env") {
            return false;
        }

        if (normalizedRelativePath === "README.txt") {
            return false;
        }

        if (normalizedRelativePath.startsWith("downloads")) {
            return false;
        }

        if (normalizedRelativePath.startsWith("data/sofer")) {
            return false;
        }

        if (normalizedRelativePath === "data/videos.csv") {
            return false;
        }

        if (normalizedRelativePath === "data/failed-downloads.csv") {
            return false;
        }

        return true;
    },
});

await fs.ensureDir(path.join(releaseAppDir, "data"));

console.log("Writing README.txt...");

await writeReadme();

console.log("Creating zip file...");

zipReleaseFolder();

console.log(`Release package created: ${zipPath}`);