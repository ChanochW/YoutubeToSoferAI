import fs from "fs-extra";
import {parse} from "csv-parse/sync";

type VideoRow = {
    id: string;
    title: string;
    url: string;
};

export async function importVideos(csvPath: string) {
    const csv = await fs.readFile(csvPath, "utf-8");

    const records = parse(csv, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
    }) as VideoRow[];

    await fs.ensureDir("transcripts/raw");

    for (const video of records) {
        const fileName = `${video.id}.md`;
        const filePath = `transcripts/raw/${fileName}`;

        const content = `# ${video.title}
                        
                        Video ID: ${video.id}  
                        URL: ${video.url}
                        
                        ## Raw Transcript
                        
                        TODO: Add transcript here.`;

        await fs.writeFile(filePath, content, "utf-8");
        console.log(`Created ${filePath}`);
    }
}