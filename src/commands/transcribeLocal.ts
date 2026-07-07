import axios from "axios";
import { parse } from "csv-parse/sync";
import fs from "fs-extra";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

type VideoRow = {
    id: string;
    title: string;
    url: string;
};

type TranscribeLocalOptions = {
    retryUnknown?: boolean;
};

type SubmissionSuccess = {
    status: "submitted";
    transcriptionId: string;
    submittedAt: string;
    source: {
        id: string;
        title: string;
        url: string;
        audioPath: string;
        audioSizeBytes: number;
    };
};

type SubmissionFailure = {
    status: "rejected" | "submission_unknown" | "missing_audio";
    recordedAt: string;
    source: {
        id: string;
        title: string;
        url: string;
        audioPath: string;
    };
    error: string;
    httpStatus?: number;
};

type PendingSubmission = {
    status: "pending_submission";
    requestStartedAt: string;
    source: {
        id: string;
        title: string;
        url: string;
        audioPath: string;
        audioSizeBytes: number;
    };
};

const MIN_REQUEST_SPACING_MS = 13_000;
const ESTIMATED_API_REQUEST_OVERHEAD_MS = 4_000;

type DurationResponse = {
    duration_seconds: number;
};

type PreparedSubmission = {
    video: VideoRow;
    audioPath: string;
    audioSizeBytes: number;
    durationSeconds: number;
};

const PRICE_PER_AUDIO_HOUR_USD = 1.20;

function formatDuration(totalSeconds: number): string {
    const roundedSeconds = Math.round(totalSeconds);

    const hours = Math.floor(roundedSeconds / 3600);
    const minutes = Math.floor((roundedSeconds % 3600) / 60);
    const seconds = roundedSeconds % 60;

    const parts: string[] = [];

    if (hours > 0) {
        parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
    }

    if (minutes > 0) {
        parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
    }

    if (seconds > 0 || parts.length === 0) {
        parts.push(`${seconds} second${seconds === 1 ? "" : "s"}`);
    }

    return parts.join(", ");
}

function formatUsd(amount: number): string {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
    }).format(amount);
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

            if (
                normalizedAnswer === "y" ||
                normalizedAnswer === "yes"
            ) {
                return true;
            }

            if (
                normalizedAnswer === "n" ||
                normalizedAnswer === "no"
            ) {
                return false;
            }

            console.log("Please enter y or n.");
        }
    } finally {
        readline.close();
    }
}

async function getAudioDuration(
    base64Audio: string,
    apiKey: string,
): Promise<number> {
    const response = await axios.post<unknown>(
        "https://api.sofer.ai/v1/utils/duration",
        {
            audio_file: base64Audio,
        },
        {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
            },
            timeout: 300_000,
        },
    );

    const data = response.data as Partial<DurationResponse>;

    if (typeof data.duration_seconds !== "number") {
        throw new Error(
            `Sofer returned an unexpected duration response: ${JSON.stringify(response.data)}`,
        );
    }

    return data.duration_seconds;
}

function sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}

function getErrorMessage(error: unknown): string {
    if (axios.isAxiosError(error)) {
        const responseData = error.response?.data;

        if (typeof responseData === "string" && responseData.trim()) {
            return responseData;
        }

        if (responseData !== undefined && responseData !== null) {
            return JSON.stringify(responseData, null, 2);
        }

        return error.message;
    }

    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

function getHttpStatus(error: unknown): number | undefined {
    if (axios.isAxiosError(error)) {
        return error.response?.status;
    }

    return undefined;
}

function getFailureStatus(
    error: unknown,
): "rejected" | "submission_unknown" {
    const httpStatus = getHttpStatus(error);

    /*
     * A 4xx response means Sofer definitely rejected the request.
     * A timeout, connection failure, or 5xx could theoretically have
     * reached Sofer before the response failed, so do not auto-retry it.
     */
    if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500) {
        return "rejected";
    }

    return "submission_unknown";
}

function getExistingTranscriptionId(
    value: unknown,
): string | undefined {
    if (!value || typeof value !== "object") {
        return undefined;
    }

    const record = value as Record<string, unknown>;

    const possibleId =
        record.transcriptionId ??
        record.transcription_id ??
        record.sofer_transcription_id;

    return typeof possibleId === "string" ? possibleId : undefined;
}

async function hasSuccessfulSubmission(
    submissionPath: string,
    legacySubmissionPath: string,
): Promise<boolean> {
    const pathsToCheck = [submissionPath, legacySubmissionPath];

    for (const filePath of pathsToCheck) {
        if (!(await fs.pathExists(filePath))) {
            continue;
        }

        try {
            const savedData = await fs.readJson(filePath);

            if (getExistingTranscriptionId(savedData)) {
                return true;
            }
        } catch {
            /*
             * A damaged local JSON file should not be treated as success.
             * The command will submit normally and overwrite the new-format path.
             */
        }
    }

    return false;
}

