import { defineConfig } from "@playwright/test";
import chromium from "/tmp/gh-browser/node_modules/@sparticuz/chromium/build/index.js";
export default defineConfig({
  testDir: "./e2e", workers: 1, timeout: 120000, outputDir: "/tmp/gh-browser-results",
  use: { baseURL: "http://127.0.0.1:8184", launchOptions:{
    executablePath: await chromium.executablePath(), args: [...chromium.args.filter(v=>v!=="--single-process"), "--no-proxy-server", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1"]
  } },
  webServer:{command:"npx --no-install vite --host 127.0.0.1 --port 8184 --strictPort",url:"http://127.0.0.1:8184",timeout:60000}
});