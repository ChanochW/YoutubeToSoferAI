import fs from "fs-extra";
import path from "node:path";
import axios from "axios";
import { parse } from "csv-parse/sync";
import { readFile } from "node:fs/promises";

type VideoRow = {
    id: string;
    title: string;
    url: string;
};

function sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}

export async function transcribeLocal(csvPath: string) {
    const apiKey = process.env.SOFER_API_KEY;

    if (!apiKey) {
        throw new Error(
            "SOFER_API_KEY is missing. Add it to your .env file in the project root.",
        );
    }

    const csv = await fs.readFile(csvPath, "utf-8");

    const records = parse(csv, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
    }) as VideoRow[];

    await fs.ensureDir("data/sofer");

    const SOFER_REQUEST_INTERVAL_MS = 13_000;

    for (let index = 0; index < records.length; index += 1) {
        const video = records[index];
        const audioPath = path.resolve(
            "downloads",
            "audio",
            `${video.id}.mp3`,
        );

        if (!await fs.pathExists(audioPath)) {
            console.log(
                `Skipping ${video.id}: MP3 not found at ${audioPath}`,
            );
            continue;
        }

        const audioStats = await fs.stat(audioPath);

        console.log(
            `Uploading ${video.id}: ${video.title} ` +
            `(${(audioStats.size / 1024 / 1024).toFixed(1)} MB MP3)`,
        );

        const base64Audio = await readFile(audioPath, {
            encoding: "base64",
        });

        console.log(
            `Base64 request payload: ${(base64Audio.length / 1024 / 1024).toFixed(1)} MB`,
        );

        let response;

        try {
            response = await axios.post<unknown>(
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
        } catch (error) {
            if (axios.isAxiosError(error)) {
                const status = error.response?.status;
                const responseData = error.response?.data;

                throw new Error(
                    `Sofer request failed for ${video.id}` +
                    `${status ? ` (${status})` : ""}: ` +
                    `${responseData ? JSON.stringify(responseData) : error.message}`,
                );
            }

            throw error;
        }

        if (typeof response.data !== "string") {
            throw new Error(
                `Sofer returned an unexpected successful response for ${video.id}: ` +
                JSON.stringify(response.data),
            );
        }

        const transcriptionId = response.data;

        await fs.writeJson(
            `data/sofer/${video.id}.json`,
            {
                videoId: video.id,
                videoTitle: video.title,
                sourceUrl: video.url,
                audioPath,
                transcriptionId,
                status: "SUBMITTED",
                submittedAt: new Date().toISOString(),
            },
            { spaces: 2 },
        );

        console.log(
            `Submitted ${video.id} — transcription ID: ${transcriptionId}`,
        );

        const isLastVideo = index === records.length - 1;

        if (!isLastVideo) {
            console.log("Waiting 13 seconds to respect Sofer's rate limit...");
            await sleep(SOFER_REQUEST_INTERVAL_MS);
        }
    }
}