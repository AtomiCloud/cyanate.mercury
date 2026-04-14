import { readFileSync, writeFileSync } from "node:fs";

let content = readFileSync("src/segments/design/phases.io.ts", "utf-8");

// 1. Remove the 3 stray const declarations from step 2c
const step2cStray = "\t\t\t\tconst darkModeWorks = false;\n\t\t\t\tconst reducedMotionRespected = false;\n\t\t\t\tconst overflowFree = false;\n\n\t\t\t\ttry {\n\t\t\t\t\t// Run build to ensure project compiles";
const step2cFixed = "\t\t\t\ttry {\n\t\t\t\t\t// Run build to ensure project compiles";
if (!content.includes(step2cStray)) {
  console.error("step2cStray not found");
  process.exit(1);
}
content = content.replace(step2cStray, step2cFixed);
console.log("Removed stray declarations from step 2c");

// 2. Add let declarations in step 6d before the outer try
const step6dOld = "\t\t\t\t\tlet server: DevServerEntry | undefined;\n\n\t\t\t\t\ttry {\n\t\t\t\t\t\t// Run build";
const step6dNew = "\t\t\t\t\tlet server: DevServerEntry | undefined;\n\t\t\t\t\tlet darkModeWorks = false;\n\t\t\t\t\tlet reducedMotionRespected = false;\n\t\t\t\t\tlet overflowFree = false;\n\n\t\t\t\t\ttry {\n\t\t\t\t\t\t// Run build";
if (!content.includes(step6dOld)) {
  console.error("step6dOld not found");
  process.exit(1);
}
content = content.replace(step6dOld, step6dNew);
console.log("Added let declarations in step 6d");

writeFileSync("src/segments/design/phases.io.ts", content);
console.log("Done");
