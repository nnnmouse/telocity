import { build } from "esbuild";
import fs from "node:fs";

const VENDOR_CONFIG = [
  { name: "undici", format: "cjs" },
  { name: "glob", format: "esm" },
  { name: "fast-string-width", format: "esm" },
] as const;

async function vendorAll() {
  console.log("Starting vendoring...\n");

  for (const { name, format } of VENDOR_CONFIG) {
    const isEsm = format === "esm";
    const extension = isEsm ? "js" : "cjs";
    const outDir = `src/libs/vendoring/tp/${name}`;
    const outFile = `${outDir}/index.${extension}`;
    const dtsFile = `${outDir}/index.d.ts`;

    console.log(`Bundling ${name} as ${format.toUpperCase()}...`);

    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }

    await build({
      entryPoints: [name],
      bundle: true,
      platform: "node",
      target: "node26",
      format: format,
      //minify: true,
      //make ts shut up on non-minified
      //(transpiles #private fields)
      supported: {
        "class-field": false,
      },
      outfile: outFile,
      banner: isEsm
        ? {
            js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
          }
        : undefined,
    });

    let dtsContent = `export * from "${name}";\n`;

    if (name === "fast-string-width" || name === "undici") {
      dtsContent += `export { default } from "${name}";\n`;
    }

    fs.writeFileSync(dtsFile, dtsContent);
    console.log(`Saved: ${outFile}`);
  }

  console.log("\nVendoring complete!");
}

vendorAll().catch((err) => {
  console.error("Vendoring failed:", err);
  process.exit(1);
});
