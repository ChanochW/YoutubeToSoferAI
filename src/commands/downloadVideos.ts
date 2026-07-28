import fs from "fs-extra";
import path from "node:path";
import { parse } from "csv-parse/sync";
import youtubedl from "youtube-dl-exec";
import { getBundledBinaryPath } from "../lib/appPaths";
import cliProgress from "cli-progress";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ensureBinariesAvailable } from "../lib/ensureBinariesAvailable";

type VideoRow = {
    id: string;
    title: string;
    url: string;
};

type FailedDownload = {
    video: VideoRow;
    error: string;
};

type DownloadVideosOptions = {
    force?: boolean;
};

const DELAY_BETWEEN_DOWNLOAD_ATTEMPTS_MS = 20_000;
const PAUSE_AFTER_ATTEMPTS_COUNT = 20;
const PAUSE_AFTER_ATTEMPTS_MS = 5 * 60_000;

const ESTIMATED_DOWNLOAD_TIME_PER_VIDEO_MS = 30_000;

async function sleep(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}

function formatDuration(milliseconds: number): string {
    const totalSeconds = Math.ceil(milliseconds / 1000);

    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    const parts: string[] = [];

    if (hours > 0) {
        parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
    }

    if (minutes > 0) {
        parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
    }

    if (seconds > 0 && hours === 0) {
        parts.push(`${seconds} second${seconds === 1 ? "" : "s"}`);
    }

    if (parts.length === 0) {
        return "0 seconds";
    }

    return parts.join(" ");
}

function calculateEstimatedTotalTime(
    totalVideos: number,
): {
    totalMilliseconds: number;
    estimatedDownloadMilliseconds: number;
    delayMilliseconds: number;
    normalDelayCount: number;
    longPauseCount: number;
} {
    const delaysAfterAttempts = Math.max(totalVideos - 1, 0);
    const longPauseCount = Math.floor(delaysAfterAttempts / PAUSE_AFTER_ATTEMPTS_COUNT);
    const normalDelayCount = delaysAfterAttempts - longPauseCount;

    const estimatedDownloadMilliseconds =
        totalVideos * ESTIMATED_DOWNLOAD_TIME_PER_VIDEO_MS;

    const delayMilliseconds =
        normalDelayCount * DELAY_BETWEEN_DOWNLOAD_ATTEMPTS_MS +
        longPauseCount * PAUSE_AFTER_ATTEMPTS_MS;

    return {
        totalMilliseconds: estimatedDownloadMilliseconds + delayMilliseconds,
        estimatedDownloadMilliseconds,
        delayMilliseconds,
        normalDelayCount,
        longPauseCount,
    };
}

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

    try {
        while (true) {
            const answer = await readline.question(`${question} (y/n): `);
            const normalizedAnswer = answer.trim().toLowerCase();

            if (normalizedAnswer === "y" || normalizedAnswer === "yes") {
                return true;
            }

            if (normalizedAnswer === "n" || normalizedAnswer === "no") {
                return false;
            }

            console.log("Please enter y or n.");
        }
    } finally {
        readline.close();
    }
}

async function confirmSlowDownloadMode(totalVideos: number): Promise<boolean> {
    const estimate = calculateEstimatedTotalTime(totalVideos);

    console.log("");
    console.log("YouTube may slow down, interrupt, or block automated download requests if too many videos are requested too quickly.");
    console.log(
        `To reduce bot-detection problems, this downloader waits ${formatDuration(DELAY_BETWEEN_DOWNLOAD_ATTEMPTS_MS)} between each video attempt and pauses for ${formatDuration(PAUSE_AFTER_ATTEMPTS_MS)} after every ${PAUSE_AFTER_ATTEMPTS_COUNT} attempts.`,
    );
    console.log(
        `This makes large batches slower, but it gives the downloads a better chance of completing successfully. This run will attempt ${totalVideos} video${totalVideos === 1 ? "" : "s"} before retry prompts.`,
    );
    console.log("");
    console.log("Estimated time for this pass:");
    console.log(
        `- Estimated actual download time: ${formatDuration(estimate.estimatedDownloadMilliseconds)} based on about ${formatDuration(ESTIMATED_DOWNLOAD_TIME_PER_VIDEO_MS)} per video.`,
    );
    console.log(
        `- Added pacing delay: ${formatDuration(estimate.delayMilliseconds)} from ${estimate.normalDelayCount} short delay${estimate.normalDelayCount === 1 ? "" : "s"} and ${estimate.longPauseCount} long pause${estimate.longPauseCount === 1 ? "" : "s"}.`,
    );
    console.log(
        `- Estimated total time: ${formatDuration(estimate.totalMilliseconds)}.`,
    );
    console.log("");
    console.log("This is only an estimate. The real time may be longer or shorter depending on video length, internet speed, and YouTube response time.");
    console.log("");

    return askYesNo("Continue with slowed-down downloading?");
}

