import fs from "fs-extra";
import path from "node:path";

type InitOptions = {
    force?: boolean;
};

export async function initProject(
    apiKey: string,
    options: InitOptions = {},
): Promise<void> {
    const trimmedApiKey = apiKey.trim();

    if (!trimmedApiKey) {
        throw new Error("API key cannot be empty.");
    }

    const envPath = path.resolve(".env");
    const envLine = `SOFER_API_KEY=${trimmedApiKey}`;

    if (!(await fs.pathExists(envPath))) {
        await fs.writeFile(
            envPath,
            `${envLine}\n`,
            "utf-8",
        );

        console.log(`Created .env with SOFER_API_KEY.`);
        return;
    }

    const existingContents = await fs.readFile(envPath, "utf-8");

    const hasSoferApiKey = existingContents
        .split(/\r?\n/)
        .some((line) => {
            return line.trim().startsWith("SOFER_API_KEY=");
        });

    if (hasSoferApiKey && !options.force) {
        console.log(
            ".env already contains SOFER_API_KEY. Nothing was changed.",
        );
        console.log(
            "Use --force if you want to replace the existing key.",
        );
        return;
    }

    if (hasSoferApiKey && options.force) {
        const updatedContents = existingContents
            .split(/\r?\n/)
            .map((line) => {
                if (line.trim().startsWith("SOFER_API_KEY=")) {
                    return envLine;
                }

                return line;
            })
            .join("\n");

        await fs.writeFile(
            envPath,
            updatedContents.endsWith("\n")
                ? updatedContents
                : `${updatedContents}\n`,
            "utf-8",
        );

        console.log("Updated SOFER_API_KEY in .env.");
        return;
    }

    const separator = existingContents.endsWith("\n") ? "" : "\n";

    await fs.writeFile(
        envPath,
        `${existingContents}${separator}${envLine}\n`,
        "utf-8",
    );

    console.log("Added SOFER_API_KEY to existing .env.");
}