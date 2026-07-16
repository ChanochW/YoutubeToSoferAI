import fs from "fs-extra";
import path from "node:path";
import {parse} from "csv-parse/sync";
import youtubedl from "youtube-dl-exec";
import { getBundledBinaryPath } from "../lib/appPaths";
import cliProgress from "cli-progress";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {ensureBinariesAvailable} from "../lib/ensureBinariesAvailable";

type VideoRow = {
    id: string;
    title: string;
    url: string;
};

async function getFfmpegToolsDirectory(): Promise<string> {
    const toolsDir = path.dirname(
        getBundledBinaryPath("ffmpeg.exe"),
    );

    const ffmpegBinaryPath = path.join(
        toolsDir,
        "ffmpeg.exe",
    );

    const ffprobeBinaryPath = path.join(
        toolsDir,
        "ffprobe.exe",
    );

    if (!(await fs.pathExists(ffmpegBinaryPath))) {
        throw new Error(
            `Missing ffmpeg.exe at ${ffmpegBinaryPath}`,
        );
    }

    if (!(await fs.pathExists(ffprobeBinaryPath))) {
        throw new Error(
            `Missing ffprobe.exe at ${ffprobeBinaryPath}`,
        );
    }

    return toolsDir;
}

async function askYesNo(question: string): Promise<boolean> {
    const readline = createInterface({
        input,
        output,
    });

    while (true) {
        const answer = await readline.question(`${question} (y/n): `);
        const normalizedAnswer = answer.trim().toLowerCase();

        if (normalizedAnswer === "y" || normalizedAnswer === "yes") {
            readline.close();
            return true;
        }

        if (normalizedAnswer === "n" || normalizedAnswer === "no") {
            readline.close();
            return false;
        }

        console.log("Please enter y or n.");
    }
}

async function saveFailedVideos(
    failedVideos: VideoRow[],
    failureCsvPath: string,
): Promise<void> {
    if (failedVideos.length === 0) {
        await fs.remove(failureCsvPath);
        return;
    }

    const csvLines = [
        "id,title,url",
        ...failedVideos.map((video) =>
            [
                video.id,
                `"${video.title.replaceAll('"', '""')}"`,
                `"${video.url.replaceAll('"', '""')}"`,
            ].join(","),
        ),
    ];

    await fs.writeFile(
        failureCsvPath,
        `${csvLines.join("\n")}\n`,
        "utf-8",
    );
}

export async function downloadVideos(csvPath: string) {
    const csv = await fs.readFile(csvPath, "utf-8");

    const records = parse(csv, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
    }) as VideoRow[];

    await fs.ensureDir("downloads/audio");

    await ensureBinariesAvailable();

    const ffmpegLocation = await getFfmpegToolsDirectory();

    const ytDlpPath = getBundledBinaryPath("yt-dlp.exe");

    if (!(await fs.pathExists(ytDlpPath))) {
        throw new Error(
            `Missing yt-dlp.exe at ${ytDlpPath}`,
        );
    }

    const ytDlp = youtubedl.create(ytDlpPath);

    const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    let spinnerIndex = 0;

    const failureCsvPath = "data/failed-downloads.csv";

    await fs.ensureDir("data");

    async function downloadPass(
        videos: VideoRow[],
        passName: string,
    ): Promise<VideoRow[]> {
        let processedCount = 0;
        let successfulCount = 0;
        let failedCount = 0;

        const failedVideos: VideoRow[] = [];

        const progressBar = new cliProgress.SingleBar(
            {
                format: `${passName} |{bar}| {value}/{total} {spinner}`,
                clearOnComplete: true,
                hideCursor: true,
            },
            cliProgress.Presets.shades_classic,
        );

        progressBar.start(videos.length, 0, {
            spinner: spinnerFrames[spinnerIndex],
        });

        const spinnerInterval = setInterval(() => {
            spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;

            progressBar.update(processedCount, {
                spinner: spinnerFrames[spinnerIndex],
            });
        }, 100);

        try {
            for (const video of videos) {
                const outputPath = `downloads/audio/${video.id}.%(ext)s`;

                try {
                    await ytDlp(video.url, {
                        extractAudio: true,
                        audioFormat: "mp3",
                        audioQuality: 0,
                        output: outputPath,
                        noPlaylist: true,
                        ffmpegLocation,
                        noJsRuntimes: true,
                        jsRuntimes: "node",
                        noOverwrites: true,
                    });

                    successfulCount += 1;
                    processedCount += 1;

                    progressBar.update(processedCount, {
                        spinner: spinnerFrames[spinnerIndex],
                    });
                } catch (error) {
                    failedVideos.push(video);

                    failedCount += 1;
                    processedCount += 1;

                    progressBar.update(processedCount, {
                        spinner: spinnerFrames[spinnerIndex],
                    });
                }
            }
        } finally {
            clearInterval(spinnerInterval);
            progressBar.stop();
        }

        if (failedVideos.length > 0) {
            console.error(
                `Failed clips: ${failedVideos
                    .map((video) => `${video.id}: ${video.title}`)
                    .join(", ")}`,
            );
        }

        console.log(
            `${passName} complete: ${successfulCount} succeeded, ${failedCount} failed.`,
        );

        return failedVideos;
    }

    let remainingFailures = await downloadPass(
        records,
        "Downloading videos",
    );

    await saveFailedVideos(remainingFailures, failureCsvPath);

    let retryNumber = 1;

    while (remainingFailures.length > 0) {
        const shouldRetry = await askYesNo(
            `Retry ${remainingFailures.length} failed download(s)?`,
        );

        if (!shouldRetry) {
            console.log(
                `Finished. ${remainingFailures.length} failed download(s) were saved to ${failureCsvPath}.`,
            );

            return;
        }

        remainingFailures = await downloadPass(
            remainingFailures,
            `Retrying failed downloads (attempt ${retryNumber})`,
        );

        await saveFailedVideos(remainingFailures, failureCsvPath);

        retryNumber += 1;
    }

    console.log("All downloads completed successfully.");
}