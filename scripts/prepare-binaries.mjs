import fs from "fs-extra";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(path.resolve("package.json"));

const outputBinDirectory = path.resolve("bin");

/**
 * @returns {string}
 */
function resolveFfmpegPath() {
    /** @type {any} */
    const ffmpegPath = require("ffmpeg-static");

    if (typeof ffmpegPath !== "string" || ffmpegPath.length === 0) {
        throw new Error("Could not resolve ffmpeg-static path.");
    }

    return ffmpegPath;
}

/**
 * @returns {string}
 */
function resolveFfprobePath() {
    /** @type {any} */
    const ffprobeModule = require("ffprobe-static-installer");

    if (
        typeof ffprobeModule === "string" &&
        ffprobeModule.length > 0
    ) {
        return ffprobeModule;
    }

    if (
        typeof ffprobeModule?.path === "string" &&
        ffprobeModule.path.length > 0
    ) {
        return ffprobeModule.path;
    }

    if (
        typeof ffprobeModule?.default === "string" &&
        ffprobeModule.default.length > 0
    ) {
        return ffprobeModule.default;
    }

    throw new Error("Could not resolve ffprobe-static-installer path.");
}

/**
 * @returns {string}
 */
function resolveYtDlpPath() {
    const packageJsonPath = require.resolve("youtube-dl-exec/package.json");
    const packageDirectory = path.dirname(packageJsonPath);

    return path.join(
        packageDirectory,
        "bin",
        "yt-dlp.exe",
    );
}

/**
 * @param {string} filePath
 * @param {string} displayName
 */
async function assertFileExists(filePath, displayName) {
    if (!(await fs.pathExists(filePath))) {
        throw new Error(`${displayName} was not found at ${filePath}`);
    }
}

const sourceFfmpegPath = resolveFfmpegPath();
const sourceFfprobePath = resolveFfprobePath();
const sourceYtDlpPath = resolveYtDlpPath();

await assertFileExists(sourceFfmpegPath, "ffmpeg.exe");
await assertFileExists(sourceFfprobePath, "ffprobe.exe");
await assertFileExists(sourceYtDlpPath, "yt-dlp.exe");

await fs.ensureDir(outputBinDirectory);

await fs.copyFile(
    sourceYtDlpPath,
    path.join(outputBinDirectory, "yt-dlp.exe"),
);

await fs.copyFile(
    sourceFfmpegPath,
    path.join(outputBinDirectory, "ffmpeg.exe"),
);

await fs.copyFile(
    sourceFfprobePath,
    path.join(outputBinDirectory, "ffprobe.exe"),
);

console.log(`Prepared helper binaries in ${outputBinDirectory}`);