import { Command } from "commander";
import { downloadVideos } from "./commands/downloadVideos";
import { transcribeLocal } from "./commands/transcribeLocal";
import { submitStandardBatch } from "./commands/submitStandardBatch";
import {checkTranscriptions} from "./commands/checkTranscriptions";
import {channelToCsv} from "./commands/channelToCsv";
import "dotenv/config";
import {initProject} from "./commands/init";
import { ensureLocalBinaries } from "./lib/ensureLocalBinaries";

const program = new Command();

program
    .name("youtube-to-soferai")
    .description("Converts YouTube shiurim into readable documents.")
    .version("1.0.0");

type InitCommandOptions = {
    force?: boolean;
};

program
    .command("prepare-binaries")
    .description("Copy helper binaries into the local bin folder")
    .action(async () => {
        const binDirectory = await ensureLocalBinaries();

        console.log(`Prepared helper binaries in ${binDirectory}`);
    });

program
    .command("init")
    .argument("<apiKey>", "Your Sofer.ai API key")
    .option(
        "--force",
        "Replace the existing SOFER_API_KEY in .env if one already exists",
    )
    .description(
        "Create or update the .env file with your Sofer.ai API key",
    )
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
    .argument("<channelUrl>", "YouTube channel URL")
    .argument("<outputCsvPath>", "Where to save the generated CSV")
    .description(
        "Create a CSV of video titles and links from a YouTube channel (oldest to newest)",
    )
    .action(async (channelUrl, outputCsvPath) => {
        await channelToCsv(channelUrl, outputCsvPath);
    });

program
    .command("download")
    .argument("<csvPath>", "Path to videos CSV")
    .description("Download YouTube videos as audio files")
    .action(async (csvPath) => {
        await downloadVideos(csvPath);
    });

type TranscribeLocalCommandOptions = {
    retryUnknown?: boolean;
    unchecked?: boolean;
};

program
    .command("transcribe-local")
    .argument("<csvPath>", "Path to the videos CSV")
    .option(
        "--retry-unknown",
        "Retry clips whose earlier upload outcome was unknown",
    )
    .option(
        "--unchecked",
        "Skip duration/cost checking and upload eligible MP3s directly",
    )
    .description(
        "Upload downloaded MP3 files to Sofer one at a time",
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
        "Check the status of every locally saved Sofer transcription",
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
        "Extract direct audio links through Sofer and create a standard batch",
    )
    .action(async (csvPath) => {
        await submitStandardBatch(csvPath);
    });

async function main() {
    await program.parseAsync();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});