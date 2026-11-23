// Bundle the browser code into ../public/app.js (committed, so Render needs
// no extra build step). Re-run `npm run build` here after editing src/.
import { build } from "esbuild";
await build({
  entryPoints: ["src/main.js"],
  bundle: true,
  minify: true,
  format: "esm",
  target: "es2020",
  outfile: "../public/app.js",
});
console.log("built ../public/app.js");