function formatCsvField(value: string): string {
    return `"${value.replaceAll('"', '""')}"`;
}

async function saveFailedVideos(
    failedDownloads: FailedDownload[],
    failureCsvPath: string,
): Promise<void> {
    if (failedDownloads.length === 0) {
        await fs.remove(failureCsvPath);
        return;
    }

    const csvLines = [
        "id,title,url",
        ...failedDownloads.map((failedDownload) =>
            [
                failedDownload.video.id,
                formatCsvField(failedDownload.video.title),
                formatCsvField(failedDownload.video.url),
            ].join(","),
        ),
    ];

    await fs.writeFile(
        failureCsvPath,
        `${csvLines.join("\n")}\n`,
        "utf-8",
    );
}

async function saveFailedDownloadErrors(
    failedDownloads: FailedDownload[],
    failureErrorPath: string,
): Promise<void> {
    if (failedDownloads.length === 0) {
        await fs.remove(failureErrorPath);
        return;
    }

    const failedClipList = [
        "Failed clips:",
        "",
        ...failedDownloads.map((failedDownload) =>
            `${failedDownload.video.id}: ${failedDownload.video.title}`,
        ),
        "",
        "========================================",
        "",
        "Download errors:",
        "",
    ].join("\n");

    const errorDetails = failedDownloads
        .map((failedDownload, index) => {
            return [
                `#${index + 1}`,
                `ID: ${failedDownload.video.id}`,
                `Title: ${failedDownload.video.title}`,
                `URL: ${failedDownload.video.url}`,
                "",
                "Error:",
                failedDownload.error,
                "",
                "----------------------------------------",
                "",
            ].join("\n");
        })
        .join("\n");

    await fs.writeFile(
        failureErrorPath,
        `${failedClipList}${errorDetails}`,
        "utf-8",
    );
}

function formatDownloadError(error: unknown): string {
    if (error instanceof Error) {
        const possibleExecError = error as Error & {
            stderr?: string;
            stdout?: string;
            code?: string | number;
            errno?: number;
            path?: string;
        };

        const details: string[] = [];

        if (possibleExecError.stderr?.trim()) {
            details.push(possibleExecError.stderr?.trim());
        }

        if (possibleExecError.stdout?.trim()) {
            details.push(possibleExecError.stdout?.trim());
        }

        if (possibleExecError.message.trim()) {
            details.push(possibleExecError.message.trim());
        }

        if (possibleExecError.code !== undefined) {
            details.push(`Code: ${possibleExecError.code}`);
        }

        if (possibleExecError.errno !== undefined) {
            details.push(`Errno: ${possibleExecError.errno}`);
        }

        if (possibleExecError.path !== undefined) {
            details.push(`Path: ${possibleExecError.path}`);
        }

        return details.join("\n");
    }

    return String(error);
}

function printFailureSummary(
    failedDownloads: FailedDownload[],
    failureCsvPath: string,
    failureErrorPath: string,
): void {
    if (failedDownloads.length === 0) {
        return;
    }

    console.error("");
    console.error(`${failedDownloads.length} download(s) failed.`);
    console.error(`Failed video retry CSV saved to ${failureCsvPath}.`);
    console.error(`Full failure details saved to ${failureErrorPath}.`);
}

async function waitBeforeNextAttempt(
    attemptedInThisPass: number,
    totalInThisPass: number,
    updateStatus: (status: string) => void,
): Promise<void> {
    if (attemptedInThisPass >= totalInThisPass) {
        return;
    }

    if (attemptedInThisPass % PAUSE_AFTER_ATTEMPTS_COUNT === 0) {
        updateStatus(
            `Pausing ${formatDuration(PAUSE_AFTER_ATTEMPTS_MS)} after ${attemptedInThisPass} attempts...`,
        );

        await sleep(PAUSE_AFTER_ATTEMPTS_MS);

        updateStatus("Continuing downloads...");
        return;
    }

    updateStatus(
        `Waiting ${formatDuration(DELAY_BETWEEN_DOWNLOAD_ATTEMPTS_MS)} before next attempt...`,
    );

    await sleep(DELAY_BETWEEN_DOWNLOAD_ATTEMPTS_MS);

    updateStatus("Continuing downloads...");
}

