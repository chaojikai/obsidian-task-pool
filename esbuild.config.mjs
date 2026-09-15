import esbuild from "esbuild";
import process from "process";
import fs from "fs";
import path from "path";

const prod = process.argv[2] === "production";
// Output directory. Point TASK_POOL_OUT at "<vault>/.obsidian/plugins/task-pool" to develop against a live vault.
const outDir = path.resolve(process.env.TASK_POOL_OUT || "dist");
fs.mkdirSync(outDir, { recursive: true });

const copyStatic = {
  name: "copy-static",
  setup(build) {
    build.onEnd(() => {
      for (const f of ["manifest.json", "styles.css"]) fs.copyFileSync(f, path.join(outDir, f));
    });
  },
};

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/state", "@codemirror/view", "@codemirror/language", "@lezer/common"],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: path.join(outDir, "main.js"),
  plugins: [copyStatic],
});

if (prod) { await ctx.rebuild(); process.exit(0); } else { await ctx.watch(); }
