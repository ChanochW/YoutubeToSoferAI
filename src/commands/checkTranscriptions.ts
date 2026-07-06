import axios from "axios";
import fs from "fs-extra";
import path from "node:path";

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
    latestStatus?: TranscriptionStatusResponse;
    lastStatusCheckedAt?: string;
};

type TranscriptionStatus =
    | "RECEIVED"
    | "PENDING"
    | "PROCESSING"
    | "COMPLETED"
    | "CANCELLED"
    | "FAILED"
    | "UPLOADED"
    | "INSUFFICIENT_FUNDS";

type TranscriptionStatusResponse = {
    id: string;
    title: string;
    created_at: string;
    primary_language: "en" | "he" | "yi" | "fr";
    hebrew_word_format: Array<"en" | "he" | "hybrid">;
    status: TranscriptionStatus;
    client_item_id: string | null;
    num_speakers: number | null;
    duration: number | null;
    model: string;
};

const MIN_REQUEST_SPACING_MS = 13_000;

function sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
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
            `Waiting ${Math.ceil(waitMilliseconds / 1000)} seconds before the next status request...`,
        );

        await sleep(waitMilliseconds);
    }
}

function isSubmissionSuccess(
    value: unknown,
): value is SubmissionSuccess {
    if (!value || typeof value !== "object") {
        return false;
    }

    const record = value as Record<string, unknown>;

    return (
        record.status === "submitted" &&
        typeof record.transcriptionId === "string"
    );
}

function getErrorMessage(error: unknown): string {
    if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const responseData = error.response?.data;

        const details =
            typeof responseData === "string"
                ? responseData
                : responseData !== undefined && responseData !== null
                    ? JSON.stringify(responseData, null, 2)
                    : error.message;

        return `${status ? `HTTP ${status}: ` : ""}${details}`;
    }

    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

export async function checkTranscriptions(): Promise<void> {
    const apiKey = process.env.SOFER_API_KEY;

    if (!apiKey) {
        throw new Error(
            "SOFER_API_KEY is missing. Add it to your .env file.",
        );
    }

    const submissionDirectory = path.resolve(
        "data",
        "sofer",
        "submissions",
    );

    if (!(await fs.pathExists(submissionDirectory))) {
        throw new Error(
            `No submission directory found at ${submissionDirectory}.`,
        );
    }

    const fileNames = await fs.readdir(submissionDirectory);

    const submissionFiles = fileNames.filter(
        (fileName) =>
            fileName.endsWith(".json") &&
            !fileName.endsWith(".error.json") &&
            !fileName.endsWith(".pending.json"),
    );

    if (submissionFiles.length === 0) {
        console.log("No successful transcription submissions were found.");
        return;
    }

    let checkedCount = 0;
    let failedChecks = 0;
    let lastRequestStartedAt = 0;

    const statusCounts = new Map<string, number>();

    console.log(
        `Checking ${submissionFiles.length} saved transcription(s)...`,
    );

    for (let index = 0; index < submissionFiles.length; index += 1) {
        const fileName = submissionFiles[index];
        const submissionPath = path.join(
            submissionDirectory,
            fileName,
        );

        const savedData = await fs.readJson(submissionPath);

        if (!isSubmissionSuccess(savedData)) {
            console.log(
                `[${index + 1}/${submissionFiles.length}] ${fileName} — skipped because it is not a valid submission record.`,
            );
            continue;
        }

        const submission = savedData;

        try {
            await waitForRateLimit(lastRequestStartedAt);

            lastRequestStartedAt = Date.now();

            const response = await axios.get<unknown>(
                `https://api.sofer.ai/v1/transcriptions/${submission.transcriptionId}/status`,
                {
                    headers: {
                        Authorization: `Bearer ${apiKey}`,
                    },
                    timeout: 300_000,
                },
            );

            const transcriptionStatus =
                response.data as TranscriptionStatusResponse;

            const updatedSubmission: SubmissionSuccess = {
                ...submission,
                latestStatus: transcriptionStatus,
                lastStatusCheckedAt: new Date().toISOString(),
            };

            await fs.writeJson(
                submissionPath,
                updatedSubmission,
                {
                    spaces: 2,
                },
            );

            checkedCount += 1;

            statusCounts.set(
                transcriptionStatus.status,
                (statusCounts.get(transcriptionStatus.status) ?? 0) + 1,
            );

            console.log(
                `[${index + 1}/${submissionFiles.length}] ` +
                `${submission.source.id}: ${submission.source.title} — ` +
                `${transcriptionStatus.status}`,
            );
        } catch (error) {
            failedChecks += 1;

            console.error(
                `[${index + 1}/${submissionFiles.length}] ` +
                `${submission.source.id}: ${submission.source.title} — ` +
                `status check failed: ${getErrorMessage(error)}`,
            );
        }
    }

    console.log("");
    console.log("Status check complete.");
    console.log(`Checked successfully: ${checkedCount}`);
    console.log(`Status checks that failed: ${failedChecks}`);

    for (const [status, count] of statusCounts) {
        console.log(`${status}: ${count}`);
    }
}