async function getSavedFailure(
    failurePath: string,
): Promise<SubmissionFailure | undefined> {
    if (!(await fs.pathExists(failurePath))) {
        return undefined;
    }

    try {
        return await fs.readJson(failurePath) as SubmissionFailure;
    } catch {
        return undefined;
    }
}

async function waitForRateLimit(
    lastRequestStartedAt: number,
): Promise<void> {
    if (lastRequestStartedAt === 0) {
        return;
    }

    const elapsedMilliseconds = Date.now() - lastRequestStartedAt;

    const waitMilliseconds = Math.max(
        0,
        MIN_REQUEST_SPACING_MS - elapsedMilliseconds,
    );

    if (waitMilliseconds > 0) {
        console.log(
            `Waiting ${Math.ceil(waitMilliseconds / 1000)} seconds before the next Sofer request...`,
        );

        await sleep(waitMilliseconds);
    }
}

function validateRows(records: VideoRow[]): void {
    if (records.length === 0) {
        throw new Error("The CSV contains no rows.");
    }

    const ids = new Set<string>();

    for (const video of records) {
        if (!video.id || !video.title || !video.url) {
            throw new Error(
                "Every CSV row must include id, title, and url.",
            );
        }

        if (ids.has(video.id)) {
            throw new Error(
                `Duplicate id found in CSV: ${video.id}`,
            );
        }

        ids.add(video.id);
    }
}

