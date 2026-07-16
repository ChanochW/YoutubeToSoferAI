import path from "node:path";

export function getAppDirectory(): string {
    const executableName = path.basename(process.execPath).toLowerCase();

    if (executableName === "youtubetosoferai.exe") {
        return path.dirname(process.execPath);
    }

    return process.cwd();
}

export function getBundledBinaryPath(fileName: string): string {
    return path.join(
        getAppDirectory(),
        "bin",
        fileName,
    );
}