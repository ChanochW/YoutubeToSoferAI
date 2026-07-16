import path from "node:path";
import {getAppDirectory} from "./appPaths";
import fs from "fs-extra";
import {ensureLocalBinaries} from "./ensureLocalBinaries";

export async function ensureBinariesAvailable(): Promise<string> {
    const binDirectory = path.join(getAppDirectory(), "bin");

    const ytDlpPath = path.join(binDirectory, "yt-dlp.exe");
    const ffmpegPath = path.join(binDirectory, "ffmpeg.exe");
    const ffprobePath = path.join(binDirectory, "ffprobe.exe");

    const allExist =
        await fs.pathExists(ytDlpPath) &&
        await fs.pathExists(ffmpegPath) &&
        await fs.pathExists(ffprobePath);

    if (allExist) {
        return binDirectory;
    }

    if (isPackagedExecutable()) {
        throw new Error(
            `Missing helper binaries in ${binDirectory}. The portable app folder is incomplete.`,
        );
    }

    return ensureLocalBinaries();
}

function isPackagedExecutable(): boolean {
    const executableName = path.basename(process.execPath).toLowerCase();

    return executableName !== "node.exe" &&
        executableName !== "node" &&
        executableName !== "tsx.exe" &&
        executableName !== "tsx";
}

