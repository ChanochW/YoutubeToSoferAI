import axios from "axios";
import {parse} from "csv-parse/sync";
import fs from "fs-extra";
import path from "node:path";

type VideoRow = {
    id: string;
    title: string;
    url: string;
};

type LinkExtractResponse = {
    title: string;
    download_url: string;
    file_format: string;
    file_name: string;
};

type ManifestItem = {
    audio_url: string;
    title: string;
    client_item_id: string;
};

type ManifestUploadResponse = {
    batch_file_id: string;
    item_count: number;
    size_bytes: number;
    created_at: string;
    status: "PENDING_VALIDATION" | "VALID" | "INVALID";
    checksum: string;
    validation_errors?: string[];
};

type CreateBatchResponse = {
    batch_id: string;
    transcription_ids: string[];
    total_count: number;
    status: "RECEIVED" | "PROCESSING" | "COMPLETED" | "FAILED";
};

type BatchFileResponse = {
    id: string;
    created_at: string;
    item_count: number;
    size_bytes: number;
    status: "PENDING_VALIDATION" | "VALID" | "INVALID";
    checksum: string;
    title?: string;
    description?: string;
    validation_errors?: string[];
};

function createFileTimestamp(): string {
    return new Date()
        .toISOString()
        .replaceAll(":", "-")
        .replaceAll(".", "-");
}

function getSoferHeaders(apiKey: string) {
    return {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
    };
}

function getAxiosErrorMessage(error: unknown): string {
    if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const responseData = error.response?.data;

        let details = error.message;

        if (typeof responseData === "string" && responseData.trim()) {
            details = responseData;
        } else if (responseData !== undefined) {
            details = JSON.stringify(responseData, null, 2);
        }

        return [
            status ? `HTTP ${status}` : "No HTTP response",
            details,
        ].join(": ");
    }

    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

function validateRows(records: VideoRow[]): void {
    if (records.length === 0) {
        throw new Error("The CSV contains no video rows.");
    }

    if (records.length > 500) {
        throw new Error(
            `Standard batches allow at most 500 files. This CSV has ${records.length}.`,
        );
    }

    const usedIds = new Set<string>();

    for (const video of records) {
        if (!video.id || !video.title || !video.url) {
            throw new Error(
                "Every CSV row must contain id, title, and url.",
            );
        }

        if (usedIds.has(video.id)) {
            throw new Error(
                `Duplicate id found in CSV: ${video.id}. Every id must be unique.`,
            );
        }

        usedIds.add(video.id);
    }
}

async function extractDownloadLink(
    sourceUrl: string,
    apiKey: string,
): Promise<LinkExtractResponse> {
    const normalizedUrl = normalizeSourceUrl(sourceUrl);

    const response = await axios.post<unknown>(
        "https://api.sofer.ai/v1/link/extract",
        {
            url: normalizedUrl,
        },
        {
            headers: getSoferHeaders(apiKey),
            timeout: 300_000,
        },
    );

    return response.data as LinkExtractResponse;
}

function sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}

async function getBatchFile(
    batchFileId: string,
    apiKey: string,
): Promise<BatchFileResponse> {
    const response = await axios.get<unknown>(
        `https://api.sofer.ai/v1/transcriptions/batch-files/${batchFileId}`,
        {
            headers: getSoferHeaders(apiKey),
            timeout: 300_000,
        },
    );

    return response.data as BatchFileResponse;
}

async function waitForManifestValidation(
    batchFileId: string,
    apiKey: string,
): Promise<BatchFileResponse> {
    const pollDelayMilliseconds = 3_000;
    const maxPollAttempts = 60;

    for (let attempt = 1; attempt <= maxPollAttempts; attempt += 1) {
        const batchFile = await getBatchFile(batchFileId, apiKey);

        console.log(
            `Manifest validation check ${attempt}/${maxPollAttempts}: ${batchFile.status}`,
        );

        if (
            batchFile.status === "VALID" ||
            batchFile.status === "INVALID"
        ) {
            return batchFile;
        }

        await sleep(pollDelayMilliseconds);
    }

    throw new Error(
        `Manifest ${batchFileId} was still PENDING_VALIDATION after ` +
        `${maxPollAttempts * pollDelayMilliseconds / 1000} seconds.`,
    );
}