export async function transcribeLocal(
    csvPath: string,
    options: TranscribeLocalOptions = {},
): Promise<void> {
    const apiKey = process.env.SOFER_API_KEY;

    if (!apiKey) {
        throw new Error(
            "SOFER_API_KEY is missing. Add it to your .env file.",
        );
    }

    const csvContents = await fs.readFile(csvPath, "utf-8");

    const records = parse(csvContents, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
    }) as VideoRow[];

    validateRows(records);

    const submissionDirectory = path.resolve(
        "data",
        "sofer",
        "submissions",
    );

    let lastSoferRequestStartedAt = 0;

    let alreadySubmittedCount = 0;
    let skippedUnknownCount = 0;
    let missingAudioCount = 0;

    const preparedSubmissions: PreparedSubmission[] = [];

    const durationCheckEstimatedSeconds =
        (
            Math.max(0, records.length - 1) *
            MIN_REQUEST_SPACING_MS
            +
            records.length *
            ESTIMATED_API_REQUEST_OVERHEAD_MS
        ) / 1000;

    const submissionEstimatedSeconds =
        (
            Math.max(0, records.length - 1) *
            MIN_REQUEST_SPACING_MS
            +
            records.length *
            ESTIMATED_API_REQUEST_OVERHEAD_MS
        ) / 1000;

    const totalEstimatedSeconds =
        durationCheckEstimatedSeconds +
        submissionEstimatedSeconds;

    console.log(
        `Calculating the projected cost for ${records.length} CSV item(s)...`,
    );

    console.log(
        `Estimated time to calculate the cost: Approximately ${formatDuration(durationCheckEstimatedSeconds)}.`,
    );

    console.log(
        `Estimated time to submit all the audio clips to Sofer.ai: Approximately ${formatDuration(submissionEstimatedSeconds)}.`,
    );

    console.log(`Estimated total processing time: Approximately ${formatDuration(totalEstimatedSeconds)}.`);

    const shouldCalculateDurations = await askYesNo(
        "Continue with duration checks?",
    );

    if (!shouldCalculateDurations) {
        console.log(
            "Cancelled. No duration checks or transcription submissions were made.",
        );

        return;
    }

    for (let index = 0; index < records.length; index += 1) {
        const video = records[index];

        const audioPath = path.resolve(
            "downloads",
            "audio",
            `${video.id}.mp3`,
        );

        const submissionPath = path.join(
            submissionDirectory,
            `${video.id}.json`,
        );

        const legacySubmissionPath = path.resolve(
            "data",
            "sofer",
            `${video.id}.json`,
        );

        const pendingPath = path.join(
            submissionDirectory,
            `${video.id}.pending.json`,
        );

        const failurePath = path.join(
            submissionDirectory,
            `${video.id}.error.json`,
        );

        const progressLabel =
            `[${index + 1}/${records.length}] ${video.id}: ${video.title}`;

        if (
            await hasSuccessfulSubmission(
                submissionPath,
                legacySubmissionPath,
            )
        ) {
            alreadySubmittedCount += 1;

            console.log(
                `${progressLabel} — already submitted; excluded from estimate.`,
            );

            continue;
        }

        if (
            await fs.pathExists(pendingPath) &&
            !options.retryUnknown
        ) {
            skippedUnknownCount += 1;

            console.log(
                `${progressLabel} — prior submission may be uncertain; excluded from estimate.`,
            );

            continue;
        }

        const savedFailure = await getSavedFailure(failurePath);

        if (
            savedFailure?.status === "submission_unknown" &&
            !options.retryUnknown
        ) {
            skippedUnknownCount += 1;

            console.log(
                `${progressLabel} — prior submission outcome is unknown; excluded from estimate.`,
            );

            continue;
        }

        if (!(await fs.pathExists(audioPath))) {
            missingAudioCount += 1;

            console.log(
                `${progressLabel} — MP3 not found; excluded from estimate.`,
            );

            continue;
        }

        const audioStats = await stat(audioPath);

        console.log(
            `${progressLabel} — calculating duration...`,
        );

        const base64Audio = await readFile(audioPath, {
            encoding: "base64",
        });

        await waitForRateLimit(lastSoferRequestStartedAt);

        lastSoferRequestStartedAt = Date.now();

        let durationSeconds: number;

        try {
            durationSeconds = await getAudioDuration(
                base64Audio,
                apiKey,
            );
        } catch (error) {
            throw new Error(
                `Could not calculate duration for ${video.id}: ${video.title}\n` +
                `${getErrorMessage(error)}\n\n` +
                "No files were submitted.",
            );
        }

        if (durationSeconds <= 0) {
            throw new Error(
                `Sofer could not determine the duration for ${video.id}: ${video.title}.\n` +
                "No files were submitted because the projected total would be incomplete.",
            );
        }

        preparedSubmissions.push({
            video,
            audioPath,
            audioSizeBytes: audioStats.size,
            durationSeconds,
        });

        console.log(
            `${progressLabel} — ${formatDuration(durationSeconds)}.`,
        );
    }

    if (preparedSubmissions.length === 0) {
        console.log("");
        console.log("There are no eligible MP3 files to submit.");
        console.log(`Already submitted: ${alreadySubmittedCount}`);
        console.log(`Unknown prior outcomes skipped: ${skippedUnknownCount}`);
        console.log(`Missing MP3 files skipped: ${missingAudioCount}`);

        return;
    }

    const totalDurationSeconds = preparedSubmissions.reduce(
        (total, submission) => total + submission.durationSeconds,
        0,
    );

    /*
     * Sofer bills v1 single transcriptions proportionally by exact
     * audio duration in seconds, with no per-file minimum or rounding
     * to the next minute/hour.
     */
    const projectedCost =
        (totalDurationSeconds / 3600) *
        PRICE_PER_AUDIO_HOUR_USD;

    console.log("");
    console.log("Submission preflight complete.");
    console.log(`Clips to submit: ${preparedSubmissions.length}`);
    console.log(`Total audio duration: ${formatDuration(totalDurationSeconds)}`);
    console.log(
        `Projected transcription cost: ${formatUsd(projectedCost)} ` +
        `(prorated by exact audio duration at ${formatUsd(PRICE_PER_AUDIO_HOUR_USD)} per audio hour ` +
        `[Using AI Model: v1, Mode: One Speaker]).`,
    );

    if (alreadySubmittedCount > 0) {
        console.log(`Already submitted and excluded: ${alreadySubmittedCount}`);
    }

    if (skippedUnknownCount > 0) {
        console.log(
            `Unknown prior outcomes excluded: ${skippedUnknownCount}`,
        );
    }

    if (missingAudioCount > 0) {
        console.log(`Missing MP3 files excluded: ${missingAudioCount}`);
    }

    const shouldProceed = await askYesNo(
        "Proceed with submitting these clips to Sofer?",
    );

    if (!shouldProceed) {
        console.log(
            "Cancelled. No transcription submissions or submission-state files were created.",
        );

        return;
    }

    await fs.ensureDir(submissionDirectory);

    let submittedCount = 0;
    let rejectedCount = 0;
    let unknownFailureCount = 0;

    console.log("");
    console.log(
        `Submitting ${preparedSubmissions.length} approved clip(s) to Sofer...`,
    );

    for (
        let index = 0;
        index < preparedSubmissions.length;
        index += 1
    ) {
        const preparedSubmission = preparedSubmissions[index];

        const {
            video,
            audioPath,
            audioSizeBytes,
        } = preparedSubmission;

        const submissionPath = path.join(
            submissionDirectory,
            `${video.id}.json`,
        );

        const pendingPath = path.join(
            submissionDirectory,
            `${video.id}.pending.json`,
        );

        const failurePath = path.join(
            submissionDirectory,
            `${video.id}.error.json`,
        );

        const progressLabel =
            `[${index + 1}/${preparedSubmissions.length}] ${video.id}: ${video.title}`;

        console.log(`${progressLabel} — uploading...`);

        /*
         * Do not keep every Base64 MP3 in memory from the preflight phase.
         * Read one file again only when it is actually ready to upload.
         */
        const base64Audio = await readFile(audioPath, {
            encoding: "base64",
        });

        try {
            await waitForRateLimit(lastSoferRequestStartedAt);

            const pendingSubmission: PendingSubmission = {
                status: "pending_submission",
                requestStartedAt: new Date().toISOString(),
                source: {
                    id: video.id,
                    title: video.title,
                    url: video.url,
                    audioPath,
                    audioSizeBytes,
                },
            };

            await fs.writeJson(pendingPath, pendingSubmission, {
                spaces: 2,
            });

            lastSoferRequestStartedAt = Date.now();

            const response = await axios.post<unknown>(
                "https://api.sofer.ai/v1/transcriptions/",
                {
                    audio_file: base64Audio,
                    info: {
                        model: "v1",
                        primary_language: "en",
                        hebrew_word_format: ["en", "he"],
                        num_speakers: 1,
                        title: video.title,
                    },
                },
                {
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                        "Content-Type": "application/json",
                    },
                    timeout: 300_000,
                },
            );

            if (typeof response.data !== "string") {
                const failure: SubmissionFailure = {
                    status: "submission_unknown",
                    recordedAt: new Date().toISOString(),
                    source: {
                        id: video.id,
                        title: video.title,
                        url: video.url,
                        audioPath,
                    },
                    error:
                        "Sofer returned an unexpected successful response: " +
                        JSON.stringify(response.data),
                };

                await fs.writeJson(failurePath, failure, {
                    spaces: 2,
                });

                unknownFailureCount += 1;

                console.error(
                    `${video.id} returned an unexpected response. Its pending marker was retained.`,
                );

                continue;
            }

            const transcriptionId = response.data;

            const success: SubmissionSuccess = {
                status: "submitted",
                transcriptionId,
                submittedAt: new Date().toISOString(),
                source: {
                    id: video.id,
                    title: video.title,
                    url: video.url,
                    audioPath,
                    audioSizeBytes,
                },
            };

            await fs.writeJson(submissionPath, success, {
                spaces: 2,
            });

            await fs.remove(failurePath);
            await fs.remove(pendingPath);

            submittedCount += 1;

            console.log(
                `${video.id} submitted — transcription ID: ${transcriptionId}`,
            );
        } catch (error) {
            const httpStatus = getHttpStatus(error);
            const failureStatus = getFailureStatus(error);

            const failure: SubmissionFailure = {
                status: failureStatus,
                recordedAt: new Date().toISOString(),
                source: {
                    id: video.id,
                    title: video.title,
                    url: video.url,
                    audioPath,
                },
                error: getErrorMessage(error),
                httpStatus,
            };

            await fs.writeJson(failurePath, failure, {
                spaces: 2,
            });

            if (failureStatus === "rejected") {
                await fs.remove(pendingPath);

                rejectedCount += 1;

                console.error(
                    `${video.id} was rejected by Sofer${httpStatus ? ` (HTTP ${httpStatus})` : ""}.`,
                );
            } else {
                unknownFailureCount += 1;

                console.error(
                    `${video.id} has an unknown submission outcome${httpStatus ? ` (HTTP ${httpStatus})` : ""}. It will not be retried automatically.`,
                );
            }
        }
    }

    console.log("");
    console.log("Submission run complete.");
    console.log(`Submitted: ${submittedCount}`);
    console.log(`Rejected by Sofer: ${rejectedCount}`);
    console.log(`Unknown outcomes recorded: ${unknownFailureCount}`);

    if (unknownFailureCount > 0 || skippedUnknownCount > 0) {
        console.log("");
        console.log(
            "Unknown outcomes may be represented by .pending.json and/or .error.json files in data/sofer/submissions.",
        );
        console.log(
            "Do not rerun those blindly: the request may have reached Sofer before the network error.",
        );
        console.log(
            "After checking with Sofer, retry them explicitly with --retry-unknown.",
        );
    }
}

//todo proper cost calculation: ask sofer team
//todo proper time estimation
//todo make a rolling time estimation for both the cost check and the actual uploading and have it count down at the bottom of the console