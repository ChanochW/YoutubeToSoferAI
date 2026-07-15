import fs from "fs-extra";
import path from "node:path";
import youtubedl from "youtube-dl-exec";

type YoutubeFlatEntry = {
    id?: string;
    title?: string;
    url?: string;
    webpage_url?: string;
};

type YoutubePlaylistResponse = {
    entries?: YoutubeFlatEntry[];
};

function csvEscape(value: string): string {
    if (
        value.includes(",") ||
        value.includes("\"") ||
        value.includes("\n") ||
        value.includes("\r")
    ) {
        return `"${value.replaceAll("\"", "\"\"")}"`;
    }

    return value;
}

function normalizeYoutubeVideoUrl(entry: YoutubeFlatEntry): string | undefined {
    if (entry.webpage_url) {
        return entry.webpage_url;
    }

    if (entry.url?.startsWith("http")) {
        return entry.url;
    }

    if (entry.id) {
        return `https://www.youtube.com/watch?v=${entry.id}`;
    }

    return undefined;
}

function createSafeCsvId(index: number): string {
    return String(index + 1).padStart(3, "0");
}

export async function channelToCsv(
    channelUrl: string,
    outputCsvPath: string,
): Promise<void> {
    console.log(`Reading YouTube channel: ${channelUrl}`);
    console.log("Fetching video list without downloading videos...");

    const result = await youtubedl(channelUrl, {
        dumpSingleJson: true,
        flatPlaylist: true,
        skipDownload: true,
        noWarnings: true,
        ignoreErrors: true,
    }) as YoutubePlaylistResponse;

    const entries = result.entries ?? [];

    if (entries.length === 0) {
        throw new Error(
            "No videos were found. Try using the channel's /videos URL instead.",
        );
    }

    const usableEntries = entries
        .map((entry) => {
            const title = entry.title?.trim();
            const url = normalizeYoutubeVideoUrl(entry);

            if (!title || !url) {
                return undefined;
            }

            return {
                title,
                url,
            };
        })
        .filter(
            (
                row,
            ): row is {
                title: string;
                url: string;
            } => row !== undefined,
        )
        .reverse();

    const rows = usableEntries.map((entry, index) => {
        return {
            id: createSafeCsvId(index),
            title: entry.title,
            url: entry.url,
        };
    });

    if (rows.length === 0) {
        throw new Error(
            "Videos were found, but none had both a title and a usable URL.",
        );
    }

    const csvLines = [
        "id,title,url",
        ...rows.map((row) =>
            [
                csvEscape(row.id),
                csvEscape(row.title),
                csvEscape(row.url),
            ].join(","),
        ),
    ];

    const resolvedOutputPath = path.resolve(outputCsvPath);

    await fs.ensureDir(path.dirname(resolvedOutputPath));

    await fs.writeFile(
        resolvedOutputPath,
        `${csvLines.join("\n")}\n`,
        "utf-8",
    );

    console.log("");
    console.log(`CSV created: ${resolvedOutputPath}`);
    console.log(`Videos written: ${rows.length}`);
}