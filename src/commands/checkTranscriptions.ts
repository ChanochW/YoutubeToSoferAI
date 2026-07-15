import axios from "axios";
import fs from "fs-extra";
import path from "node:path";
import { decode } from "html-entities";
import {askYesNo} from "./transcribeLocal";
import {
    Document,
    HeadingLevel,
    Packer,
    Paragraph,
    TextRun,
} from "docx";

type TranscriptionInfo = {
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

type TranscriptionStatusResponse = TranscriptionInfo;

type TranscriptionResponse = {
    text: string;
    info: TranscriptionInfo;
    timestamps: Array<{
        word: string;
        start: number;
        end: number;
        hebrew_word_format: Array<"en" | "he" | "hybrid"> | null;
        speaker: string | null;
    }>;
};

type CompletedSubmission = {
    submission: SubmissionSuccess;
    submissionPath: string;
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

function sanitizeFileName(value: string): string {
    return value
        .replace(/[<>:"/\\|?*]/g, "_")
        .replace(/\s+/g, " ")
        .trim();
}

async function getTranscription(
    transcriptionId: string,
    apiKey: string,
): Promise<TranscriptionResponse> {
    const response = await axios.get<unknown>(
        `https://api.sofer.ai/v1/transcriptions/${transcriptionId}`,
        {
            headers: {
                Authorization: `Bearer ${apiKey}`,
            },
            timeout: 300_000,
        },
    );

    return response.data as TranscriptionResponse;
}

async function createTranscriptDocx(
    outputPath: string,
    submission: SubmissionSuccess,
    transcription: TranscriptionResponse,
): Promise<void> {
    const paragraphs = createTranscriptParagraphs(
        transcription.text,
    );

    const document = new Document({
        sections: [
            {
                children: [
                    new Paragraph({
                        text: submission.source.title,
                        heading: HeadingLevel.TITLE,
                    }),

                    new Paragraph({
                        children: [
                            new TextRun({
                                text: "Source ID: ",
                                bold: true,
                            }),
                            new TextRun(submission.source.id),
                        ],
                    }),

                    new Paragraph({
                        children: [
                            new TextRun({
                                text: "Source URL: ",
                                bold: true,
                            }),
                            new TextRun(submission.source.url),
                        ],
                    }),

                    new Paragraph({
                        children: [
                            new TextRun({
                                text: "Sofer transcription ID: ",
                                bold: true,
                            }),
                            new TextRun(
                                submission.transcriptionId,
                            ),
                        ],
                    }),

                    new Paragraph({
                        children: [
                            new TextRun({
                                text: "Duration: ",
                                bold: true,
                            }),
                            new TextRun(
                                transcription.info.duration !== null
                                    ? `${transcription.info.duration} seconds`
                                    : "Unknown",
                            ),
                        ],
                    }),

                    new Paragraph({
                        children: [
                            new TextRun({
                                text: "Model: ",
                                bold: true,
                            }),
                            new TextRun(
                                transcription.info.model,
                            ),
                        ],
                        spacing: {
                            after: 300,
                        },
                    }),

                    ...paragraphs,
                ],
            },
        ],
    });

    const buffer = await Packer.toBuffer(document);

    await fs.writeFile(outputPath, buffer);
}

function createFormattedRuns(text: string): TextRun[] {
    const decodedText = decode(text);

    const runs: TextRun[] = [];
    const pattern = /<i>(.*?)<\/i>/gis;

    let currentIndex = 0;

    for (const match of decodedText.matchAll(pattern)) {
        const matchIndex = match.index;

        const normalText = decodedText.slice(
            currentIndex,
            matchIndex,
        );

        if (normalText) {
            runs.push(
                new TextRun({
                    text: normalText,
                }),
            );
        }

        const italicText = match[1];

        if (italicText) {
            runs.push(
                new TextRun({
                    text: italicText,
                    italics: true,
                }),
            );
        }

        currentIndex = matchIndex + match[0].length;
    }

    const remainingText = decodedText.slice(currentIndex);

    if (remainingText) {
        runs.push(
            new TextRun({
                text: remainingText,
            }),
        );
    }

    return runs;
}

function createTranscriptParagraphs(
    transcriptionText: string,
): Paragraph[] {
    return transcriptionText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map(
            (line) =>
                new Paragraph({
                    children: createFormattedRuns(line),
                    spacing: {
                        after: 160,
                    },
                }),
        );
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

    const completedSubmissions: CompletedSubmission[] = [];

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

            if (transcriptionStatus.status === "COMPLETED") {
                completedSubmissions.push({
                    submission: updatedSubmission,
                    submissionPath,
                });
            }

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

    if (completedSubmissions.length === 0) {
        console.log("");
        console.log("No completed transcriptions are currently available to download.");
        return;
    }

    const transcriptDirectory = path.resolve(
        "data",
        "sofer",
        "transcripts",
    );

    const downloadableSubmissions: CompletedSubmission[] = [];

    for (const completedSubmission of completedSubmissions) {
        const transcriptId = sanitizeFileName(
            completedSubmission.submission.source.id,
        );

        const markdownPath = path.join(
            transcriptDirectory,
            `${transcriptId}.md`,
        );

        const jsonPath = path.join(
            transcriptDirectory,
            `${transcriptId}.json`,
        );

        const docxPath = path.join(
            transcriptDirectory,
            `${transcriptId}.docx`,
        );

        const alreadyDownloaded =
            await fs.pathExists(markdownPath) &&
            await fs.pathExists(docxPath) &&
            await fs.pathExists(jsonPath);

        if (!alreadyDownloaded) {
            downloadableSubmissions.push(completedSubmission);
        }
    }

    console.log("");
    console.log(
        `Completed transcriptions found: ${completedSubmissions.length}`,
    );
    console.log(
        `Already downloaded: ${
            completedSubmissions.length - downloadableSubmissions.length
        }`,
    );
    console.log(
        `Available to download: ${downloadableSubmissions.length}`,
    );

    if (downloadableSubmissions.length === 0) {
        console.log("All completed transcriptions are already downloaded.");
        return;
    }

    const shouldDownload = await askYesNo(
        `Download ${downloadableSubmissions.length} completed transcription(s)?`,
    );

    if (!shouldDownload) {
        console.log("Download cancelled.");
        return;
    }

    await fs.ensureDir(transcriptDirectory);

    let downloadedCount = 0;
    let failedDownloadCount = 0;

    /*
     * Continue using the existing rate-limit timestamp so that the first
     * transcription download does not immediately follow the last status check.
     */
    for (
        let index = 0;
        index < downloadableSubmissions.length;
        index += 1
    ) {
        const completedSubmission = downloadableSubmissions[index];
        const submission = completedSubmission.submission;

        const fileName = sanitizeFileName(
            `${submission.source.id} - ${submission.source.title}`,
        );

        const markdownPath = path.join(
            transcriptDirectory,
            `${fileName}.md`,
        );

        const jsonPath = path.join(
            transcriptDirectory,
            `${fileName}.json`,
        );

        const docxPath = path.join(
            transcriptDirectory,
            `${fileName}.docx`,
        );

        console.log(
            `[${index + 1}/${downloadableSubmissions.length}] ` +
            `Downloading ${submission.source.id}: ${submission.source.title}...`,
        );

        try {
            await waitForRateLimit(lastRequestStartedAt);

            lastRequestStartedAt = Date.now();

            const transcription = await getTranscription(
                submission.transcriptionId,
                apiKey,
            );

            if (transcription.info.status !== "COMPLETED") {
                console.log(
                    `${submission.source.id} is no longer marked COMPLETED; skipping.`,
                );

                continue;
            }

            await fs.writeJson(
                jsonPath,
                transcription,
                {
                    spaces: 2,
                },
            );

            const markdownContents =
                `# ${submission.source.title}\n\n` +
                `- Source ID: ${submission.source.id}\n` +
                `- Source URL: ${submission.source.url}\n` +
                `- Sofer transcription ID: ${submission.transcriptionId}\n` +
                `- Duration: ${
                    transcription.info.duration !== null
                        ? `${transcription.info.duration} seconds`
                        : "Unknown"
                }\n` +
                `- Model: ${transcription.info.model}\n\n` +
                `---\n\n` +
                `${transcription.text.trim()}\n`;

            await fs.writeFile(
                markdownPath,
                markdownContents,
                "utf-8",
            );

            await createTranscriptDocx(
                docxPath,
                submission,
                transcription,
            );

            const updatedSubmission: SubmissionSuccess = {
                ...submission,
                latestStatus: transcription.info,
                lastStatusCheckedAt: new Date().toISOString(),
            };

            await fs.writeJson(
                completedSubmission.submissionPath,
                updatedSubmission,
                {
                    spaces: 2,
                },
            );

            downloadedCount += 1;

            console.log(
                `${submission.source.id} downloaded successfully.`,
            );
        } catch (error) {
            failedDownloadCount += 1;

            console.error(
                `${submission.source.id} download failed: ${getErrorMessage(error)}`,
            );
        }
    }

    console.log("");
    console.log("Transcript download complete.");
    console.log(`Downloaded successfully: ${downloadedCount}`);
    console.log(`Downloads that failed: ${failedDownloadCount}`);
    console.log(`Saved to: ${transcriptDirectory}`);
}