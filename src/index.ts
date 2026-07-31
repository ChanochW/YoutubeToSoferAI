import { Command } from "commander";
import { downloadVideos } from "./commands/downloadVideos";
import { transcribeLocal } from "./commands/transcribeLocal";
import { submitStandardBatch } from "./commands/submitStandardBatch";
import { checkTranscriptions } from "./commands/checkTranscriptions";
import { channelToCsv } from "./commands/channelToCsv";
import "dotenv/config";
import { initProject } from "./commands/init";

const program = new Command();

program
    .name("youtube-to-soferai")
    .description("Converts YouTube shiurim into readable documents.")
    .version("1.1.1");

type InitCommandOptions = {
    force?: boolean;
};

program
    .command("init")
    .argument("<apiKey>", "Your Sofer.ai API key")
    .option(
        "--force",
        "Overwrite an existing SOFER_API_KEY in .env instead of leaving it unchanged",
    )
    .description("Create or update the local .env file with your Sofer.ai API key")
    .action(async (
        apiKey: string,
        options: InitCommandOptions,
    ) => {
        await initProject(apiKey, {
            force: options.force,
        });
    });

program
    .command("channel-to-csv")
    .argument("<channelUrl>", "YouTube channel or channel /videos URL to scan")
    .argument(
        "<outputCsvPath>",
        "Path where the generated CSV should be saved, for example data/videos.csv",
    )
    .description(
        "Create a fresh CSV of video titles and links from a YouTube channel, ordered oldest to newest. This overwrites the target CSV.",
    )
    .action(async (channelUrl: string, outputCsvPath: string) => {
        await channelToCsv(channelUrl, outputCsvPath);
    });

type DownloadCommandOptions = {
    force?: boolean;
    forceSafe?: boolean;
};

program
    .command("download")
    .argument(
        "<csvPath>",
        "Path to the videos CSV, for example data/videos.csv",
    )
    .option(
        "--force",
        "Retry failed downloads automatically without asking. More aggressive; may keep retrying bot-detection failures.",
    )
    .option(
        "--force-safe",
        "Retry failed downloads with longer waits and stop after repeated bot-detection failures.",
    )
    .description(
        "Download each CSV video as an MP3 into downloads/audio, skipping audio files that already exist unless a retry option is used.",
    )
    .action(async (csvPath: string, options: DownloadCommandOptions) => {
        if (options.force && options.forceSafe) {
            throw new Error("Use either --force or --force-safe, not both.");
        }

        await downloadVideos(csvPath, {
            force: options.force,
            forceSafe: options.forceSafe,
        });
    });

type TranscribeLocalCommandOptions = {
    retryUnknown?: boolean;
    unchecked?: boolean;
};

program
    .command("transcribe-local")
    .argument(
        "<csvPath>",
        "Path to the videos CSV, for example data/videos.csv",
    )
    .option(
        "--retry-unknown",
        "Include clips whose previous upload may have reached Sofer but did not return a clear result. Use only after checking the prior outcome.",
    )
    .option(
        "--unchecked",
        "Skip duration and cost checking, then upload eligible MP3s directly to Sofer.",
    )
    .description(
        "Upload downloaded MP3 files from downloads/audio to Sofer one at a time. Saves submission records in data/sofer/submissions.",
    )
    .action(async (
        csvPath: string,
        options: TranscribeLocalCommandOptions,
    ) => {
        await transcribeLocal(csvPath, {
            retryUnknown: options.retryUnknown,
            skipCostCheck: options.unchecked,
        });
    });

program
    .command("check-transcriptions")
    .description(
        "Check locally saved Sofer submissions, find completed transcriptions, and download transcript files into Downloads/SoferAiTranscripts.",
    )
    .action(async () => {
        await checkTranscriptions();
    });

program
    .command("submit-standard-batch")
    .argument(
        "<csvPath>",
        "CSV containing id, title, and source url columns",
    )
    .description(
        "Create a Sofer standard batch from CSV videos by extracting direct audio links instead of uploading local MP3 files.",
    )
    .action(async (csvPath: string) => {
        await submitStandardBatch(csvPath);
    });

async function main() {
    await program.parseAsync();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});