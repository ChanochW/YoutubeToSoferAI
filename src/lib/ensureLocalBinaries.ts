import fs from "fs-extra";
import path from "node:path";
import { createRequire } from "node:module";
import ffmpegStaticPath from "ffmpeg-static";
import ffprobeStaticInstaller from "ffprobe-static-installer";

const require = createRequire(path.resolve("package.json"));

const LOCAL_BIN_DIRECTORY = path.resolve("bin");

function resolveFfmpegPath(): string {
    const possiblePath = ffmpegStaticPath;

    if (typeof possiblePath !== "string") {
        throw new Error("Could not resolve ffmpeg-static path.");
    }

    if (possiblePath.length === 0) {
        throw new Error("Could not resolve ffmpeg-static path.");
    }

    return possiblePath;
}

function resolveFfprobePath(): string {
    const possiblePath = ffprobeStaticInstaller;

    if (typeof possiblePath === "string") {
        if (possiblePath.length === 0) {
            throw new Error("Could not resolve ffprobe-static-installer path.");
        }

        return possiblePath;
    }

    const possibleModule = ffprobeStaticInstaller as unknown as {
        path?: string | null;
    };

    const modulePath = possibleModule.path;

    if (typeof modulePath !== "string") {
        throw new Error("Could not resolve ffprobe-static-installer path.");
    }

    if (modulePath.length === 0) {
        throw new Error("Could not resolve ffprobe-static-installer path.");
    }

    return modulePath;
}

function resolveYtDlpPath(): string {
    const packageJsonPath = require.resolve("youtube-dl-exec/package.json");
    const packageDirectory = path.dirname(packageJsonPath);

    return path.join(
        packageDirectory,
        "bin",
        "yt-dlp.exe",
    );
}

async function assertFileExists(
    filePath: string,
    displayName: string,
): Promise<void> {
    if (!(await fs.pathExists(filePath))) {
        throw new Error(`${displayName} was not found at ${filePath}`);
    }
}

export async function ensureLocalBinaries(): Promise<string> {
    const sourceFfmpegPath = resolveFfmpegPath();
    const sourceFfprobePath = resolveFfprobePath();
    const sourceYtDlpPath = resolveYtDlpPath();

    await assertFileExists(sourceFfmpegPath, "ffmpeg.exe");
    await assertFileExists(sourceFfprobePath, "ffprobe.exe");
    await assertFileExists(sourceYtDlpPath, "yt-dlp.exe");

    await fs.ensureDir(LOCAL_BIN_DIRECTORY);

    await fs.copyFile(
        sourceYtDlpPath,
        path.join(LOCAL_BIN_DIRECTORY, "yt-dlp.exe"),
    );

    await fs.copyFile(
        sourceFfmpegPath,
        path.join(LOCAL_BIN_DIRECTORY, "ffmpeg.exe"),
    );

    await fs.copyFile(
        sourceFfprobePath,
        path.join(LOCAL_BIN_DIRECTORY, "ffprobe.exe"),
    );

    return LOCAL_BIN_DIRECTORY;
}