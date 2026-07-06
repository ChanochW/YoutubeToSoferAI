import { Command } from "commander";
import { importVideos } from "./commands/importVideos";
import { downloadVideos } from "./commands/downloadVideos";
import { transcribeLocal } from "./commands/transcribeLocal";
import { submitStandardBatch } from "./commands/submitStandardBatch";
import "dotenv/config";

const program = new Command();

program
    .name("youtube-to-soferai")
    .description("Converts YouTube shiurim into readable documents.")
    .version("0.1.0");

program
    .command("import")
    .argument("<csvPath>", "Path to videos CSV")
    .description("Import a CSV of YouTube videos")
    .action(async (csvPath) => {
        await importVideos(csvPath);
    });

program
    .command("download")
    .argument("<csvPath>", "Path to videos CSV")
    .description("Download YouTube videos as audio files")
    .action(async (csvPath) => {
        await downloadVideos(csvPath);
    });

program
    .command("transcribe-local")
    .argument("<csvPath>", "Path to videos CSV")
    .description("Upload locally downloaded MP3 files to Sofer for transcription")
    .action(async (csvPath) => {
        await transcribeLocal(csvPath);
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