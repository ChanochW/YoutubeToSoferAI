import esbuild from "esbuild";

await esbuild.build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: "dist/app.cjs",
    packages: "bundle",
    sourcemap: false,
    minify: false,
    banner: {
        js: "#!/usr/bin/env node",
    },
});

console.log("Bundled CLI to dist/app.cjs");