import fs from "fs-extra";
import path from "node:path";
import { execFileSync } from "node:child_process";

console.log("Preparing local helper binaries...");

execFileSync(
    process.execPath,
    [
        "scripts/prepare-binaries.mjs",
    ],
    {
        stdio: "inherit",
    },
);

const outputDir = path.resolve("dist-portable");
const outputExe = path.join(outputDir, "YouTubeToSoferAI.exe");

await fs.ensureDir(outputDir);

const outputBinDir = path.join(outputDir, "bin");

await fs.ensureDir(outputBinDir);

console.log("Building SEA preparation blob...");
execFileSync(
    process.execPath,
    [
        "--experimental-sea-config",
        "sea-config.json",
    ],
    {
        stdio: "inherit",
    },
);

console.log("Copying Node executable...");
await fs.copyFile(
    process.execPath,
    outputExe,
);

console.log("Injecting SEA blob...");
execFileSync(
    "npx",
    [
        "postject",
        outputExe,
        "NODE_SEA_BLOB",
        "dist/sea-prep.blob",
        "--sentinel-fuse",
        "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ],
    {
        stdio: "inherit",
        shell: true,
    },
);

console.log(`Built ${outputExe}`);

console.log("Copying helper binaries from local bin folder...");

await fs.ensureDir(outputBinDir);

await fs.copyFile(
    path.resolve("bin", "yt-dlp.exe"),
    path.join(outputBinDir, "yt-dlp.exe"),
);

await fs.copyFile(
    path.resolve("bin", "ffmpeg.exe"),
    path.join(outputBinDir, "ffmpeg.exe"),
);

await fs.copyFile(
    path.resolve("bin", "ffprobe.exe"),
    path.join(outputBinDir, "ffprobe.exe"),
);

console.log("Copied helper binaries to dist-portable/bin.");