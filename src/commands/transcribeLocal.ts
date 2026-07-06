import axios from "axios";
import { parse } from "csv-parse/sync";
import fs from "fs-extra";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

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

    await fs.ensureDir(submissionDirectory);

    let submittedCount = 0;
    let skippedSubmittedCount = 0;
    let skippedUnknownCount = 0;
    let missingAudioCount = 0;
    let rejectedCount = 0;
    let unknownFailureCount = 0;

    let lastRequestStartedAt = 0;

    console.log(
        `Submitting ${records.length} CSV item(s) to Sofer one at a time...`,
    );

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

        const pendingPath = path.join(
            submissionDirectory,
            `${video.id}.pending.json`,
        );

        /*
         * Supports the older location used by your first working test,
         * so 006 is not accidentally submitted again.
         */
        const legacySubmissionPath = path.resolve(
            "data",
            "sofer",
            `${video.id}.json`,
        );

        const failurePath = path.join(
            submissionDirectory,
            `${video.id}.error.json`,
        );

        const progressLabel = `[${index + 1}/${records.length}] ${video.id}: ${video.title}`;

        if (
            await hasSuccessfulSubmission(
                submissionPath,
                legacySubmissionPath,
            )
        ) {
            skippedSubmittedCount += 1;
            console.log(`${progressLabel} — already submitted; skipping.`);
            continue;
        }

        const hasPendingSubmission = await fs.pathExists(pendingPath);

        if (hasPendingSubmission && !options.retryUnknown) {
            skippedUnknownCount += 1;

            console.log(
                `${progressLabel} — a prior request may have been interrupted; skipping to avoid a duplicate charge.`,
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
                `${progressLabel} — previous submission outcome is unknown; skipping to avoid a duplicate charge.`,
            );

            continue;
        }

        if (!(await fs.pathExists(audioPath))) {
            const failure: SubmissionFailure = {
                status: "missing_audio",
                recordedAt: new Date().toISOString(),
                source: {
                    id: video.id,
                    title: video.title,
                    url: video.url,
                    audioPath,
                },
                error: "Expected MP3 file was not found.",
            };

            await fs.writeJson(failurePath, failure, {
                spaces: 2,
            });

            missingAudioCount += 1;

            console.log(
                `${progressLabel} — MP3 not found; skipping.`,
            );

            continue;
        }

        const audioStats = await stat(audioPath);
        const audioSizeMegabytes = (
            audioStats.size /
            1024 /
            1024
        ).toFixed(1);

        console.log(
            `${progressLabel} — uploading ${audioSizeMegabytes} MB MP3...`,
        );

        const base64Audio = await readFile(audioPath, {
            encoding: "base64",
        });

        try {
            await waitForRateLimit(lastRequestStartedAt);

            const pendingSubmission: PendingSubmission = {
                status: "pending_submission",
                requestStartedAt: new Date().toISOString(),
                source: {
                    id: video.id,
                    title: video.title,
                    url: video.url,
                    audioPath,
                    audioSizeBytes: audioStats.size,
                },
            };

            await fs.writeJson(pendingPath, pendingSubmission, {
                spaces: 2,
            });

            lastRequestStartedAt = Date.now();

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
                        `Sofer returned an unexpected successful response: ` +
                        JSON.stringify(response.data),
                };

                await fs.writeJson(failurePath, failure, {
                    spaces: 2,
                });

                unknownFailureCount += 1;

                console.error(
                    `${video.id} returned an unexpected response from Sofer. Keeping its pending marker to avoid a duplicate submission.`,
                );
            } else {
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
                        audioSizeBytes: audioStats.size,
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
            }
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
    console.log(`Newly submitted: ${submittedCount}`);
    console.log(`Already submitted and skipped: ${skippedSubmittedCount}`);
    console.log(`Missing MP3 files: ${missingAudioCount}`);
    console.log(`Rejected by Sofer: ${rejectedCount}`);
    console.log(
        `Unknown submission outcomes skipped/recorded: ${skippedUnknownCount + unknownFailureCount}`,
    );

    if (unknownFailureCount > 0 || skippedUnknownCount > 0) {
        console.log("");
        console.log(
            "Unknown outcomes were saved as .error.json files in data/sofer/submissions.",
        );
        console.log(
            "Do not rerun those blindly: the request may have reached Sofer before the network error.",
        );
        console.log(
            "After checking with Sofer, retry them explicitly with --retry-unknown.",
        );
    }
}