export async function downloadVideos(
    csvPath: string,
    options: DownloadVideosOptions = {},
) {
    const csv = await fs.readFile(csvPath, "utf-8");

    const records = parse(csv, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
    }) as VideoRow[];

    if (records.length === 0) {
        console.log("No videos found in the CSV.");
        return;
    }

    const shouldContinue = await confirmSlowDownloadMode(records.length);

    if (!shouldContinue) {
        console.log("Download cancelled.");
        return;
    }

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
    const failureErrorPath = "data/failed-download-errors.txt";

    await fs.ensureDir("data");

    async function downloadPass(
        videos: VideoRow[],
        passName: string,
    ): Promise<FailedDownload[]> {
        let processedCount = 0;
        let successfulCount = 0;
        let failedCount = 0;

        const failedDownloads: FailedDownload[] = [];

        console.log("");
        console.log(
            `${passName}: ${videos.length} video${videos.length === 1 ? "" : "s"} will be attempted.`,
        );
        console.log(
            `Pacing: ${formatDuration(DELAY_BETWEEN_DOWNLOAD_ATTEMPTS_MS)} between attempts, plus ${formatDuration(PAUSE_AFTER_ATTEMPTS_MS)} after every ${PAUSE_AFTER_ATTEMPTS_COUNT} attempts.`,
        );
        console.log("");

        const progressBar = new cliProgress.SingleBar(
            {
                format: `${passName} |{bar}| {value}/{total} {spinner} {status}`,
                clearOnComplete: true,
                hideCursor: true,
            },
            cliProgress.Presets.shades_classic,
        );

        let progressStatus = "Starting...";

        progressBar.start(videos.length, 0, {
            spinner: spinnerFrames[spinnerIndex],
            status: progressStatus,
        });

        const updateProgressBar = (status: string): void => {
            progressStatus = status;

            progressBar.update(processedCount, {
                spinner: spinnerFrames[spinnerIndex],
                status: progressStatus,
            });
        };

        const spinnerInterval = setInterval(() => {
            spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;

            progressBar.update(processedCount, {
                spinner: spinnerFrames[spinnerIndex],
                status: progressStatus,
            });
        }, 100);

        try {
            for (const video of videos) {
                const outputPath = `downloads/audio/${video.id}.%(ext)s`;

                updateProgressBar(`Downloading ${video.id}...`);

                try {
                    await ytDlp(video.url, {
                        extractAudio: true,
                        audioFormat: "mp3",
                        audioQuality: 0,
                        output: outputPath,
                        noPlaylist: true,
                        ffmpegLocation,
                        jsRuntimes: "node",
                        noOverwrites: true,
                    });

                    successfulCount += 1;
                    processedCount += 1;

                    updateProgressBar(`Finished ${video.id}.`);
                } catch (error) {
                    failedDownloads.push({
                        video,
                        error: formatDownloadError(error),
                    });

                    failedCount += 1;
                    processedCount += 1;

                    updateProgressBar(`Failed ${video.id}.`);
                }

                await waitBeforeNextAttempt(
                    processedCount,
                    videos.length,
                    updateProgressBar,
                );
            }
        } finally {
            clearInterval(spinnerInterval);
            progressBar.stop();
        }

        await saveFailedVideos(
            failedDownloads,
            failureCsvPath,
        );

        await saveFailedDownloadErrors(
            failedDownloads,
            failureErrorPath,
        );

        printFailureSummary(
            failedDownloads,
            failureCsvPath,
            failureErrorPath,
        );

        console.log(
            `${passName} complete: ${successfulCount} succeeded, ${failedCount} failed.`,
        );

        return failedDownloads;
    }

    let remainingFailures = await downloadPass(
        records,
        "Downloading videos",
    );

    let retryNumber = 1;

    while (remainingFailures.length > 0) {
        if (!options.force) {
            const shouldRetry = await askYesNo(
                `Retry ${remainingFailures.length} failed download(s)?`,
            );

            if (!shouldRetry) {
                console.log(
                    `Finished. ${remainingFailures.length} failed download(s) were saved to ${failureCsvPath}.`,
                );

                console.log(
                    `Failure details were saved to ${failureErrorPath}.`,
                );

                return;
            }
        } else {
            console.log(
                `Force retry enabled. Retrying ${remainingFailures.length} failed download(s) after the same slow pacing rules...`,
            );
        }

        remainingFailures = await downloadPass(
            remainingFailures.map((failedDownload) => failedDownload.video),
            `Retrying failed downloads (attempt ${retryNumber})`,
        );

        retryNumber += 1;
    }

    console.log("All downloads completed successfully.");
}