function normalizeSourceUrl(sourceUrl: string): string {
    try {
        const url = new URL(sourceUrl);

        const isYouTube =
            url.hostname === "youtube.com" ||
            url.hostname === "www.youtube.com" ||
            url.hostname === "m.youtube.com";

        if (isYouTube && url.pathname === "/watch") {
            const videoId = url.searchParams.get("v");

            if (videoId) {
                return `https://www.youtube.com/watch?v=${videoId}`;
            }
        }

        if (url.hostname === "youtu.be") {
            const videoId = url.pathname.slice(1);

            if (videoId) {
                return `https://www.youtube.com/watch?v=${videoId}`;
            }
        }

        return sourceUrl;
    } catch {
        return sourceUrl;
    }
}

export async function submitStandardBatch(csvPath: string): Promise<void> {
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

    const timestamp = createFileTimestamp();

    const runDirectory = path.resolve(
        "data",
        "sofer",
        "batches",
        timestamp,
    );

    await fs.ensureDir(runDirectory);

    const sourceCsvCopyPath = path.join(runDirectory, "source-videos.csv");
    const extractedLinksPath = path.join(runDirectory, "extracted-links.json");
    const manifestPath = path.join(runDirectory, "manifest.json");
    const manifestResponsePath = path.join(
        runDirectory,
        "manifest-response.json",
    );
    const batchResponsePath = path.join(runDirectory, "batch-response.json");

    await fs.copy(csvPath, sourceCsvCopyPath);

    console.log(
        `Extracting direct download links for ${records.length} video(s)...`,
    );

    const manifestItems: ManifestItem[] = [];
    const extractedLinks: Array<{
        id: string;
        source_url: string;
        source_title: string;
        extracted: LinkExtractResponse;
    }> = [];

    for (let index = 0; index < records.length; index += 1) {
        const video = records[index];

        console.log(
            `[${index + 1}/${records.length}] Extracting ${video.id}: ${video.title}`,
        );

        try {
            const extracted = await extractDownloadLink(video.url, apiKey);

            extractedLinks.push({
                id: video.id,
                source_url: video.url,
                source_title: video.title,
                extracted,
            });

            manifestItems.push({
                audio_url: extracted.download_url,
                title: video.title || extracted.title,
                client_item_id: video.id,
            });
        } catch (error) {
            await fs.writeJson(
                extractedLinksPath,
                extractedLinks,
                { spaces: 2 },
            );

            throw new Error(
                `Could not extract a direct download link for ${video.id}: ${video.title}\n` +
                `Source URL: ${video.url}\n` +
                `${getAxiosErrorMessage(error)}\n\n` +
                `Partial extraction results were saved to:\n${extractedLinksPath}`,
            );
        }
    }

    await fs.writeJson(extractedLinksPath, extractedLinks, {
        spaces: 2,
    });

    await fs.writeJson(manifestPath, manifestItems, {
        spaces: 2,
    });

    console.log(
        `Uploading standard batch manifest with ${manifestItems.length} item(s)...`,
    );

    let manifest: ManifestUploadResponse;

    try {
        const response = await axios.post<unknown>(
            "https://api.sofer.ai/v1/transcriptions/batch-files",
            {
                content_type: "json",
                json_items: manifestItems,
                metadata: {
                    title: `YouTubeToSoferAI batch ${timestamp}`,
                    description: `Created from ${path.basename(csvPath)}`,
                },
            },
            {
                headers: getSoferHeaders(apiKey),
                timeout: 300_000,
            },
        );

        manifest = response.data as ManifestUploadResponse;
    } catch (error) {
        throw new Error(
            `Could not upload the batch manifest.\n${getAxiosErrorMessage(error)}`,
        );
    }

    await fs.writeJson(manifestResponsePath, manifest, {
        spaces: 2,
    });

    console.log(
        `Manifest uploaded: ${manifest.item_count} item(s), initial status: ${manifest.status}`,
    );

    let validatedManifest: BatchFileResponse;

    try {
        if (manifest.status === "VALID") {
            validatedManifest = {
                id: manifest.batch_file_id,
                created_at: manifest.created_at,
                item_count: manifest.item_count,
                size_bytes: manifest.size_bytes,
                status: manifest.status,
                checksum: manifest.checksum,
                validation_errors: manifest.validation_errors,
            };
        } else if (manifest.status === "INVALID") {
            validatedManifest = {
                id: manifest.batch_file_id,
                created_at: manifest.created_at,
                item_count: manifest.item_count,
                size_bytes: manifest.size_bytes,
                status: manifest.status,
                checksum: manifest.checksum,
                validation_errors: manifest.validation_errors,
            };
        } else {
            console.log("Waiting for manifest validation...");

            validatedManifest = await waitForManifestValidation(
                manifest.batch_file_id,
                apiKey,
            );
        }
    } catch (error) {
        throw new Error(
            `Could not confirm manifest validation status.\n` +
            `${getAxiosErrorMessage(error)}\n\n` +
            `Manifest details were saved to:\n${manifestResponsePath}`,
        );
    }

    await fs.writeJson(
        manifestResponsePath,
        {
            upload_response: manifest,
            latest_validation_response: validatedManifest,
            last_checked_at: new Date().toISOString(),
        },
        {
            spaces: 2,
        },
    );

    if (validatedManifest.status === "INVALID") {
        const validationErrors =
            validatedManifest.validation_errors?.join("\n- ") ??
            "Unknown validation error.";

        throw new Error(
            `Sofer rejected the manifest:\n- ${validationErrors}\n\n` +
            `Manifest details were saved to:\n${manifestResponsePath}`,
        );
    }

    if (validatedManifest.status !== "VALID") {
        throw new Error(
            `Manifest validation did not finish successfully. Current status: ${validatedManifest.status}`,
        );
    }

    console.log("Manifest is valid. Creating standard transcription batch...");

    let batch: CreateBatchResponse;

    try {
        const response = await axios.post<unknown>(
            "https://api.sofer.ai/v1/transcriptions/batch",
            {
                processing_mode: "standard",
                batch_file_id: manifest.batch_file_id,
                batch_title: `YouTubeToSoferAI batch ${timestamp}`,
                info: {
                    model: "v1",
                    primary_language: "en",
                    hebrew_word_format: ["en", "he"],
                    num_speakers: 1,
                },
            },
            {
                headers: getSoferHeaders(apiKey),
                timeout: 300_000,
            },
        );

        batch = response.data as CreateBatchResponse;
    } catch (error) {
        throw new Error(
            `Manifest was uploaded successfully, but batch creation failed.\n` +
            `${getAxiosErrorMessage(error)}\n\n` +
            `The batch_file_id is: ${manifest.batch_file_id}\n` +
            `Manifest details were saved to:\n${manifestResponsePath}`,
        );
    }

    await fs.writeJson(batchResponsePath, {
        source_csv: path.resolve(csvPath),
        created_at: new Date().toISOString(),
        manifest_file: manifestPath,
        extracted_links_file: extractedLinksPath,
        sofer_manifest_upload: manifest,
        sofer_manifest_validation: validatedManifest,
        sofer_batch: batch,
    }, {
        spaces: 2,
    });

    console.log("");
    console.log("Standard batch submitted successfully.");
    console.log(`Batch ID: ${batch.batch_id}`);
    console.log(`Transcriptions created: ${batch.total_count}`);
    console.log(`Initial status: ${batch.status}`);
    console.log(`Saved batch details to:\n${batchResponsePath}`);
}